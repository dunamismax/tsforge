# Current status

- Phase: review fixes in progress
- Last updated: 2026-03-05
- Latest relevant commit: uncommitted

# Phase plan

## 1. High severity

- [x] Fix CFB DIFAT emission for large FAT tables
- [x] Fix MIME charset handling and message codepage metadata

## 2. Medium severity

- [x] Add regression tests for CFB/MAPI writer behavior
- [ ] Reduce large-input memory copying during OFT generation

## 3. Low severity

- [ ] Align Python version and invocation docs
- [ ] Split parser, MAPI, CFB, and CLI concerns into separate modules

# Verification snapshot

- `UV_CACHE_DIR=/tmp/uv-cache uv run ruff check .`
- `UV_CACHE_DIR=/tmp/uv-cache uv run ruff format --check .`
- `UV_CACHE_DIR=/tmp/uv-cache uv run python -m unittest discover -s tests`
- Large-file smoke check confirmed `n_fat=130` now emits `first_difat=16515` and `n_difat=1`
- ISO-8859-1 smoke check confirmed body text stays `Olá\n` and `PidTagInternetCodepage=28591`
- Regression suite now covers DIFAT overflow, charset preservation, and attachment stream round-tripping

# Immediate next pass priorities

- Remove avoidable full-size sector-buffer copies for large regular streams.
