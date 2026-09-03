# Feishu Codex Bridge

An unofficial, Windows-focused bridge that transports authorized Feishu/Lark
private messages to one exact, Desktop-visible local Codex controller and sends
the correlated turn result back to the same conversation.

The bridge is deliberately **transport only**. It does not interpret business
intent, select tasks by title, create a second AI, or route work by semantics.

## Data flow

```text
authorized Feishu/Lark P2P message
  -> identity check, deduplication, attachments, FIFO
  -> one privately configured Codex thread ID and working directory
  -> Desktop-visible Codex turn
  -> correlated result
  -> reply to the originating Feishu/Lark message
```

## Security model

This project is intended for a single trusted operator and an allowlisted P2P
entry. The bound Codex controller runs with a static unattended full-access
profile. Do not expose the bot to groups, untrusted users, or a shared public
application. Keep credentials, thread IDs, message bodies, logs, attachments,
and runtime state outside the repository.

Read [SECURITY.md](SECURITY.md) before installation.

## Requirements

- Windows 10 or 11
- Codex Desktop
- Node.js LTS
- Feishu/Lark CLI and the required official skills
- A Feishu/Lark application configured for private-message events

## Install, upgrade, or repair

Download the complete archive from GitHub Releases and verify its SHA256 and
manifest before extracting the inner portable ZIP.

- New installation: follow [README-FIRST.md](README-FIRST.md).
- Existing healthy installation:
  `scripts/upgrade-or-repair-existing-computer.ps1 -Mode Upgrade`
- Existing modified or damaged installation:
  `scripts/upgrade-or-repair-existing-computer.ps1 -Mode Repair`

Upgrade and repair preserve the receiving device's private configuration and
state, archive the previous public source, and install clean release source.
They do not merge unknown local source edits.

## Verification

From `scripts`:

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm run preflight
.\health-check.ps1 -RequireClean -WaitSeconds 60
```

Package verification is not device acceptance. Each receiving computer still
needs a real private-message round trip and, when required, attachment,
resource-readback, FIFO, recovery, and physical-restart acceptance.

## Scope

Included: P2P text, image/file input, exact-thread binding, deduplication,
FIFO, recovery, hidden startup, one-consumer health, and sanitized diagnostics.

Not included: group routing, raw IM voice recognition, semantic task routing,
remote job management, confirmation codes, or a second reasoning agent inside
the bridge.

## Project status

Current release line: **v0.12.7**. See [CHANGELOG.md](CHANGELOG.md) and the
release assets for exact evidence. This project is not affiliated with or
endorsed by ByteDance, Feishu/Lark, or OpenAI.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
