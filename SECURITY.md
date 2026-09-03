# Security Policy

## Supported versions

Security fixes are applied to the latest published release only.

## Deployment boundary

This bridge is designed for one trusted operator, one allowlisted Feishu/Lark
P2P identity, and one exact local Codex controller binding. The controller uses
an unattended full-access execution profile. Deploying it for untrusted users,
group chats, or a broadly shared application is outside the supported model.

Never commit or attach:

- app secrets, tokens, cookies, OAuth material, or recovery credentials;
- complete user, chat, message, or Codex thread IDs;
- private configuration, state, logs, attachments, or message bodies;
- machine-specific runtime paths containing a real Windows username.

Private runtime belongs under
`%USERPROFILE%\.codex\private\lark-im-codex-bridge` and is excluded from the
release package.

## Reporting a vulnerability

Do not open a public issue containing exploit details or private data. Use the
repository's GitHub private vulnerability reporting feature. Include the
affected version, reproduction conditions, impact, and the smallest redacted
evidence needed to validate the report.

## Acceptance boundary

Passing source tests or package checks does not prove a receiving device is
secure or operational. Verify exact binding, one consumer, clean health, and a
real P2P round trip on each device.
