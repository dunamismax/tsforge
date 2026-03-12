# Email Template Converter

Converts macOS `.emltpl` files into Outlook `.oft` files.

## Usage

```bash
bun run script:email-template -- /path/to/template-or-directory [output_dir]
```

You can also run the package directly:

```bash
bun run --filter @tsforge/email-template-converter start -- /path/to/template-or-directory [output_dir]
```

## Behavior

- A single `.emltpl` writes an `.oft` next to the source file unless `output_dir` is
  provided
- A directory input converts all top-level `*.emltpl` files in sorted order
- Shared conversion logic lives in `packages/converter/`
