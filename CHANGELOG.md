# Changelog

## v0.12.7 - 2026-09-01

- Added Codex Desktop IPC wire-v2 delivery with a bounded v1 fallback only
  after an explicit non-dispatch result.
- Added exact-thread activation and one-retry recovery when the Desktop owner
  is absent or exposes no compatible turn handler.
- Made graceful stop idempotent when the bridge removes its PID during exit.
- Added one external package for clean install, preserve-config upgrade, and
  recoverable repair installation.
- Added package allowlisting, extracted-package smoke tests, SHA256/manifest
  read-back, and external-content privacy scanning.
- Verified 117 automated tests before the open-source repository migration.

Receiving-device live acceptance remains separate from package verification.
