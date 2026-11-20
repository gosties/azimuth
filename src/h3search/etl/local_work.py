"""Bounded lease heartbeats for private, unpublished local work only."""
from threading import Lock
from time import monotonic


class LocalWorkGuard:
    def __init__(self, full, local, interval=0.25):
        self.full, self.local, self.interval = full, local, interval
        self.lock = Lock()
        self.deadline = 0.0
        self.failure = None

    def _check(self, force):
        # Cancellation remains immediate, including between database heartbeats.
        self.local()
        with self.lock:
            if self.failure is not None:
                raise self.failure
            if force or monotonic() >= self.deadline:
                try:
                    self.full()
                except BaseException as error:
                    self.failure = error
                    raise
                self.deadline = monotonic() + self.interval

    def __call__(self):
        self._check(False)

    def full_check(self):
        self._check(True)


def local_work_guard(guard, settings):
    if isinstance(guard, LocalWorkGuard):
        return guard
    cached = getattr(guard, 'local_work', None)
    if cached is not None:
        return cached
    local = getattr(guard, 'local_check', None)
    # Opaque callers may include cancellation in their lease callback: never delay it.
    if local is None:
        return guard
    result = LocalWorkGuard(guard, local, settings.local_lease_heartbeat_sec)
    guard.local_work = result
    return result


def local_bounds(bounds, local):
    if getattr(bounds, '_local_work_bound', False):
        return
    resource = bounds.check
    def check(**options):
        local()
        return resource(**options)
    bounds.check = check
    bounds._local_work_bound = True
