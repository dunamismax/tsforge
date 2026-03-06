from __future__ import annotations

import sys
from pathlib import Path

from .parser import convert_emltpl


def main() -> None:
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <input_dir_or_file> [output_dir]")
        print()
        print("Convert .emltpl email templates to Outlook .oft format.")
        print()
        print("  input_dir_or_file  Path to a single .emltpl or directory of them")
        print("  output_dir         (optional) Output directory for .oft files")
        print("                     Defaults to same directory as each .emltpl")
        sys.exit(1)

    input_path = Path(sys.argv[1])
    output_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else None

    if input_path.is_file():
        emltpl_files = [input_path]
    elif input_path.is_dir():
        emltpl_files = sorted(input_path.glob("*.emltpl"))
        if not emltpl_files:
            print(f"No .emltpl files found in {input_path}")
            sys.exit(1)
    else:
        print(f"Not found: {input_path}")
        sys.exit(1)

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
