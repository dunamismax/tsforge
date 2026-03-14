# Signal Fit

Fits a single video file under Signal's 100 MB file size limit with Bun, `ffmpeg`, and `ffprobe`.

## Requirements

- `bun`
- `ffmpeg`
- `ffprobe`

## Usage

Interactive:

```bash
bun run script:signal-fit
```

Then drag a video file into the terminal window and press Enter.

Explicit path:

```bash
bun run script:signal-fit -- "/path/to/video.mov"
```

Dry run:

```bash
bun run script:signal-fit -- --dry-run "/path/to/video.mov"
```

## Behavior

- Files already under the limit are remuxed with `-c copy` into a sibling file
- Larger files are re-encoded into MP4
- Output files are written into the same folder as the source file
- The default target is `99.0 MB`, leaving `1.0 MB` of safety headroom under Signal's `100 MB` limit
- The script prefers `libx265` for better quality-per-byte and falls back to `libx264` if needed

## Output names

- `My Clip.mov` -> `My Clip_signal.mov`
- `My Clip.mov` -> `My Clip_signal.mp4` when re-encoding is required
- If a matching output already exists, the script creates `My Clip_signal-2.mp4`, `My Clip_signal-3.mp4`, and so on

## Optional tuning

- `TSFORGE_SIGNAL_FIT_PRESET=slow bun run script:signal-fit` trades more time for slightly better compression
