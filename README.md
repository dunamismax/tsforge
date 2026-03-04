# scripts

Reusable Python scripts and utilities.

## Structure

```
tools/      Permanent, reusable scripts — the good stuff
scratch/    One-offs, experiments, WIP — the messy workbench
lib/        Shared Python utilities (imported by tools/ scripts)
```

## Usage

Every script in `tools/` is standalone and directly runnable:

```bash
python3 tools/<script>.py [args]
```

## Tools

### emltpl_to_oft.py

Convert macOS `.emltpl` email templates to Windows Outlook `.oft` format.

Builds valid OLE2 Compound File Binary (CFB) files from scratch following the [MS-OXMSG](https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxmsg/) specification. Pure Python — no third-party dependencies.

```bash
# Convert all .emltpl files in a directory
python3 tools/emltpl_to_oft.py /path/to/templates/

# Convert to a specific output directory
python3 tools/emltpl_to_oft.py /path/to/templates/ /path/to/output/

# Convert a single file
python3 tools/emltpl_to_oft.py /path/to/template.emltpl
```

## Development

Requires Python 3.12+. Linting and formatting via [ruff](https://docs.astral.sh/ruff/):

```bash
ruff check .        # lint
ruff format .       # format
```

## License

[MIT](LICENSE)
