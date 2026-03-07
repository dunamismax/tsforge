from __future__ import annotations

import argparse
from collections.abc import Sequence
from pathlib import Path

from .parser import convert_emltpl


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="emltpl-to-oft",
        description="Convert .emltpl email templates to Outlook .oft format.",
    )
    parser.add_argument(
        "input_path",
        type=Path,
        help="Path to a single .emltpl file or a directory containing them.",
    )
    parser.add_argument(
        "output_dir",
        nargs="?",
        type=Path,
        help="Optional destination directory for generated .oft files.",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)

    input_path = args.input_path
    output_dir = args.output_dir

    if input_path.is_file():
        emltpl_files = [input_path]
    elif input_path.is_dir():
        emltpl_files = sorted(input_path.glob("*.emltpl"))
        if not emltpl_files:
            print(f"No .emltpl files found in {input_path}")
            return 1
    else:
        print(f"Not found: {input_path}")
        return 1

    if output_dir:
        output_dir.mkdir(parents=True, exist_ok=True)

    succeeded = 0
    failed = 0

    for emltpl in emltpl_files:
        dest_dir = output_dir or emltpl.parent
        oft_path = dest_dir / f"{emltpl.stem}.oft"

        try:
            convert_emltpl(emltpl, oft_path)
            size_kb = oft_path.stat().st_size / 1024
            print(f"  OK  {emltpl.name}  ->  {oft_path.name} ({size_kb:.1f} KB)")
            succeeded += 1
        except Exception as exc:
            print(f"  FAIL  {emltpl.name}: {exc}")
            failed += 1

    print()
    print(f"Done: {succeeded} converted, {failed} failed")
    return 0 if failed == 0 else 1
