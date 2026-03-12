# tsforge

`tsforge` is a Bun-first TypeScript forge for scripts, utilities, scratch work, and
small tools that are worth keeping around.

The email template converter is still here, but it is now just one of the repo's tools
instead of the repo's entire identity. New durable scripts should land in `scripts/`,
shared logic in `packages/`, optional interfaces in `apps/`, and rough experiments in
`scratch/`.

## Current tool catalog

- `scripts/email-template-converter/` converts macOS `.emltpl` email templates into
  Outlook `.oft` files
- `scripts/batch-grade/` batch-applies LUTs to video folders with `ffmpeg` and `ffprobe`
- `apps/web/` is a TanStack Start workbench for the email template converter

## Workspace layout

```text
apps/web/                       Optional UI/workbench surfaces
packages/contracts/            Shared Zod contracts
packages/converter/            Shared email-template conversion core
packages/db/                   Drizzle schema, client, and migrations
packages/observability/        OpenTelemetry bootstrap and span helpers
scripts/email-template-converter/ Durable Bun CLI utilities
scripts/batch-grade/           Video grading utility
luts/                          Shared LUT assets for video scripts
scratch/                       Playground and temporary experiments
```

## Repo conventions

- Put stable standalone CLIs in `scripts/<tool-name>/`
- Keep each script self-describing with a local `README.md`
- Pull reusable logic into `packages/` only after it earns reuse
- Use `apps/` for interfaces or services that sit on top of script/package logic
- Keep `scratch/` messy on purpose, then promote useful code into `scripts/` or
  `packages/`

## Quick start

```bash
bun install
```

Run the email template converter:

```bash
bun run script:email-template -- /path/to/template-or-directory [output_dir]
```

Run the batch LUT grading tool:

```bash
bun run script:batch-grade -- [options] [inputDir] [outputDir] [lutFile]
```

Start the web workbench:

```bash
bun run dev:web
```

Open the workbench at `http://localhost:3000`.

## Environment

Create a `.env` from `.env.example` if you want to run the web app.

- `DATABASE_URL` and `BETTER_AUTH_SECRET` are required for auth and persisted history
- The standalone scripts work without database credentials

## Verification

```bash
bun run test
bun run check
bun run build
```

## License

[MIT](LICENSE)
