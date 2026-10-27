# Changelog

## 2.0.0 - 2026-10-26

### Changed

- Support maintained Node 22/24/26; update pnpm, p-limit and Node types.
- Replace deprecated fluent-ffmpeg with the native FFmpeg/FFprobe CLI. Remove old binary installers, wrapper types and rimraf; applications supply current system binaries or explicit paths.
- Make executable paths independent per generator and preserve established scale/timestamp semantics.
- Use atomic PNG output and bounded subprocess diagnostics; await process termination before cleanup.
- Update CI, package-consumer verification, requirements and migration instructions.
- Add Oxlint and Prettier checks for source, tests, scripts, examples and documentation, enforced in CI and release verification.

### Fixed

- Detect media containers from file content rather than forcing a demuxer from an extension.
- Reject missing/invalid output frames and preserve existing outputs on failure or cancellation.
- Validate timeout ranges, media options and portable filenames; reject shared batch filenames.
- Cancel queued work promptly, preserve custom cancellation reasons, and retain bounded concurrency.
- Cancel failed HTTP response bodies, detect streaming timeouts correctly and unify download cleanup.
