# CLAUDE.md

Agent instructions for this repo live in the canonical grimoire config:

- **Identity / voice:** `~/github/grimoire/SOUL.md`
- **Operations / workflow:** `~/github/grimoire/AGENTS.md`

Do not duplicate agent instructions here. Read the canonical files.

## Repo-Specific

- **Language:** Python only. No TypeScript, no shell scripts.
- **Style:** `ruff` for linting and formatting. Run `ruff check .` and `ruff format .` before committing.
- **Structure:** Reusable scripts in `tools/`. Experiments and one-offs in `scratch/`. Shared code in `lib/`.
- **Scripts must be standalone.** Each script in `tools/` should be directly runnable with `uv run python tools/<name>.py`. Import from `lib/` only when genuinely shared logic exists.
- **No unnecessary dependencies.** Prefer stdlib. When a third-party dep is needed, document it in the script's docstring and in the README.
- **Docstrings required.** Every script needs a module docstring with purpose, usage, and dependency info.
- **Git:** No AI attribution. Commit as dunamismax. Force-push to main (dual remotes).
