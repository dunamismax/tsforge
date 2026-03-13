# AGENTS.md

Agent instructions for this repo live in the canonical grimoire config:

- **Identity / voice:** `~/github/grimoire/SOUL.md`
- **Operations / workflow:** `~/github/grimoire/AGENTS.md`

Use the canonical files for shared behavior. This file is only for `tsforge`-specific
guidance.

## Repo Identity

- `tsforge` is a Bun-first TypeScript forge for durable scripts, utilities, coding
  experiments worth keeping, and small supporting apps.
- Do not treat it like a single-purpose email converter repo. The email converter is one
  tool in the forge, not the repo's identity.

## Preferred Layout

- `scripts/*` for durable standalone CLIs and utilities
- `packages/*` for shared logic that has earned reuse
- `apps/*` for optional interfaces or services layered on top of shared logic
- `luts/*` for shared LUT assets used by video-related scripts
- `scratch/` for disposable experiments and rough drafts

## Structure Rules

- Keep each durable script in its own folder under `scripts/`.
- Give each script a local `README.md` with requirements and usage.
- Keep CLI entrypoints in `src/bin.ts` when the tool is command-line driven.
- Only extract code into `packages/` when more than one script/app uses it or reuse is
  clearly imminent.
- Promote useful code out of `scratch/`; do not let `scratch/` become a second permanent
  workspace.

## Current Repo Anchors

- `packages/converter` owns the `.emltpl` to `.oft` conversion core.
- `scripts/email-template-converter` is the standalone CLI for the email converter.
- `scripts/batch-grade` is the batch LUT grading utility.
- `apps/web` is an optional workbench for the email converter, not the center of the repo.

## Technical Preferences

- TypeScript first. Bun runtime and Bun workspaces.
- Use Zod for contracts that cross boundaries.
- Keep reusable binary or processing logic out of UI code.
- Keep standalone scripts runnable without dragging in unrelated app or database concerns
  whenever possible.
- Better Auth and Drizzle concerns should degrade cleanly when environment variables are
  missing so unrelated scripts still work.

## Verification

- Run `bun run check`, `bun run test`, and `bun run build` before landing non-trivial
  changes.
- For script changes, run the relevant script command when practical.
- For changes that add assets or folders, make sure the README and top-level repo docs
  still describe the layout accurately.

## Git

- No AI attribution.
- Commit as `dunamismax`.
