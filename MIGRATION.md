# Migrating to 2.0

- Use maintained Node 22, 24 or 26. Minimum supported patches are 22.18.0 and 24.11.0.
- Install a current FFmpeg release and its matching FFprobe. Version 2 calls their CLI directly and no longer downloads or bundles binaries. Put both on PATH, or pass `ffmpegPath` and `ffprobePath`. FFprobe is used only for percentage timestamps. Missing tools raise `ThumbnailGenerationError` with the underlying spawn error as its cause.
- Executable paths now belong to each generator instance. Different generators can use different binaries without affecting one another.
- Existing generation methods, streamed downloads, bounded concurrency, sizes, timestamps and cancellation reasons remain supported. Clock timestamps (`MM:SS` / `HH:MM:SS`) are supported alongside seconds and percentages.
- Invalid sizes, timestamps, non-portable/empty filenames and a shared filename for a multi-item batch are rejected explicitly. Download timeouts must be positive integers within the native timer range.
- Failed or cancelled generation no longer leaves partial final files or destroys an existing named thumbnail. Completed PNGs replace the destination only after validation. Requests beyond the last video frame fail with a typed error rather than returning a nonexistent path.
- Contributors use pnpm 12.15.0 and TypeScript 7. `pnpm run verify` includes declarations and an installation from the actual package archive.
