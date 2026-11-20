"""Bounded local preparation of immutable Parquet files for initial loads."""

from collections import Counter
from dataclasses import dataclass
from hashlib import sha256
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
from sys import getsizeof
from time import monotonic
from uuid import UUID

import numpy as np
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq
from pyiceberg.transforms import BucketTransform
from pyiceberg.types import LongType

from .layout import SEARCH_SCHEMA


MiB = 1024 * 1024
_OUTPUT = re.compile(r"(?:wide|narrow)-[0-9a-f]+-[0-9]+\.parquet")


@dataclass(frozen=True)
class _Limits:
    target: int
    row_group: int
    buckets: int
    open_writers: int
    carry: int
    batch: int
    read_rows: int
    read_row_groups: int
    disk: int
    reserve: int
    files: int
    metadata: int
    footer: int
    inventory_seconds: float

    @classmethod
    def read(cls, settings):
        values = dict(
            target=settings.target_file_mb * MiB,
            row_group=settings.parquet_row_group_rows,
            buckets=settings.wide_bucket_count,
            open_writers=getattr(settings, "prepared_max_open_writers", 16),
            carry=getattr(settings, "prepared_carry_mb", 32) * MiB,
            batch=settings.batch_max_mb * MiB,
            read_rows=getattr(settings, "prepared_read_batch_rows", 1024),
            read_row_groups=getattr(settings, "prepared_read_row_groups", 8),
            disk=getattr(settings, "bulk_stage_quota_mb", 65536) * MiB,
            reserve=getattr(settings, "bulk_disk_reserve_mb", 1024) * MiB,
            files=getattr(settings, "bulk_max_files", 500000),
            metadata=getattr(settings, "bulk_max_manifest_mb", 128) * MiB,
            footer=getattr(settings, "bulk_max_footer_mb", 8) * MiB,
            inventory_seconds=getattr(settings, "prepared_inventory_interval_sec", 30),
        )
        if any(type(value) is not int or value <= 0 for key, value in values.items()
               if key != "inventory_seconds"):
            raise ValueError("Prepared file limits must be positive integers.")
        if not isinstance(values["inventory_seconds"], (int, float)) or values["inventory_seconds"] <= 0:
            raise ValueError("Prepared inventory cadence must be positive.")
        if not 1 <= values["read_row_groups"] <= 128:
            raise ValueError("Prepared reader row-group window must be between one and 128.")
        return cls(**values)


def _json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _size(value):
    result = getsizeof(value)
    if isinstance(value, dict):
        result += sum(_size(key) + _size(item) for key, item in value.items())
    elif isinstance(value, (list, tuple)):
        result += sum(_size(item) for item in value)
    return result


def _sync_directory(root):
    if os.name == "nt":
        return
    descriptor = os.open(root, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _root(root, run_id):
    run_id = str(UUID(run_id))
    root = Path(root).absolute()
    if root.name != run_id or not root.is_dir() or root.is_symlink() or root.is_junction():
        raise RuntimeError("Prepared files require the owned run UUID directory.")
    return root.resolve(), run_id


def _path(root, name):
    if (not isinstance(name, str) or not name or "\\" in name or ":" in name or "\x00" in name
            or PurePosixPath(name).is_absolute() or any(part in ("", ".", "..") for part in name.split("/"))):
        raise RuntimeError("A prepared path is outside the owned run.")
    candidate = root.joinpath(*PurePosixPath(name).parts)
    if not candidate.resolve().is_relative_to(root):
        raise RuntimeError("A prepared path is outside the owned run.")
    for item in (candidate, *candidate.parents):
        if item == root:
            break
        if item.is_symlink() or item.is_junction():
            raise RuntimeError("A prepared path crosses a symbolic link or junction.")
    return candidate


def _checksum(path, check):
    digest = sha256()
    with path.open("rb") as source:
        while block := source.read(MiB):
            check()
            digest.update(block)
    return digest.hexdigest()


class _Budget:
    def __init__(self, root, limits, check):
        self.root, self.limits, self.callback = root, limits, check
        self.last = -float("inf")
        self.used = 0
        self.reserved = 0
        self.open_files = {}

    def check(self, *, force=False, additional=0):
        self.callback()
        now = monotonic()
        if force or now - self.last >= self.limits.inventory_seconds:
            used = 0
            for directory, folders, files in os.walk(self.root, followlinks=False):
                for name in [*folders, *files]:
                    path = Path(directory) / name
                    if path.is_symlink() or path.is_junction():
                        raise RuntimeError("The owned preparation directory contains a link.")
                for name in files:
                    path = Path(directory) / name
                    size = path.stat().st_size
                    if path in self.open_files:
                        size = max(size, self.open_files[path].tell())
                    used += size
            self.used, self.last = used, monotonic()
        # Writes reserve their uncompressed size before a bounded row group.
        if self.used + self.reserved + additional > self.limits.disk:
            raise OSError("Prepared files reached the owned staging disk quota.")
        if shutil.disk_usage(self.root).free < self.limits.reserve + self.reserved + additional:
            raise OSError("Prepared files reached the staging free-space reserve.")

    def wrote(self, size):
        self.used = max(0, self.used + size)


class _Output:
    """Count buffered writes and enforce the reserved closing-byte allowance."""

    def __init__(self, raw, budget):
        self.raw, self.budget = raw, budget
        self.ceiling = None

    def __getattr__(self, name):
        return getattr(self.raw, name)

    def write(self, data):
        before = self.raw.tell()
        if self.ceiling is not None and before + len(data) > self.ceiling:
            raise OSError("A prepared footer exceeds its reserved byte allowance.")
        try:
            return self.raw.write(data)
        finally:
            self.budget.wrote(self.raw.tell() - before)

    def start_footer(self, maximum):
        self.ceiling = self.raw.tell() + maximum


def _inputs(root, descriptors, schema, budget, *, nullable=False):
    result = []
    for descriptor in descriptors:
        entry = {key: descriptor[key] for key in ("path", "sha256", "rows", "bytes")}
        path = _path(root, entry["path"])
        if path.suffix != ".parquet" or _OUTPUT.fullmatch(path.name):
            raise RuntimeError("An immutable input occupies a prepared output name.")
        if (not re.fullmatch("[0-9a-f]{64}", entry["sha256"])
                or any(type(entry[key]) is not int or entry[key] < 0 for key in ("rows", "bytes"))):
            raise RuntimeError("An immutable input descriptor is invalid.")
        budget.check()
        if not path.is_file() or path.stat().st_size != entry["bytes"] or _checksum(path, budget.check) != entry["sha256"]:
            raise RuntimeError("An immutable preparation input is missing or changed.")
        with pq.ParquetFile(path) as parquet:
            actual = parquet.schema_arrow
            valid_schema = (actual.names == schema.names and actual.types == schema.types) if nullable else actual.equals(schema, check_metadata=True)
            if parquet.metadata.num_rows != entry["rows"] or not valid_schema:
                raise RuntimeError("An immutable preparation input has an unexpected schema or row count.")
        result.append(entry)
    if len({item["path"] for item in result}) != len(result):
        raise RuntimeError("An immutable preparation input is listed more than once.")
    return result


class _Journal:
    def __init__(self, root, run_id, kind, schema, inputs, layout, limits, budget, persist, progress):
        self.root, self.schema, self.limits, self.budget, self.persist = root, schema, limits, budget, persist
        self.name = f"{kind}-seals.jsonl"
        self.path = _path(root, self.name)
        self.kind, self.layout = kind, layout
        self.source = sha256(_json(inputs)).hexdigest()
        self.fingerprint = sha256(_json({"schema": sha256(schema.serialize().to_pybytes()).hexdigest(),
                                       "layout": layout})).hexdigest()
        header = {"format": 1, "run_id": run_id, "kind": kind, "source_fingerprint": self.source,
                  "layout_fingerprint": self.fingerprint}
        self.files, self.watermarks, self.indices = [], {}, Counter()
        self.rows = self.bytes = self.metadata = 0
        self.complete = False
        self.last = sha256(_json(header)).hexdigest()
        self.handle = None
        checkpoint_seen = progress is None
        def matches_checkpoint():
            return progress is not None and all(progress.get(key) == value for key, value in self.progress().items())
        checkpoint_seen = checkpoint_seen or matches_checkpoint()
        truncate_at = None
        if self.path.exists():
            if self.path.stat().st_size > limits.metadata:
                raise MemoryError("The prepared seal journal exceeds its metadata budget.")
            with self.path.open("rb") as stream:
                first = stream.readline()
                if not first.endswith(b"\n") or json.loads(first) != header:
                    raise RuntimeError("The prepared seal journal belongs to different inputs, schema or layout.")
                end = stream.tell()
                while line := stream.readline():
                    budget.check()
                    if not line.endswith(b"\n"):
                        break
                    try:
                        record = json.loads(line)
                        payload = record["payload"]
                        expected = sha256(self.last.encode("ascii") + _json(payload)).hexdigest()
                        if record["previous"] != self.last or record["sha256"] != expected:
                            raise ValueError()
                        if payload["kind"] == "sealed" and not self.complete:
                            self._accept(payload["entry"], verify=True)
                        elif payload["kind"] == "complete" and not self.complete:
                            if payload["rows"] != self.rows or payload["bytes"] != self.bytes:
                                raise ValueError()
                            self.complete = True
                        else:
                            raise ValueError()
                        self.last = expected
                        checkpoint_seen = checkpoint_seen or matches_checkpoint()
                    except (ValueError, KeyError, TypeError) as error:
                        raise RuntimeError("A committed prepared journal record is corrupt.") from error
                    end = stream.tell()
            truncate_at = end
        else:
            if progress is not None:
                raise RuntimeError("The prepared journal required by its checkpoint is missing.")
            if any(root.glob(f"{kind}-*.parquet")):
                raise RuntimeError("Prepared outputs exist without their seal journal.")
            temporary = _path(root, f"{kind}-seals.tmp")
            previous_size = temporary.stat().st_size if temporary.exists() else 0
            with temporary.open("wb") as stream:
                stream.write(_json(header) + b"\n")
                stream.flush()
                os.fsync(stream.fileno())
            temporary.replace(self.path)
            self.budget.wrote(self.path.stat().st_size - previous_size)
            _sync_directory(root)
        if not checkpoint_seen:
            raise RuntimeError("The prepared checkpoint does not match a verified journal prefix.")
        if truncate_at is not None:
            previous_size = self.path.stat().st_size
            with self.path.open("r+b") as stream:
                stream.truncate(truncate_at)
                stream.flush()
                os.fsync(stream.fileno())
            self.budget.wrote(truncate_at - previous_size)
        self.handle = self.path.open("ab")
        if self.files or self.complete:
            try:
                self.persist({"kind": "complete" if self.complete else "sealed",
                              **({"entry": self.files[-1]} if self.files and not self.complete else {}),
                              "progress": self.progress()})
            except BaseException:
                self.close()
                raise

    def _partition(self, partition):
        if self.kind == "wide":
            if set(partition) != {"object_bucket"}:
                raise RuntimeError("A prepared wide partition is invalid.")
            key = partition["object_bucket"]
            if type(key) is not int or not 0 <= key < self.layout["buckets"]:
                raise RuntimeError("A prepared wide bucket is invalid.")
        else:
            column = self.layout["partition"]
            if set(partition) != {"table_id", column} or partition["table_id"] != self.layout["table_id"]:
                raise RuntimeError("A prepared narrow partition is invalid.")
            key = partition[column]
            if type(key) is not int or not 0 <= key < 1 << 63:
                raise RuntimeError("A prepared narrow cell is invalid.")
        return key

    def _accept(self, entry, *, verify):
        key = self._partition(entry["partition"])
        path = _path(self.root, entry["path"])
        expected_name = f"{self.kind}-{key:x}-{self.indices[key]:06}.parquet"
        if (path.name != expected_name or path.parent != self.root
                or not re.fullmatch("[0-9a-f]{64}", entry["sha256"])
                or any(type(entry[name]) is not int for name in ("rows", "bytes", "object_id_min", "object_id_max"))
                or entry["rows"] <= 0 or entry["bytes"] <= 0 or entry["object_id_min"] > entry["object_id_max"]
                or (key in self.watermarks and entry["object_id_min"] <= self.watermarks[key])):
            raise RuntimeError("A prepared seal descriptor or key interval is invalid.")
        charge = _size(entry) + (512 if key not in self.watermarks else 0)
        if len(self.files) >= self.limits.files or self.metadata + charge > self.limits.metadata:
            raise MemoryError("Prepared files reached their file or metadata budget.")
        if verify:
            if (not path.is_file() or path.stat().st_size != entry["bytes"]
                    or _checksum(path, self.budget.check) != entry["sha256"]):
                raise RuntimeError("A sealed prepared file is missing or changed.")
            with pq.ParquetFile(path) as parquet:
                if parquet.metadata.num_rows != entry["rows"] or not parquet.schema_arrow.equals(self.schema, check_metadata=True):
                    raise RuntimeError("A sealed prepared file has an unexpected schema or row count.")
        self.files.append(entry)
        self.watermarks[key] = entry["object_id_max"]
        self.indices[key] += 1
        self.metadata += charge
        self.rows += entry["rows"]
        self.bytes += entry["bytes"]

    def _append(self, payload):
        self.budget.check()
        digest = sha256(self.last.encode("ascii") + _json(payload)).hexdigest()
        line = _json({"payload": payload, "previous": self.last, "sha256": digest}) + b"\n"
        if self.path.stat().st_size + len(line) > self.limits.metadata:
            raise MemoryError("The prepared seal journal reached its metadata budget.")
        self.handle.write(line)
        self.handle.flush()
        os.fsync(self.handle.fileno())
        self.last = digest
        self.budget.wrote(len(line))

    def seal(self, entry):
        self._accept(entry, verify=False)
        self._append({"kind": "sealed", "entry": entry})
        self.persist({"kind": "sealed", "entry": dict(entry), "progress": self.progress()})

    def progress(self):
        return {"journal": self.name, "layout_fingerprint": self.fingerprint,
                "source_fingerprint": self.source, "sealed_count": len(self.files),
                "rows": self.rows, "bytes": self.bytes, "complete": self.complete,
                "last_record_sha256": self.last}

    def finish(self, expected_rows):
        if self.rows != expected_rows:
            raise RuntimeError("Prepared output rows differ from their immutable inputs.")
        if not self.complete:
            self._append({"kind": "complete", "rows": self.rows, "bytes": self.bytes})
            self.complete = True
        self.persist({"kind": "complete", "progress": self.progress()})
        self.budget.check(force=True)
        return {"files": sorted(self.files, key=lambda entry: entry["path"]), "rows": self.rows,
                "bytes": self.bytes, "layout_fingerprint": self.fingerprint, "progress": self.progress()}

    def close(self):
        if self.handle is not None:
            self.handle.close()


class _Writers:
    def __init__(self, journal, budget, limits):
        self.journal, self.budget, self.limits = journal, budget, limits
        self.writers, self.carry = {}, {}
        self.carry_bytes = 0
        self.partitions = {}

    def _write(self, key, data, partition):
        opening = key not in self.writers
        # Parquet's closing bytes include its bounded metadata and eight-byte trailer.
        footer_reserve = self.limits.footer + 8
        self.budget.check(additional=data.nbytes + 64 * 1024 + (footer_reserve if opening else 0))
        if key not in self.writers:
            if len(self.writers) >= self.limits.open_writers or len(self.journal.files) + len(self.writers) >= self.limits.files:
                raise MemoryError("Prepared files reached the open writer or file count budget.")
            name = f"{self.journal.kind}-{key:x}-{self.journal.indices[key]:06}.parquet"
            target = _path(self.journal.root, name)
            temporary = _path(self.journal.root, name + ".partial")
            previous_size = temporary.stat().st_size if temporary.exists() else 0
            handle = _Output(temporary.open("wb"), self.budget)
            self.budget.wrote(-previous_size)
            self.budget.reserved += footer_reserve
            self.budget.open_files[temporary] = handle
            try:
                writer = pq.ParquetWriter(handle, self.journal.schema, compression="zstd")
            except BaseException:
                try:
                    handle.close()
                finally:
                    self.budget.open_files.pop(temporary, None)
                    self.budget.reserved -= footer_reserve
                raise
            self.writers[key] = {"writer": writer, "handle": handle, "target": target, "temporary": temporary,
                                 "rows": 0, "groups": 0, "min": data["object_id"][0].as_py(), "max": None,
                                 "partition": partition, "footer_reserve": footer_reserve}
        state = self.writers[key]
        state["writer"].write_table(data, row_group_size=self.limits.row_group)
        state["rows"] += len(data)
        state["groups"] += 1
        state["max"] = data["object_id"][-1].as_py()
        # Limit accumulated writer metadata even for unusually compressible rows.
        max_groups = max(1, self.limits.footer // max(1024, len(self.journal.schema) * 1024))
        if state["handle"].tell() >= self.limits.target or state["groups"] >= max_groups:
            self.close_partition(key)

    def _prefix(self, data):
        maximum = min(len(data), self.limits.row_group)
        byte_limit = min(self.limits.carry, self.limits.batch)
        if data.slice(0, maximum).nbytes <= byte_limit:
            return maximum
        low, high = 0, maximum
        while low < high:
            middle = (low + high + 1) // 2
            if data.slice(0, middle).nbytes <= byte_limit:
                low = middle
            else:
                high = middle - 1
        if not low:
            raise MemoryError("One prepared row exceeds the decoded row-group byte budget.")
        return low

    def _flush_carry(self, key):
        tail = self.carry.pop(key)
        self.carry_bytes -= tail.nbytes
        self._write(key, tail, self.partitions[key])

    def add(self, key, data, partition):
        if not len(data):
            return
        self.partitions[key] = partition
        previous = self.carry.pop(key, None)
        if previous is not None:
            self.carry_bytes -= previous.nbytes
            data = pa.concat_tables([previous, data])
        position = 0
        while position < len(data):
            remaining = data.slice(position)
            count = self._prefix(remaining)
            if count == self.limits.row_group or count < len(remaining):
                # A decoded-byte boundary can flush a short row group without
                # closing its Parquet file or changing the input row sequence.
                self._write(key, remaining.slice(0, count), partition)
                position += count
                continue
            tail_bytes = remaining.nbytes
            while self.carry and self.carry_bytes + tail_bytes > self.limits.carry:
                largest = max(self.carry, key=lambda item: self.carry[item].nbytes)
                self._flush_carry(largest)
            if self.carry_bytes + tail_bytes > self.limits.carry:
                raise MemoryError("Prepared files reached their aggregate carry byte budget.")
            # take() copies the tail and releases larger input buffers.
            tail = remaining.take(pa.array(np.arange(len(remaining), dtype=np.int64)))
            self.carry[key] = tail
            self.carry_bytes += tail.nbytes
            break
        self.budget.check()

    def close_partition(self, key, partition=None):
        if key in self.carry:
            self._flush_carry(key)
        state = self.writers.get(key)
        if state is None:
            return
        self.budget.check()
        state["handle"].start_footer(state["footer_reserve"])
        try:
            state["writer"].close()
            state["handle"].flush()
            os.fsync(state["handle"].fileno())
        finally:
            try:
                state["handle"].close()
            finally:
                self.writers.pop(key, None)
                self.budget.open_files.pop(state["temporary"], None)
                self.budget.reserved -= state["footer_reserve"]
        replaced_bytes = state["target"].stat().st_size if state["target"].exists() else 0
        with pq.ParquetFile(state["temporary"]) as parquet:
            if parquet.metadata.serialized_size > self.limits.footer:
                raise MemoryError("A prepared file exceeds its footer metadata budget.")
        state["temporary"].replace(state["target"])
        self.budget.wrote(-replaced_bytes)
        _sync_directory(self.journal.root)
        entry = {"path": state["target"].name, "sha256": _checksum(state["target"], self.budget.check),
                 "rows": state["rows"], "bytes": state["target"].stat().st_size,
                 "partition": state["partition"], "object_id_min": state["min"], "object_id_max": state["max"]}
        self.journal.seal(entry)

    def abort(self):
        # Every open writer retains its footer reservation during cancellation.
        # Excess closing bytes fail in the sink; partials are never journaled.
        for state in self.writers.values():
            try:
                state["handle"].start_footer(state["footer_reserve"])
                state["writer"].close()
            except BaseException:
                pass
            finally:
                try:
                    state["handle"].close()
                except BaseException:
                    pass
                self.budget.open_files.pop(state["temporary"], None)
                self.budget.reserved -= state["footer_reserve"]
        self.writers.clear()
        self.carry.clear()



def _batches(root, inputs, schema, limits, budget):
    for entry in inputs:
        with pq.ParquetFile(_path(root, entry["path"])) as parquet:
            for start in range(0, parquet.num_row_groups, limits.read_row_groups):
                batches = parquet.iter_batches(
                    batch_size=limits.read_rows,
                    row_groups=range(start, min(start + limits.read_row_groups, parquet.num_row_groups)),
                    use_threads=False,
                )
                try:
                    for batch in batches:
                        budget.check()
                        data = pa.Table.from_batches([batch]).cast(schema)
                        if data.nbytes > limits.batch:
                            raise MemoryError("A decoded prepared input batch exceeds its byte budget.")
                        if any(not field.nullable and column.null_count for field, column in zip(schema, data.columns)):
                            raise RuntimeError("A required prepared input value is null.")
                        yield data
                finally:
                    batches.close()


def build_wide(root, run_id, schema, inputs, settings, check, persist_progress, progress=None):
    """Prepare continuous bucket files from immutable, ascending OBJECTID inputs."""
    root, run_id = _root(root, run_id)
    limits = _Limits.read(settings)
    if limits.buckets > limits.open_writers:
        raise ValueError("Wide buckets exceed the configured prepared open writer budget.")
    if schema.field("object_id").type != pa.int64():
        raise ValueError("Prepared OBJECTIDs must use signed int64.")
    budget = _Budget(root, limits, check)
    budget.check(force=True)
    inputs = _inputs(root, inputs, schema, budget)
    layout = {"kind": "wide", "buckets": limits.buckets, "target_bytes": limits.target,
              "row_group_rows": limits.row_group, "row_group_max_bytes": min(limits.carry, limits.batch), "footer_max_bytes": limits.footer, "compression": "zstd"}
    journal = _Journal(root, run_id, "wide", schema, inputs, layout, limits, budget, persist_progress, progress)
    writers = _Writers(journal, budget, limits)
    try:
        if not journal.complete:
            bucket = BucketTransform(limits.buckets).transform(LongType())
            previous = None
            dataset = None
            for data in _batches(root, inputs, schema, limits, budget):
                ids = data["object_id"].to_numpy()
                if len(ids) and ((previous is not None and ids[0] <= previous)
                                 or np.any(ids[1:] <= ids[:-1])):
                    raise RuntimeError("Prepared wide inputs contain unordered or duplicate OBJECTIDs.")
                if len(ids):
                    previous = int(ids[-1])
                    dataset = data["table_id"][0].as_py() if dataset is None else dataset
                    if not pc.all(pc.equal(data["table_id"], dataset)).as_py():
                        raise RuntimeError("Prepared wide inputs contain multiple dataset identities.")
                buckets = np.fromiter((bucket(int(key)) for key in ids), dtype=np.int32, count=len(ids))
                for key in np.unique(buckets):
                    key = int(key)
                    mask = buckets == key
                    if key in journal.watermarks:
                        mask &= ids > journal.watermarks[key]
                    indexes = np.flatnonzero(mask)
                    if len(indexes):
                        writers.add(key, data.take(pa.array(indexes)), {"object_bucket": key})
            for key in sorted(set(writers.writers) | set(writers.carry)):
                writers.close_partition(key, {"object_bucket": key})
        return journal.finish(sum(entry["rows"] for entry in inputs))
    finally:
        try:
            writers.abort()
        finally:
            journal.close()


def build_narrow(root, run_id, sorted_input, table_id, resolution, settings, check, persist_progress, progress=None):
    """Prepare one dataset's partition-contiguous sorted canonical search input."""
    root, run_id = _root(root, run_id)
    table_id = str(UUID(table_id))
    if type(resolution) is not int or not 0 <= resolution <= 15:
        raise ValueError("Prepared narrow resolution must be between zero and fifteen.")
    limits = _Limits.read(settings)
    budget = _Budget(root, limits, check)
    budget.check(force=True)
    inputs = _inputs(root, [] if sorted_input is None else [sorted_input], SEARCH_SCHEMA, budget, nullable=True)
    column = f"h3_r{resolution}"
    layout = {"kind": "narrow", "table_id": table_id, "partition": column,
              "target_bytes": limits.target, "row_group_rows": limits.row_group, "row_group_max_bytes": min(limits.carry, limits.batch), "footer_max_bytes": limits.footer, "compression": "zstd"}
    journal = _Journal(root, run_id, "narrow", SEARCH_SCHEMA, inputs, layout, limits, budget, persist_progress, progress)
    writers = _Writers(journal, budget, limits)
    previous = None
    active = None
    try:
        if not journal.complete:
            for data in _batches(root, inputs, SEARCH_SCHEMA, limits, budget):
                if not pc.all(pc.equal(data["table_id"], table_id)).as_py():
                    raise RuntimeError("Prepared narrow inputs contain another dataset identity.")
                cells, ids = data[column].to_numpy(), data["object_id"].to_numpy()
                if len(data) and (previous is not None and (int(cells[0]), int(ids[0])) <= previous):
                    raise RuntimeError("Prepared narrow inputs do not advance their partition/key cursor.")
                if len(data) > 1 and np.any((cells[1:] < cells[:-1]) | ((cells[1:] == cells[:-1]) & (ids[1:] <= ids[:-1]))):
                    raise RuntimeError("Prepared narrow inputs contain unordered or duplicate partition keys.")
                if len(data):
                    previous = int(cells[-1]), int(ids[-1])
                boundaries = [0, *(np.flatnonzero(cells[1:] != cells[:-1]) + 1).tolist(), len(data)]
                for start, stop in zip(boundaries, boundaries[1:]):
                    if start == stop:
                        continue
                    key = int(cells[start])
                    if active is not None and key != active:
                        writers.close_partition(active, {"table_id": table_id, column: active})
                    active = key
                    part = data.slice(start, stop - start)
                    if key in journal.watermarks:
                        part = part.filter(pc.greater(part["object_id"], journal.watermarks[key]))
                    writers.add(key, part, {"table_id": table_id, column: key})
            if active is not None:
                writers.close_partition(active, {"table_id": table_id, column: active})
        return journal.finish(sum(entry["rows"] for entry in inputs))
    finally:
        try:
            writers.abort()
        finally:
            journal.close()
