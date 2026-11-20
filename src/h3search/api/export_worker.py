"""Dedicated, serialized export service sharing the API's durable spool."""

import argparse
import logging
import signal
from threading import Event

from h3search.config import Settings
from h3search.control import Registry

from .exports import Exports


def main():
    parser = argparse.ArgumentParser(description="Run the Azimuth export worker")
    parser.add_argument("--config", help="Settings TOML (or H3SEARCH_CONFIG)")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    settings = Settings.load(args.config)
    registry = Registry(settings)
    registry.initialize()
    stopping = Event()
    for name in ("SIGINT", "SIGTERM"):
        signal.signal(getattr(signal, name), lambda *_: stopping.set())
    manager = Exports(settings, registry, worker=True)
    try:
        logging.getLogger(__name__).info("Export worker ready")
        while not stopping.wait(0.5):
            for future in manager.futures:
                if future.done():
                    future.result()
                    raise RuntimeError("Export worker exited unexpectedly")
    finally:
        manager.close()


if __name__ == "__main__":
    main()
