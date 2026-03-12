# Build and verification notes

`tsforge` is a Bun workspace for durable TypeScript scripts, supporting packages, and
optional app surfaces.

## Workspace contract

- `scripts/*` contains standalone CLIs and script-sized utilities
- `packages/*` contains shared code used by one or more scripts/apps
- `apps/*` contains interfaces or services layered on top of packages/scripts
- `scratch/` is intentionally disposable and does not define the repo's structure
- `luts/` is shared asset storage for video-related scripts

## Current verification commands

```bash
bun run test
bun run check
bun run build
bun run db:generate
```

## Runtime expectations

- Bun runs the workspace scripts and CLI entrypoints
- `ffmpeg` and `ffprobe` are required for `scripts/batch-grade`
- `DATABASE_URL` and `BETTER_AUTH_SECRET` are required only for `apps/web`

## Current shared core

- `packages/converter` still builds OLE2 / CFB and MAPI data directly
- The email template conversion port preserves the tested codepage, attachment, and
  large-FAT behavior from the original Python implementation
