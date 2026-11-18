"""Run job workers as their own process: `python -m astra_migrate.jobs [--workers N]`.

Locally the API process runs workers in threads (ASTRA_JOB_WORKERS). In Azure the API sets
ASTRA_JOB_WORKERS=0 and this process runs in its own container app, scaled on queue length.
"""

from __future__ import annotations

import argparse
import signal
import threading

from astra_migrate.jobs.runner import start_workers, stop_workers
from astra_migrate.logging import configure_logging
from astra_migrate.observability import configure_tracing


def main() -> None:
    parser = argparse.ArgumentParser(description="Astra Migrate job workers")
    parser.add_argument("--workers", type=int, default=2)
    args = parser.parse_args()
    configure_logging()
    configure_tracing("astra-migrate-worker")
    done = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: done.set())
    signal.signal(signal.SIGTERM, lambda *_: done.set())
    start_workers(args.workers)
    done.wait()
    stop_workers()


if __name__ == "__main__":
    main()
