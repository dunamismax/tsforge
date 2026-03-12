# CLAUDE.md

Agent instructions for this repo live in the canonical grimoire config:

- **Identity / voice:** `~/github/grimoire/SOUL.md`
- **Operations / workflow:** `~/github/grimoire/AGENTS.md`

Do not duplicate agent instructions here. Read the canonical files.

## Repo-Specific

- **Language:** TypeScript first. Bun runtime and workspace.
- **Structure:** Shared logic belongs in `packages/`. Product surfaces belong in `apps/`. `scratch/` is still disposable.
- **Core split:** Keep binary conversion behavior in `packages/converter`, not inside the web app.
- **Validation:** Use Zod for cross-boundary contracts.
- **Quality bar:** Run `bun run check`, `bun run test`, and `bun run build` before landing non-trivial changes.
- **Infra assumptions:** Better Auth and Drizzle should degrade cleanly when env is missing instead of crashing unrelated converter flows.
- **Git:** No AI attribution. Commit as dunamismax.
