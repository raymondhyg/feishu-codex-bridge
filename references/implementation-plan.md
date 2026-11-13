# External Release Operating Plan

This package supports three receiving-device paths: clean installation,
preserve-configuration upgrade, and recoverable repair installation.

The bridge is transport only. It binds one Desktop-native local controller by
an exact private thread ID and working directory. Titles never route messages.

Private configuration, state, credentials, logs, attachments, message bodies,
and device-specific identifiers are not part of this release. Upgrade and
repair preserve the receiving device's private runtime, archive its previous
public source, install the clean release source, and require device-local
preflight, health, and real Feishu acceptance.

Package verification does not prove receiving-device runtime acceptance.

## Desktop owner snapshot compatibility

Distinguish silence from incompatibility: first match the snapshot to the
exact conversation and host, then check the wire version. A matching
snapshot on an unsupported version is a protocol mismatch, not an absent
owner. Report the observed version and that the message was not dispatched;
do not activate, retry delivery, or fall back to headless delivery because of
this mismatch. If discovered during an already authorized activation, stop
verification without attempting another activation or delivery.

Treat a new wire version as unsupported until its snapshot and delivery
semantics are verified. Regression coverage must include the supported
versions, a future unknown version at both owner checks, and preservation of
the mismatch through recovery without a turn write. Real Feishu round trips
remain a separate deployment check.
