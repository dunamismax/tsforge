# pyforge

`pyforge` is a small Python tooling repo intended to grow over time.

It is not a general-purpose framework, and it is not limited to one email conversion workflow either. The repo houses durable Python utilities, the reusable library code behind them, and a scratch area for one-off experiments that have not earned a permanent place yet.

## Current scope

Today the repo contains one production utility:

- `tools/emltpl_to_oft.py`: converts macOS `.emltpl` email templates to Windows Outlook `.oft` files.

The converter builds OLE2 Compound File Binary data directly and stays stdlib-only. Its reusable implementation lives under the `pyforge/` package so future tools can share code without turning the repo into a pile of standalone scripts.

## Layout

```text
pyforge/    Reusable Python package code used by durable tools
tools/      Stable runnable entrypoints
tests/      Regression tests for reusable behavior and tool workflows
scratch/    Temporary experiments and one-offs
lib/        Legacy compatibility shim for older local imports
```

## Running the current tool

The existing in-repo entrypoint remains:

```bash
uv run python tools/emltpl_to_oft.py /path/to/template-or-directory [output_dir]
```

The package code is also directly runnable:

```bash
uv run python -m pyforge.emltpl_to_oft /path/to/template-or-directory [output_dir]
```

## Development

Requires Python 3.12+.

```bash
UV_CACHE_DIR=/tmp/uv-cache uv run ruff check .
UV_CACHE_DIR=/tmp/uv-cache uv run ruff format --check .
UV_CACHE_DIR=/tmp/uv-cache uv run python -m unittest discover -s tests
```

## Working standard

- Put reusable implementation in `pyforge/`.
- Keep `tools/` thin and runnable.
- Treat `scratch/` as disposable until code proves it should move up.
- Add or extend tests when behavior becomes part of the repo contract.

## License

[MIT](LICENSE)
