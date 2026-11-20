"""Bounded execution and cancellation for blocking storage clients."""

import asyncio
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager, suppress
from queue import Empty, LifoQueue
from threading import Event, Lock

from fastapi import HTTPException

LOG = logging.getLogger(__name__)


class Unavailable(Exception):
    """A storage operation cannot complete within its resource limits."""


class Job:
    """Track the cancellation and storage lease of one blocking operation."""

    def __init__(self, request_id):
        self.request_id = request_id
        self.cancelled = Event()
        self._lock = Lock()
        self._cancel_query = None
        self.lease_guard = None
        self._lease_checked_at = -float("inf")

    def check(self):
        if self.cancelled.is_set():
            raise HTTPException(410, "Search was cancelled")

    def verify_lease(self, *, force=False):
        """Check the live reader lock before publishing results and periodically while streaming."""
        self.check()
        now = time.monotonic()
        if self.lease_guard is not None and (force or now - self._lease_checked_at >= 5):
            self.lease_guard()
            self._lease_checked_at = now

    @contextmanager
    def query(self, cancel):
        with self._lock:
            self.check()
            self._cancel_query = cancel
        try:
            yield
        finally:
            with self._lock:
                self._cancel_query = None

    def stop_query(self):
        with self._lock:
            if self._cancel_query is not None:
                with suppress(Exception):
                    self._cancel_query()

    def cancel(self):
        """Signal cancellation and report whether an admitted query can be interrupted."""
        if self.cancelled.is_set():
            return False
        self.cancelled.set()
        with self._lock:
            return self._cancel_query is not None


class Workers:
    def __init__(self, size, wait_seconds, run_seconds):
        self._pool = ThreadPoolExecutor(size, thread_name_prefix="search")
        self._cancellers = ThreadPoolExecutor(size, thread_name_prefix="cancel-query")
        self._slots = asyncio.Semaphore(size)
        self._wait_seconds = wait_seconds
        self._run_seconds = run_seconds
        self._active = {}

    def cancel(self, job):
        if job.cancel():
            self._cancellers.submit(job.stop_query)

    def cancel_session(self, session_id):
        for job in tuple(self._active.get(session_id, ())):
            self.cancel(job)

    async def run(self, fn, request_id, session_id=None):
        """Run one operation while retaining its slot through worker cleanup."""
        job = Job(request_id)
        if session_id is not None:
            self._active.setdefault(session_id, set()).add(job)
        try:
            try:
                await asyncio.wait_for(self._slots.acquire(), self._wait_seconds)
            except TimeoutError:
                raise Unavailable("Search worker capacity exhausted") from None
            loop = asyncio.get_running_loop()
            try:
                def invoke():
                    job.check()
                    return fn(job)

                task = loop.run_in_executor(self._pool, invoke)
            except BaseException:
                self._slots.release()
                raise

            def finish(completed):
                self._slots.release()
                if not completed.cancelled():
                    completed.exception()

            task.add_done_callback(finish)
            try:
                return await asyncio.wait_for(asyncio.shield(task), self._run_seconds)
            except TimeoutError:
                self.cancel(job)
                raise Unavailable("Search operation timed out") from None
            except asyncio.CancelledError:
                self.cancel(job)
                raise
        finally:
            if session_id is not None:
                jobs = self._active[session_id]
                jobs.remove(job)
                if not jobs:
                    del self._active[session_id]

    def close(self):
        self._pool.shutdown(wait=True, cancel_futures=True)
        self._cancellers.shutdown(wait=True, cancel_futures=True)


class ConnectionPool:
    """Lease exclusive connections and discard those that failed in use."""

    def __init__(self, factory, size, wait_seconds):
        self._factory = factory
        self._connections = LifoQueue(size)
        self._wait_seconds = wait_seconds
        for _ in range(size):
            self._connections.put(None)

    @contextmanager
    def lease(self):
        try:
            connection = self._connections.get(timeout=self._wait_seconds)
        except Empty:
            raise Unavailable("Storage connection capacity exhausted") from None
        try:
            if connection is None:
                connection = self._factory()
            yield connection
        except BaseException:
            if connection is not None:
                with suppress(Exception):
                    connection.close()
                connection = None
            raise
        finally:
            self._connections.put(connection)

    def close(self):
        while not self._connections.empty():
            connection = self._connections.get_nowait()
            if connection is not None:
                connection.close()


def log_query(job, operation, started, query_id, stats):
    """Record query timings and identifiers without logging SQL or values."""
    LOG.info("request_id=%s operation=%s elapsed_ms=%.1f query_id=%s queued_ms=%s "
             "server_elapsed_ms=%s processed_rows=%s processed_bytes=%s",
             job.request_id, operation, (time.monotonic() - started) * 1000, query_id or "-",
             stats.get("queuedTimeMillis", "-"), stats.get("elapsedTimeMillis", "-"),
             stats.get("processedRows", "-"), stats.get("processedBytes", "-"))
