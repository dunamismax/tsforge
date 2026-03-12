# Build and verification notes

This repo is now a pnpm workspace built around Bun, TypeScript, and TanStack Start.

## Current package contract

- `packages/converter` owns the `.emltpl` to `.oft` binary conversion logic.
- `apps/cli` stays thin and preserves the original single-file / directory workflow.
- `apps/web` is the full-stack workbench for uploads, auth, and conversion history.
- Shared payloads must flow through `packages/contracts`.
- Drizzle schema and migrations live in `packages/db`.

## Current verification commands

```bash
pnpm test
pnpm check
pnpm build
pnpm --filter @tsforge/db db:generate
```

## Runtime expectations

- Bun runs the workspace scripts and the CLI entrypoint.
- `DATABASE_URL` and `BETTER_AUTH_SECRET` are required for Better Auth and Drizzle-backed
  history.

## Current concrete utility

- The converter still builds OLE2 / CFB and MAPI data directly.
- The TypeScript port preserves the tested codepage, attachment, and large-FAT behavior from
  the original Python implementation.
