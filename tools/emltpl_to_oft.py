#!/usr/bin/env -S uv run python
"""
emltpl_to_oft.py - Convert macOS .emltpl email templates to Windows .oft format.

Creates valid OLE2 Compound File Binary (CFB) files following the MS-OXMSG
specification for Outlook Template (.oft) files.

Usage:
    uv run python tools/emltpl_to_oft.py <input_dir_or_file> [output_dir]

    If output_dir is omitted, .oft files are placed alongside .emltpl files.

Dependencies: Python 3.12+ (stdlib only, no third-party packages)

References:
    - [MS-CFB]   Compound File Binary File Format
    - [MS-OXMSG] Outlook Item (.msg) File Format
"""

from __future__ import annotations

import sys
from pathlib import Path


def main() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    repo_root_str = str(repo_root)
    if repo_root_str not in sys.path:
        sys.path.insert(0, repo_root_str)

    from lib.emltpl_to_oft import main as run_main

    run_main()


if __name__ == "__main__":
    main()
