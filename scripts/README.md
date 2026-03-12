# scripts/

Durable TypeScript scripts and CLI-sized tools live here.

## Conventions

- One tool per folder
- Give each tool a `README.md` with usage and requirements
- Keep the entrypoint in `src/bin.ts` when the tool is a CLI
- Add tests when the tool can be verified without heavyweight external setup
- Move shared helpers into `packages/` only when another script or app needs them

## Current scripts

- `email-template-converter/`
- `batch-grade/`
