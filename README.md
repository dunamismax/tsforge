# tsforge

`tsforge` is a Bun-first TypeScript monorepo for converting macOS `.emltpl` email
templates into Outlook `.oft` files, with a TanStack Start workbench layered on top of
the converter core.

## Stack

- Runtime: Bun
- Package manager / workspace: Bun
- Language: TypeScript
- Validation / contracts: Zod
- Web app: TanStack Start + TanStack Router + TanStack Query
- Database: PostgreSQL + Drizzle ORM
- Auth: Better Auth
- Observability: OpenTelemetry
- Lint / format: Biome
- Tests: Vitest

## Workspace layout

```text
apps/web/             TanStack Start workbench for uploads, auth, and history
apps/cli/             Bun CLI for single-file and directory conversion
packages/contracts/   Shared Zod contracts used across app and CLI
packages/converter/   TypeScript port of the CFB/MAPI/OFT converter core
packages/db/          Drizzle schema, client, and migrations
packages/observability/ OpenTelemetry bootstrap and span helpers
scratch/              Disposable workbench area for experiments
```

## What changed from `pyforge`

- The Python package and compatibility shims are gone.
- The `.emltpl` to `.oft` conversion logic was ported into `@tsforge/converter`.
- CLI parity was preserved in `apps/cli`.
- A new TanStack Start app now exposes the converter with Better Auth-backed history and
  Drizzle persistence.

## Local development

```bash
bun install
bun run dev
```

Open the workbench at `http://localhost:3000`.

## CLI usage

```bash
bun run apps/cli/src/bin.ts /path/to/template-or-directory [output_dir]
```

The CLI preserves the original behavior:

- A single `.emltpl` writes an `.oft` next to the source file unless `output_dir` is provided.
- A directory input converts all top-level `*.emltpl` files in sorted order.

## Environment

Create a `.env` from `.env.example`.

- `DATABASE_URL` and `BETTER_AUTH_SECRET` are required for auth and persisted history.
- The converter itself and the CLI work without database credentials.

## Verification

```bash
bun run test
bun run check
bun run build
```

## License

[MIT](LICENSE)
