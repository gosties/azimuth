"""Command-line controls for source registration, ingestion and maintenance."""

from argparse import ArgumentParser, ArgumentTypeError, RawDescriptionHelpFormatter
from dataclasses import replace
from getpass import getpass
from logging.handlers import RotatingFileHandler
import json
import logging
import os
from pathlib import Path
import sys
from time import monotonic, sleep
from urllib.parse import urlsplit
from uuid import UUID

from h3search.auth import AccountError, Accounts, PASSWORD_MAX
from h3search.config import load_settings
from h3search.control import ConflictError, Registry

from .configured import register_configured
from .engine import Engine, maintenance_window
from .single_file import SingleFileError, build_single_file
from .source import CapturePending, ReloadRequired


log = logging.getLogger("h3search.etl")


def _uuid(value):
    return str(UUID(value))


def _positive_int(value):
    try:
        result = int(value)
    except ValueError:
        raise ArgumentTypeError("must be a positive integer") from None
    if result < 1:
        raise ArgumentTypeError("must be a positive integer")
    return result


def _stop_path(value):
    path = Path(value)
    if not value.strip() or path.is_dir():
        raise ArgumentTypeError("must name a file path")
    return path


def _password_arguments(parser):
    options = parser.add_mutually_exclusive_group()
    options.add_argument("--password-env", metavar="NAME", help="Read the password from this environment variable.")
    options.add_argument("--password-stdin", action="store_true", help="Read one password line from standard input.")


def _parser():
    parser = ArgumentParser(description="Register SQL Server datasets and publish searchable Iceberg snapshots.")
    parser.add_argument("--config", type=Path, help="TOML settings file. Defaults to H3SEARCH_CONFIG when set.")
    parser.add_argument("--debug", action="store_true", help="Record bounded work-unit progress at DEBUG level.")
    sub = parser.add_subparsers(dest="command", required=True)
    register = sub.add_parser("register", help="Register a source table without connecting to SQL Server.")
    for name, help_text in (
        ("name", "Display name used by the search interface."),
        ("connection-name", "Configured SQL Server connection name."),
        ("source-schema", "Exact source schema identifier."),
        ("source-table", "Exact source table identifier."),
        ("object-id-column", "Nonnullable integer source key with a single-column unique index."),
    ):
        register.add_argument(f"--{name}", required=True, help=help_text)
    register.add_argument("--description", default="", help="Description displayed with the dataset.")
    register.add_argument("--mode", choices=("insert", "cdc"), default="insert",
                          help="Insert-only key checkpoints or full SQL Server CDC changes.")
    register.add_argument("--capture-instance", help="Existing capture instance tracking all columns. Required for CDC.")
    register.add_argument("--latitude-column", help="Latitude column in EPSG:4326.")
    register.add_argument("--longitude-column", help="Longitude column in EPSG:4326.")
    register.add_argument("--geometry-column", help="SQL Server spatial column containing EPSG:4326 points or areas.")
    register.add_argument("--source-srid", type=int, default=4326, help="EPSG code for source positions. Supported value is 4326.")
    sub.add_parser("register-configured", help="Register the source tables declared in the TOML configuration.")
    sub.add_parser("list", help="List registered datasets and their published searchable counts.")
    for command, help_text in (
        ("describe", "Show the registered source metadata and published searchable count."),
        ("run", "Resume pending work or load one fixed SQL Server source interval."),
        ("remove", "Invalidate affected searches and reclaim the registered dataset's stored data."),
        ("import-parquet", "Publish an explicit sorted Parquet fixture through the configured lake."),
    ):
        item = sub.add_parser(command, help=help_text, description=help_text)
        item.add_argument("table_id", type=_uuid, help="Immutable UUID printed by register or list.")
        if command == "import-parquet":
            item.add_argument("path", type=Path, help="Immutable input Parquet file sorted by increasing OBJECTID.")
        elif command == "run":
            item.add_argument("--max-batches", type=_positive_int, metavar="N",
                              help="Pause after N durable batches in this invocation, including any recovered batch.")
            item.add_argument("--stop-file", type=_stop_path, metavar="PATH",
                              help="Pause at the next safe boundary when this file exists.")
            item.formatter_class = RawDescriptionHelpFormatter
            item.epilog = (
                "A paused run returns JSON with status 'paused', the dataset UUID, cursors,\n"
                "and batches applied in this invocation. Rows and total_batches describe\n"
                "the full pending interval. The pending journal records a fixed source\n"
                "interval and progress through it. A staged batch is recovered first using\n"
                "the same batch ID so a retry cannot duplicate writes. The published\n"
                "snapshot and source checkpoint advance only when the interval completes.\n"
                "With initial_search_grouping enabled, a first live load stages narrow rows\n"
                "and writes grouped search batches before publication. These batches also\n"
                "count toward --max-batches. Keep the staging directory until completion.\n"
                "\n"
                "Resume with the same dataset UUID after removing the stop file. Restarting\n"
                "the command rereads resource settings such as batch size and worker count.\n"
                "Pause controls apply only to this invocation. An active watch can resume\n"
                "pending work, so stop it before using bounded runs for tuning."
            )
    sub.add_parser("maintain", help="Compact files and reclaim eligible data within the configured window and time budget.")
    for command, description in (
        ("bulk-prepare", "Prepare a fresh insert-only dataset without holding the lake writer lease."),
        ("bulk-activate", "Publish a complete prepared dataset, or recover its pending activation."),
        ("bulk-status", "Show the durable progress of a prepared initial load."),
        ("bulk-discard", "Discard a preparation that has not begun admission and release its reservation."),
    ):
        item = sub.add_parser(command, help=description, description=description)
        item.add_argument("table_id", type=_uuid, help="Immutable registered dataset UUID.")
        if command == "bulk-prepare":
            item.add_argument("--max-batches", type=_positive_int, help="Pause after this many sealed source batches.")
            item.add_argument("--stop-file", type=_stop_path, help="Pause at a durable boundary when this file exists.")
            for option, destination, text in (
                ("memory-mb", "bulk_memory_mb", "Process RSS budget in MiB."),
                ("stage-quota-mb", "bulk_stage_quota_mb", "Total staging and spill quota in MiB."),
                ("host-reserve-mb", "bulk_host_reserve_mb", "Minimum available host memory in MiB."),
                ("disk-reserve-mb", "bulk_disk_reserve_mb", "Minimum free staging disk space in MiB."),
                ("max-open-writers", "prepared_max_open_writers", "Maximum simultaneously open prepared file writers."),
                ("carry-mb", "prepared_carry_mb", "Aggregate decoded row-group carry budget in MiB."),
                ("read-batch-rows", "prepared_read_batch_rows", "Maximum prepared-reader batch rows."),
                ("read-row-groups", "prepared_read_row_groups", "Maximum row groups per prepared-reader iterator, from one to 128."),
                ("upload-workers", "bulk_upload_workers", "Concurrent immutable uploads, from one to four."),
                ("inventory-interval-sec", "prepared_inventory_interval_sec", "Interval between recursive staging quota samples."),
            ):
                item.add_argument("--" + option, dest=destination, type=_positive_int, help=text)
            item.epilog = ("Keep the staging directory until activation completes. Stop-file, batch limits and interruption leave "
                           "a resumable reservation; other datasets can continue ingestion. Resume with the same dataset UUID, "
                           "bulk_owner_id and stage_path. Source schema and physical layout must remain unchanged. "
                           "Use bulk-discard before admission to release a cancelled preparation, or bulk-activate to recover "
                           "an admission that has already started. All ingestion and maintenance processes sharing the catalog "
                           "must support bulk reservations while preparations exist. Resource limits can also be set in the TOML configuration.")
    optimize = sub.add_parser(
        "optimize-search", help="Regroup published Iceberg search manifests without rewriting data files.",
        description="Regroup and publish Iceberg search metadata without reading SQL Server or rewriting data files. "
                    "Resolve pending ETL work first. Configure limits with manifest_regroup_budget_sec, "
                    "manifest_regroup_max_files, manifest_regroup_max_entries, and memory_budget_mb.",
    )
    optimize.add_argument("--stop-file", type=_stop_path, metavar="PATH",
                          help="Stop at the next safe boundary if this file exists. Remove it and retry to publish a committed regroup.")
    sub.add_parser(
        "build-single-file", help="Reload and verify a one-file alternative for all published SQL Server datasets.",
        description="Reload every published SQL Server dataset, compare all lookup rows with the current publication, "
                    "and publish one Parquet file ordered by H3 resolution 15, dataset UUID, and OBJECTID.",
    )
    load = sub.add_parser("load", help="Build and publish the selected lookup layout and slim wide tables.")
    load.add_argument("--lookup", choices=("r3", "single-file", "both"), required=True)
    load.add_argument("--max-batches", type=_positive_int, help="Pause after this many staged batches.")
    load.add_argument("--stop-file", type=_stop_path, help="Pause at a durable boundary if this file exists.")
    load.add_argument("--initial-only", action="store_true", help="Publish only cold base scans; defer CDC catch-up until the next increment.")
    load.add_argument("--source-frozen", action="store_true", help="Confirm source rows remain unchanged throughout the initial-only load.")
    load.add_argument("--output-read-plan", type=Path,
                      help="Import original per-dataset read windows for a matching frozen generation lacking encoding receipts.")
    sub.add_parser("discard-load", help="Cancel and reclaim a pending unpublished load from its original staging owner.")
    sub.add_parser("watch", help="Poll SQL Server at the configured interval, defaulting to ten minutes.")
    bootstrap = sub.add_parser("bootstrap-superadmin", help="Create the first superadmin in control storage.")
    bootstrap.add_argument("--email", required=True, help="Email address of the first superadmin.")
    _password_arguments(bootstrap)
    search = sub.add_parser("search", help="Run a radius search through the HTTP API and return the first page.")
    search.add_argument("--api-url", required=True, help="Root HTTP(S) URL of the search service.")
    search.add_argument("--email", required=True, help="Email address of the search account.")
    _password_arguments(search)
    search.add_argument("--latitude", required=True, type=float, help="Center latitude in decimal degrees.")
    search.add_argument("--longitude", required=True, type=float, help="Center longitude in decimal degrees.")
    search.add_argument("--radius-m", required=True, type=float, help="Search radius in meters.")
    search.add_argument("--dataset-id", action="append", type=_uuid,
                        help="Include this dataset UUID. Repeat to limit a search to several datasets.")
    return parser


def _configure_logging(settings, debug):
    settings.log_path.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(
        settings.log_path / "etl.log", maxBytes=settings.log_max_mb * 1024 * 1024,
        backupCount=settings.log_backups, encoding="utf-8",
    )
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    log.handlers.clear()
    log.addHandler(handler)
    log.setLevel(logging.DEBUG if debug else settings.log_level)
    log.propagate = False


def _safe_failure(error):
    if isinstance(error, (AccountError, CapturePending, ConflictError, ReloadRequired, SingleFileError, MemoryError, TimeoutError)):
        return str(error)
    if isinstance(error, KeyError):
        return "No dataset with that ID is registered."
    if isinstance(error, FileNotFoundError):
        return "The supplied input file or directory does not exist."
    if isinstance(error, ValueError) and type(error).__module__ == "builtins":
        # Connection and storage clients can include credentials in diagnostics.
        message = str(error)
        if message.startswith((
            "The source ", "The OBJECTID ", "A configured source ", "The configured geometry ",
            "The configured CDC ", "SQL Server CDC ", "CDC ", "Unsupported SQL Server ",
            "Parquet rows ", "Parquet import ", "A source row ", "A Parquet row ",
            "Source coordinates ", "Local mode ", "Set the configured ", "The SQL Server ",
            "The configured SQL Server ", "Unknown configuration ",
            "Live ingestion ", "postgres_dsn ", "Specify coordinate ", "This source ", "The search service URL ",
        )):
            return message
    if type(error) is RuntimeError and str(error).startswith("Search service returned HTTP "):
        return str(error)
    if type(error) in (RuntimeError, OSError) and str(error).startswith(("Bulk ", "A sealed bulk ", "The bulk ")):
        return str(error)
    return f"ETL could not complete the operation ({type(error).__name__}). Check the configured dependencies and retry."


def _watch(engine):
    period = engine.settings.poll_interval_sec
    # A distinct cross-process lease prevents duplicate pollers while allowing manual jobs.
    with engine.registry._lease(83172503, False, 0):
        next_poll = monotonic()
        while True:
            if monotonic() >= next_poll:
                try:
                    engine.poll()
                except Exception as error:
                    message = _safe_failure(error)
                    log.warning("%s", message)
                    print(message, file=sys.stderr, flush=True)
                next_poll = monotonic() + period
            from datetime import UTC, datetime

            if maintenance_window(engine.settings, datetime.now(UTC)):
                try:
                    engine.maintain(yield_if=lambda: monotonic() >= next_poll)
                except Exception as error:
                    log.warning("Maintenance yielded (%s)", type(error).__name__)
            sleep(min(10, max(0, next_poll - monotonic())))


def _search(args, settings):
    import requests

    url = urlsplit(args.api_url)
    if (url.scheme not in ("http", "https") or not url.hostname or url.username is not None
            or url.password is not None or url.path not in ("", "/") or url.query or url.fragment):
        raise ValueError("The search service URL must be an HTTP(S) root URL without credentials or parameters.")
    origin = f"{url.scheme}://{url.netloc}"
    payload = {
        "latitude": args.latitude, "longitude": args.longitude, "radius_m": args.radius_m,
        "dataset_ids": args.dataset_id,
    }
    with requests.Session() as session:
        session.headers["Origin"] = origin
        timeout = (5, max(1, min(settings.query_timeout_sec, 120)))

        def post(path, data):
            response = session.post(origin + "/api/" + path, json=data, allow_redirects=False, timeout=timeout)
            if not 200 <= response.status_code < 300:
                raise RuntimeError(f"Search service returned HTTP {response.status_code}.")
            return response

        login = post("auth/login", {"email": args.email, "password": _read_password(args)}).json()
        session.headers["X-CSRF-Token"] = login["csrf_token"]
        return post("searches", payload).json()


def _read_password(args):
    if args.password_env:
        password = os.environ.get(args.password_env, "")
    elif args.password_stdin:
        password = sys.stdin.readline(PASSWORD_MAX + 2).removesuffix("\n").removesuffix("\r")
    elif sys.stdin.isatty():
        password = getpass("Password: ")
    else:
        raise AccountError("Supply a password using --password-env or --password-stdin")
    if not 1 <= len(password) <= PASSWORD_MAX or not password.strip():
        raise AccountError(f"Password must contain between 1 and {PASSWORD_MAX} characters")
    return password


def main(argv=None):
    """Run a CLI command and return its process exit status."""
    args = _parser().parse_args(argv)
    try:
        settings = load_settings(args.config)
        if args.command == "bulk-prepare":
            changes = {name: getattr(args, name) for name in (
                "bulk_memory_mb", "bulk_stage_quota_mb", "bulk_host_reserve_mb", "bulk_disk_reserve_mb",
                "prepared_max_open_writers", "prepared_carry_mb", "prepared_read_batch_rows", "prepared_inventory_interval_sec",
                "bulk_upload_workers", "prepared_read_row_groups",
            ) if getattr(args, name) is not None}
            settings = replace(settings, **changes)
        _configure_logging(settings, args.debug)
        command = args.command
        if command == "search":
            print(json.dumps(_search(args, settings), ensure_ascii=False, indent=2))
            return 0
        if command == "bootstrap-superadmin":
            registry = Registry(settings)
            registry.initialize()
            result = Accounts(registry).create(args.email, _read_password(args), "superadmin", bootstrap=True)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0
        engine = Engine(settings)
        if command == "register":
            payload = {key: value for key, value in vars(args).items() if key not in ("config", "debug", "command")}
            if payload["mode"] == "cdc" and not payload["capture_instance"]:
                raise ValueError("CDC requires --capture-instance.")
            result = engine.registry.register_dataset(payload)
        elif command == "register-configured":
            result = register_configured(settings, engine.registry)
        elif command == "load":
            result = engine.load(lookup=args.lookup, max_batches=args.max_batches, stop_file=args.stop_file,
                                 initial_only=args.initial_only, source_frozen=args.source_frozen,
                                 output_read_plan=json.loads(args.output_read_plan.read_text()) if args.output_read_plan else None)
        elif command == "discard-load":
            result = engine.discard_load()
        elif command == "list":
            result = engine.registry.list_datasets()
        elif command == "describe":
            result = engine.registry.get_dataset(args.table_id)
        elif command == "run":
            result = engine.run(args.table_id, max_batches=args.max_batches, stop_file=args.stop_file)
        elif command == "import-parquet":
            result = engine.import_parquet(args.table_id, args.path)
        elif command == "bulk-prepare":
            result = engine.bulk_prepare(args.table_id, max_batches=args.max_batches, stop_file=args.stop_file)
        elif command == "bulk-activate":
            result = engine.bulk_activate(args.table_id)
        elif command == "bulk-status":
            result = engine.bulk_status(args.table_id)
        elif command == "bulk-discard":
            result = engine.bulk_discard(args.table_id)
        elif command == "remove":
            engine.remove(args.table_id)
            result = {"removed": args.table_id}
        elif command == "maintain":
            units = 0
            while completed := engine.maintain():
                units += completed
            result = {"units": units}
        elif command == "optimize-search":
            result = engine.optimize_search(stop_file=args.stop_file)
        elif command == "build-single-file":
            result = build_single_file(engine)
        else:
            _watch(engine)
            return 0
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except KeyboardInterrupt:
        return 130
    except Exception as error:
        message = _safe_failure(error)
        log.error("%s", message)
        print(message, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
