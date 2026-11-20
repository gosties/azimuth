"""Typed configuration shared by command-line and HTTP services."""

from __future__ import annotations

import os
import math
import tomllib
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit


@dataclass
class Settings:
    """Resource, connection, storage, and scheduling options.

    Values may be supplied in TOML or by H3SEARCH_<FIELD> variables. Connection
    passwords and storage credentials should be supplied through environment
    variables or a private configuration file. Sizes are in MiB unless named
    otherwise; timeouts and intervals are in seconds.
    """

    mode: str = "local"
    primary_catalog_name: str = "Primary catalog"
    primary_catalog_description: str = "Managed shared datasets"
    state_path: Path = Path("runtime/control.sqlite")
    lake_path: Path = Path("runtime/lake")
    stage_path: Path = Path("runtime/stage")
    log_path: Path = Path("runtime/logs")
    postgres_dsn: str = ""
    catalog_name: str = "h3search"
    catalog_uri: str = ""
    catalog_token: str = ""
    catalog_ca_bundle: str = ""
    namespace: str = "h3search"
    warehouse: str = ""
    s3_endpoint: str = ""
    s3_access_key: str = ""
    s3_secret_key: str = ""
    s3_region: str = "us-east-1"
    s3_ca_bundle: str = ""
    s3_path_style: bool = True
    trino_host: str = "localhost"
    trino_port: int = 8080
    trino_user: str = "h3search"
    trino_password: str = ""
    trino_catalog: str = "iceberg"
    trino_schema: str = "h3search"
    trino_scheme: str = "http"
    trino_ca_bundle: str = ""
    trino_statistics_enabled: bool = True
    trino_parquet_small_file_threshold_bytes: int = 3 * 1024 * 1024
    pool_size: int = 4
    query_timeout_sec: float = 60.0
    pool_wait_sec: float = 5.0
    session_ttl_sec: int = 3600
    session_cleanup_interval_sec: int = 60
    session_cleanup_batch_size: int = 1000
    auth_session_ttl_sec: int = 8 * 60 * 60
    auth_cookie_secure: bool = True
    auth_origins: list[str] = field(default_factory=list)
    max_map_points: int = 100_000
    map_known_count_min_rows: int = 1_000_000
    wide_value_preview_chars: int = 2048
    wide_response_budget_bytes: int = 8 * 1024 * 1024
    max_radius_m: float = 20_015_087.0
    max_search_centers: int = 5_000
    max_search_candidate_pairs: int = 50_000
    multi_center_join_resolution: int = 7
    multi_center_fine_max_radius_m: float = 1000.0
    max_search_query_bytes: int = 750_000
    max_temporal_datasets: int = 32
    max_saved_searches: int = 200
    max_saved_search_request_bytes: int = 512 * 1024
    max_saved_search_bytes_per_account: int = 16 * 1024 * 1024
    max_csv_bytes: int = 1024 * 1024
    max_csv_rows: int = 5_000
    max_csv_columns: int = 256
    max_csv_cell_chars: int = 16_384
    export_path: Path = Path("runtime/exports")
    export_workers: int = 1
    export_max_jobs: int = 32
    export_timeout_sec: int = 3600
    export_ttl_sec: int = 4 * 3600
    export_cleanup_interval_sec: int = 1
    export_metadata_pool_size: int = 4
    export_csv_compresslevel: int = 1
    export_batch_rows: int = 16
    export_sql_batch_rows: int = 512
    export_row_budget_bytes: int = 8 * 1024 * 1024
    export_memory_mb: int = 256
    export_file_max_mb: int = 8192
    export_disk_quota_mb: int = 32768
    export_disk_reserve_mb: int = 1024
    max_csv_export_rows: int = 10_000_000
    max_kml_export_rows: int = 50_000
    max_json_export_rows: int = 5_000_000
    max_gpkg_export_rows: int = 5_000_000
    fetch_batch_rows: int = 100_000
    initial_source_reader: str = "pyodbc"
    initial_native_buffer_mb: int = 64
    initial_native_text_units: int = 4096
    initial_native_binary_bytes: int = 65536
    cdc_batch_rows: int = 4096
    transform_workers: int = 4
    memory_budget_mb: int = 1024
    batch_max_mb: int = 64
    partition_resolution: int = 3
    wide_bucket_count: int = 16
    parquet_row_group_rows: int = 4096
    target_file_mb: int = 128
    single_file_read_split_mb: int = 4096
    single_file_row_group_rows: int = 65_536
    initial_search_grouping: bool = False
    initial_search_sort_memory_mb: int = 256
    initial_search_sort_temp_mb: int = 16384
    initial_search_sort_threads: int = 4
    initial_search_sort_row_group_rows: int = 65536
    initial_search_sort_timeout_sec: int = 3600
    bulk_owner_id: str = ""
    bulk_memory_mb: int = 1024
    bulk_host_reserve_mb: int = 1024
    bulk_stage_quota_mb: int = 65536
    bulk_disk_reserve_mb: int = 1024
    bulk_max_files: int = 500_000
    bulk_max_manifest_mb: int = 128
    bulk_max_footer_mb: int = 8
    bulk_max_snapshots: int = 100_000
    bulk_upload_workers: int = 4
    prepared_max_open_writers: int = 16
    prepared_carry_mb: int = 32
    prepared_read_batch_rows: int = 1024
    prepared_read_row_groups: int = 8
    prepared_inventory_interval_sec: float = 30.0
    local_lease_heartbeat_sec: float = 0.25
    poll_interval_sec: int = 600
    maintenance_timezone: str = "America/New_York"
    maintenance_start: str = "02:00"
    maintenance_end: str = "05:00"
    maintenance_budget_sec: int = 3600
    maintenance_max_files: int = 8
    manifest_regroup_max_files: int = 100_000
    manifest_regroup_max_entries: int = 1024
    manifest_regroup_budget_sec: int = 60
    snapshot_retention_days: int = 7
    cdc_capture_timeout_sec: int = 300
    log_level: str = "INFO"
    log_max_mb: int = 20
    log_backups: int = 5
    connections: dict[str, dict[str, Any]] = field(default_factory=dict)
    dataset_defaults: dict[str, Any] = field(default_factory=dict)
    datasets: list[dict[str, Any]] = field(default_factory=list)
    maps: list[dict[str, Any]] = field(default_factory=list)
    default_map_id: str | None = None

    def __post_init__(self) -> None:
        if not self.primary_catalog_name.strip() or len(self.primary_catalog_name) > 120:
            raise ValueError("primary_catalog_name must contain 1–120 characters")
        if len(self.primary_catalog_description) > 4000:
            raise ValueError("primary_catalog_description must contain at most 4000 characters")
        if type(self.export_sql_batch_rows) is not int or not 1 <= self.export_sql_batch_rows <= 2000:
            raise ValueError("export_sql_batch_rows must be an integer from 1 to 2000")
        if type(self.multi_center_join_resolution) is not int or not 0 <= self.multi_center_join_resolution <= 9:
            raise ValueError("multi_center_join_resolution must be an integer from 0 to 9; 0 disables fine joins")
        if (type(self.multi_center_fine_max_radius_m) not in (int, float)
                or not math.isfinite(self.multi_center_fine_max_radius_m)
                or not 0 < self.multi_center_fine_max_radius_m <= 1000):
            raise ValueError("multi_center_fine_max_radius_m must be positive and at most 1000 meters")
        for name in ("max_search_centers", "max_search_candidate_pairs", "max_search_query_bytes", "max_temporal_datasets", "max_csv_bytes", "max_csv_rows", "max_csv_columns", "max_csv_cell_chars"):
            if type(getattr(self, name)) is not int or getattr(self, name) <= 0:
                raise ValueError(f"{name} must be a positive integer")
        for name in ("max_saved_searches", "max_saved_search_request_bytes", "max_saved_search_bytes_per_account"):
            if type(getattr(self, name)) is not int or getattr(self, name) <= 0:
                raise ValueError(f"{name} must be a positive integer")
        for name in ("state_path", "lake_path", "stage_path", "log_path", "export_path"):
            setattr(self, name, Path(getattr(self, name)))
        for name in ("export_max_jobs", "export_timeout_sec", "export_ttl_sec", "export_cleanup_interval_sec", "export_batch_rows", "export_row_budget_bytes",
                     "export_memory_mb", "export_file_max_mb", "export_disk_quota_mb", "export_disk_reserve_mb",
                     "max_csv_export_rows", "max_kml_export_rows", "max_json_export_rows", "max_gpkg_export_rows"):
            if type(getattr(self, name)) is not int or getattr(self, name) <= 0:
                raise ValueError(f"{name} must be a positive integer")
        if type(self.export_workers) is not int or not 1 <= self.export_workers <= 4:
            raise ValueError("export_workers must be between 1 and 4")
        if type(self.export_metadata_pool_size) is not int or not 1 <= self.export_metadata_pool_size <= 16:
            raise ValueError("export_metadata_pool_size must be between 1 and 16")
        if type(self.export_csv_compresslevel) is not int or not 0 <= self.export_csv_compresslevel <= 9:
            raise ValueError("export_csv_compresslevel must be between 0 and 9")
        if self.export_file_max_mb > self.export_disk_quota_mb:
            raise ValueError("export_file_max_mb must not exceed export_disk_quota_mb")
        if self.mode not in {"local", "live"}:
            raise ValueError("mode must be local or live")
        if not isinstance(self.trino_statistics_enabled, bool):
            raise ValueError("trino_statistics_enabled must be a boolean")
        if type(self.trino_parquet_small_file_threshold_bytes) is not int or self.trino_parquet_small_file_threshold_bytes < 0:
            raise ValueError("trino_parquet_small_file_threshold_bytes must be a nonnegative integer")
        if type(self.map_known_count_min_rows) is not int or self.map_known_count_min_rows < 0:
            raise ValueError("map_known_count_min_rows must be a nonnegative integer")
        if type(self.initial_search_grouping) is not bool:
            raise ValueError("initial_search_grouping must be a boolean")
        for name in ("initial_search_sort_memory_mb", "initial_search_sort_temp_mb", "initial_search_sort_timeout_sec"):
            if type(getattr(self, name)) is not int or getattr(self, name) <= 0:
                raise ValueError(f"{name} must be a positive integer")
        for name in ("bulk_memory_mb", "bulk_host_reserve_mb", "bulk_stage_quota_mb", "bulk_disk_reserve_mb",
                     "bulk_max_files", "bulk_max_manifest_mb", "bulk_max_footer_mb", "bulk_max_snapshots"):
            if type(getattr(self, name)) is not int or getattr(self, name) <= 0:
                raise ValueError(f"{name} must be a positive integer")
        for name in ("prepared_max_open_writers", "prepared_carry_mb", "prepared_read_batch_rows"):
            if type(getattr(self, name)) is not int or getattr(self, name) <= 0:
                raise ValueError(f"{name} must be a positive integer")
        if type(self.prepared_read_row_groups) is not int or not 1 <= self.prepared_read_row_groups <= 128:
            raise ValueError("prepared_read_row_groups must be between 1 and 128")
        if (not isinstance(self.prepared_inventory_interval_sec, (int, float))
                or not math.isfinite(self.prepared_inventory_interval_sec) or self.prepared_inventory_interval_sec <= 0):
            raise ValueError("prepared_inventory_interval_sec must be positive and finite")
        if (type(self.local_lease_heartbeat_sec) not in (int, float)
                or not math.isfinite(self.local_lease_heartbeat_sec)
                or not 0.05 <= self.local_lease_heartbeat_sec <= 1.0):
            raise ValueError("local_lease_heartbeat_sec must be between 0.05 and 1.0")
        if self.bulk_memory_mb < 256:
            raise ValueError("bulk_memory_mb must be at least 256")
        if type(self.bulk_upload_workers) is not int or not 1 <= self.bulk_upload_workers <= 4:
            raise ValueError("bulk_upload_workers must be between 1 and 4")
        if not isinstance(self.bulk_owner_id, str) or len(self.bulk_owner_id) > 256:
            raise ValueError("bulk_owner_id must be a string of at most 256 characters")
        if type(self.initial_search_sort_threads) is not int or not 1 <= self.initial_search_sort_threads <= 4:
            raise ValueError("initial_search_sort_threads must be between 1 and 4")
        if (type(self.initial_search_sort_row_group_rows) is not int
                or not 2048 <= self.initial_search_sort_row_group_rows <= 1048576):
            raise ValueError("initial_search_sort_row_group_rows must be between 2048 and 1048576")
        for name, maximum in (("single_file_read_split_mb", 65_536), ("single_file_row_group_rows", 1_048_576)):
            value = getattr(self, name)
            if type(value) is not int or not 1 <= value <= maximum:
                raise ValueError(f"{name} must be an integer between 1 and {maximum}")
        if self.auth_session_ttl_sec <= 0:
            raise ValueError("auth_session_ttl_sec must be positive")
        if not isinstance(self.auth_origins, list):
            raise ValueError("auth_origins must be a list of HTTP(S) origins")
        for origin in self.auth_origins:
            if not isinstance(origin, str) or any(character.isspace() for character in origin):
                raise ValueError("Invalid authentication origin")
            parts = urlsplit(origin)
            if (parts.scheme not in {"http", "https"} or not parts.hostname or parts.username is not None
                    or origin != f"{parts.scheme}://{parts.netloc}"):
                raise ValueError("Invalid authentication origin")
        for name in ("pool_size", "session_ttl_sec", "fetch_batch_rows", "transform_workers", "memory_budget_mb", "batch_max_mb", "wide_bucket_count", "target_file_mb", "parquet_row_group_rows", "poll_interval_sec", "maintenance_max_files"):
            if getattr(self, name) <= 0:
                raise ValueError(f"{name} must be positive")
        for name in ("manifest_regroup_max_files", "manifest_regroup_max_entries", "manifest_regroup_budget_sec"):
            if type(getattr(self, name)) is not int or getattr(self, name) <= 0:
                raise ValueError(f"{name} must be a positive integer")
        for name in ("session_cleanup_interval_sec", "session_cleanup_batch_size"):
            if type(getattr(self, name)) is not int or not 1 <= getattr(self, name) <= 100_000:
                raise ValueError(f"{name} must be an integer between 1 and 100000")
        if type(self.cdc_batch_rows) is not int or not 1 <= self.cdc_batch_rows <= 100_000:
            raise ValueError("cdc_batch_rows must be an integer between 1 and 100000")
        if self.initial_source_reader not in ("pyodbc", "arrow"):
            raise ValueError("initial_source_reader must be pyodbc or arrow")
        for name, maximum in (("initial_native_buffer_mb", 256),
                              ("initial_native_text_units", 1048576),
                              ("initial_native_binary_bytes", 16777216)):
            if type(getattr(self, name)) is not int or not 1 <= getattr(self, name) <= maximum:
                raise ValueError(f"{name} must be an integer between 1 and {maximum}")
        if not 0 <= self.partition_resolution <= 15:
            raise ValueError("partition_resolution must be between 0 and 15")
        if type(self.max_map_points) is not int or not 1 <= self.max_map_points <= 2**31 - 1:
            raise ValueError("max_map_points must be an integer between 1 and 2147483647")
        if not 1 <= self.wide_value_preview_chars <= 8192:
            raise ValueError("wide_value_preview_chars must be between 1 and 8192")
        if self.wide_response_budget_bytes < 65536:
            raise ValueError("wide_response_budget_bytes must be at least 65536 bytes")

    @classmethod
    def load(cls, path: str | Path | None = None) -> "Settings":
        """Read a TOML configuration and apply explicitly supplied environment values."""
        source = path or os.environ.get("H3SEARCH_CONFIG")
        data: dict[str, Any] = {}
        if source:
            with Path(source).open("rb") as stream:
                data = tomllib.load(stream)
            data = {**data.pop("settings", {}), **data}
        defaults = cls()
        known = {item.name for item in fields(cls)}
        unknown = set(data) - known
        if unknown:
            raise ValueError("Unknown configuration options: " + ", ".join(sorted(unknown)))
        for name in known:
            raw = os.environ.get(f"H3SEARCH_{name.upper()}")
            if raw is None:
                continue
            default = getattr(defaults, name)
            if isinstance(default, bool):
                if raw.lower() not in {"true", "false", "1", "0", "yes", "no"}:
                    raise ValueError(f"Invalid boolean for {name}")
                data[name] = raw.lower() in {"true", "1", "yes"}
            elif isinstance(default, int):
                data[name] = int(raw)
            elif isinstance(default, float):
                data[name] = float(raw)
            elif isinstance(default, (dict, list)):
                import json
                data[name] = json.loads(raw)
            else:
                data[name] = raw
        return cls(**data)


def load_settings(path: str | Path | None = None) -> Settings:
    """Load settings without constructing service or database connections."""
    return Settings.load(path)
