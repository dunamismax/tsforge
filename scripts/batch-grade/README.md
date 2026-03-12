# Batch Grade

Batch-applies a LUT to a folder of video files with Bun, `ffmpeg`, and `ffprobe`.

## Requirements

- `bun`
- `ffmpeg`
- `ffprobe`

## Usage

Interactive:

```bash
bun run script:batch-grade
```

Explicit paths:

```bash
bun run script:batch-grade -- "/path/to/input" "/path/to/output" "/path/to/lut.cube"
```

Dry run:

```bash
bun run script:batch-grade -- --dry-run "/path/to/input" "/path/to/output" "/path/to/lut.cube"
```

## Profiles

- `source-match` keeps HEVC/MP4 output close to the source bitrate when possible
- `source-match-software` does the same job with `libx265`
- `edit` writes `ProRes 422 MOV`
- `edit-hq` writes `ProRes 422 HQ MOV`

## Shared assets

- Bundled LUTs live under `luts/`
- You can still point the script at any custom LUT path
