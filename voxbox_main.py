#!/usr/bin/env python3
"""VoxBox CLI entry point."""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from voxbox.app import VoxBoxApp
from voxbox.config import CONFIG_PATH, DATA_DIR, ensure_config_exists, load_config


def _setup_logging(verbose: bool) -> None:
    log_dir = DATA_DIR / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / "voxbox.log"

    level = logging.DEBUG if verbose else logging.INFO
    handlers: list[logging.Handler] = [
        logging.StreamHandler(sys.stderr),
        logging.FileHandler(log_file, encoding="utf-8"),
    ]
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
        handlers=handlers,
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="voxbox",
        description="VoxBox — Fast, 100% offline GPU Hold-to-Talk AI Voice Dictation for Linux Wayland",
    )
    parser.add_argument("-c", "--config", type=Path, default=CONFIG_PATH, help="Path to config.toml")
    parser.add_argument("-v", "--verbose", action="store_true", help="Enable debug logging")
    parser.add_argument("--open", action="store_true", help="Open the VoxBox Hub window")
    parser.add_argument("--init-config", action="store_true", help="Create default config.toml and exit")
    args = parser.parse_args()

    if args.init_config:
        path = ensure_config_exists(args.config)
        print(f"Config ready at: {path}")
        return 0

    _setup_logging(args.verbose)
    cfg = load_config(args.config)
    app = VoxBoxApp(cfg, open_hub_on_start=args.open)
    return app.run()


if __name__ == "__main__":
    raise SystemExit(main())
