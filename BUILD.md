# Build and verification notes

This repo is being kept as a durable Python tooling repo, not a one-off converter dump.

## Current package contract

- Reusable code lives under `pyforge/`.
- Stable runnable entrypoints stay in `tools/`.
- `lib/` remains only as a local compatibility shim for older imports.
- The package entrypoint is `python -m pyforge.emltpl_to_oft`.

## Current verification commands

```bash
UV_CACHE_DIR=/tmp/uv-cache uv run ruff check .
UV_CACHE_DIR=/tmp/uv-cache uv run ruff format --check .
UV_CACHE_DIR=/tmp/uv-cache uv run python -m unittest discover -s tests
UV_CACHE_DIR=/tmp/uv-cache uv run python tools/emltpl_to_oft.py <input.emltpl> <output_dir>
```

## Current concrete utility

- `emltpl_to_oft` converts macOS `.emltpl` templates into Outlook `.oft`.
- The converter remains stdlib-only and builds CFB/MAPI data directly.
- Parser, CLI, CFB, and MAPI concerns are intentionally split so future tools can share implementation patterns without importing a monolithic script.
