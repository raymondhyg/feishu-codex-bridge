---
name: lark-im-codex-bridge
description: >-
  Run, deploy, validate, or troubleshoot the Feishu/Lark Codex fixed-controller
  relay. Every authorized P2P message is transported to one
  privately bound local Codex controller task, and that exact turn result is
  transported back to Feishu. Use for relay lifecycle, binding, startup,
  health, recovery, attachment transport, and delivery failures. The bridge is
  not a secretary, planner, task router, confirmation engine, or second AI.
---

# Lark IM Codex Bridge

The Feishu/Lark Codex bridge is a lightweight two-way transport. One fixed local Codex task is
the only brain and the remote-control entry point.

External distribution baseline: **v0.12.7, fixed-controller-only**.
Source-computer local runtime: **v0.12.7, deployed and clean-health verified on
2026-09-01; Desktop IPC v2 probe passed; real P2P acceptance pending**.

The external baseline identifies the new-install, preserve-config upgrade, and
recoverable repair package. The source-computer
runtime is a separate evidence lane and may retain a newer proven local fix;
neither lane promotes the other without its own package or live acceptance
evidence.

## Only Supported Path

```text
authorized Feishu P2P message
  -> identity check, dedupe, attachment retention, FIFO queue
  -> one exact private Codex thread binding
  -> that local controller reasons and works
  -> exact result of the correlated turn
  -> reply to the same Feishu message
```

The binding is an exact full Codex thread ID stored only in private runtime
configuration. The visible task title is for humans and never participates in
routing.

For every ordinary authorized P2P message, preserve the user's text and
attachment references. Do not add a task code, confirmation code, preview,
summary, recommendation, or routing decision. Only `/help` and `/status` are
handled locally as transport diagnostics. Old-looking inputs such as `/codex`,
`/tasks`, `CJ-*`, `确认`, and `取消` are ordinary controller input.

The fixed controller runs with one static user-authorized envelope:
`danger-full-access` and approval policy `never`. The relay never varies cwd,
permissions, model, instructions, or target based on message content.
Normal deployment also requires Desktop-visible delivery. Headless App Server
fallback is disabled unless an operator explicitly selects diagnostic mode.
The bridge startup task does not prove Codex Desktop or the fixed-thread owner
is present after logon; unattended reboot use requires a separate real-message
acceptance on the receiving computer.

## Product Boundary

The relay owns only:

- allowlisted P2P validation and bot-message rejection;
- message deduplication and FIFO delivery;
- supported text normalization without semantic rewriting;
- attachment download, retention, size limits, and local paths;
- one fixed private controller binding;
- exact Feishu-message to Codex-turn correlation;
- delayed-processing acknowledgement, timeout, and recovery;
- one event consumer, scheduled startup, health, and sanitized diagnostics.

The local controller owns all understanding and work, including clarification,
task discovery, coordination, evidence gathering, confirmation decisions,
external writes, lifecycle actions, and final reporting.

The relay must never create a hidden conversation, choose another task, create
a replacement controller, run a secretary investigation, maintain remote jobs,
or operate Feishu Tasks. If the controller asks a question, transport the
question and the user's natural reply unchanged.

## Controller Delegation And Return Contract

This contract governs the fixed local controller, not the transport daemon.
When the controller delegates a Feishu-originated request to another Codex
thread:

1. Put the exact user wording or a clearly marked exact excerpt in a
   `user_original_words` block and treat it as the authoritative request.
2. Keep callback ID, completion trigger, report fields, ownership, evidence,
   and safety metadata in a separate block that is explicitly not user words.
   Add controller interpretation only when necessary, label it
   non-authoritative, and do not add business judgment or execution authority.
3. After native thread delivery returns `Sent`, finish the current Feishu reply
   and release the controller. Do not wait, poll, or chase by default.
4. Require the receiver to work independently and proactively send one complete
   callback card to the declared controller thread when the completion trigger
   is met. Allow interim reports only for a decision blocker, declared timeout,
   or safety/privacy/destructive risk.
5. On callback, verify the cited evidence. When the user authorized a Feishu return,
   proactively send one concise report through that authorized Feishu channel.
   Require a returned write result or read-back before marking
   `Feishu reported`; otherwise record `Feishu report blocked / Not verified`
   and retain the completion card.

These controller actions do not add another brain to the bridge and do not
authorize the daemon to interpret, route, monitor, or report business work.

## Required Companion Skills

Before external operation, read `lark-shared`, `lark-event`, and `lark-im` for
transport identity, consumer lifecycle, replies, and attachments. If the fixed
controller will work with personal Feishu resources, it must also read the
relevant `lark-doc`, `lark-drive`, `lark-task`, `lark-vc`, `lark-minutes`, and
`lark-note` skills. Bot/user identity readiness and skill presence are only
prerequisites; transport needs preflight/health/live proof, and each personal
resource operation needs its own minimal API read-back.

For a fresh Windows computer, also read
`README-FIRST.md` and `references/new-computer-deployment-guide.md`.

## Canonical Files

- `README-FIRST.md`: receiving-Codex entry and non-negotiable route.
- `scripts/bridge.mjs`: relay daemon and recovery loop.
- `scripts/bridge-core.mjs`: current-only config, state, routing, and redaction.
- `scripts/bridge-process-identity.ps1`: shared Windows PID identity check used
  by start, stop, and health so a reused PID cannot impersonate the bridge.
- `scripts/fixed-controller-relay.mjs`: exact fixed-thread turn lifecycle.
- `scripts/codex-desktop-ipc.mjs`: preferred visible Codex Desktop transport.
- `scripts/codex-app-server.mjs`: narrow App Server fallback and status client.
- `scripts/controller-thread-tool.mjs`: optional controller-side `list`, `read`,
  and exact `send-and-wait`; it is not part of the daemon's ordinary path.
- `scripts/configure-fixed-controller-relay.mjs`: canonicalize or rebind the
  private fixed-controller configuration without printing the binding.
- `scripts/start-bridge.ps1`, `stop-bridge.ps1`, `health-check.ps1`: lifecycle.
- `scripts/install-startup-task.ps1`: current-user logon startup.
- `scripts/run-bridge-hidden.js`: windowless Windows Script Host entry that avoids
  Windows Terminal delegation before PowerShell can apply its hidden flag.
- `scripts/bootstrap-prerequisites.ps1`: read-only fresh-machine readiness
  report, with an explicit switch for the current official CLI/skill installer.
- `scripts/prepare-new-computer.ps1`: fixed-only clean install.
- `scripts/upgrade-or-repair-existing-computer.ps1`: preserve-config upgrade
  or recoverable clean-source repair for an existing canonical installation.
- `scripts/build-portable-package.ps1`: current-only release allowlist,
  manifest/hash generation, extracted smoke test, and published read-back.

Private configuration, state, logs, and attachments live under:

```text
%USERPROFILE%\.codex\private\lark-im-codex-bridge
```

Never print or package that directory, credentials, full user/chat/thread IDs,
raw message text, or Codex authentication data.

## Routine Operation

Run from `scripts`:

```powershell
npm run health
```

A healthy current service must report:

- `ok: true`;
- `service_healthy: true`;
- `bridge_version: 0.12.7` for the local compatibility source line after deployment;
- `bridge_pid_identity: bridge`;
- `state_schema: 6`;
- `relay_mode: fixed-controller-only`;
- `fixed_controller_target_readable: true`;
- `desktop_visibility: require`;
- `active_consumers: 1`;
- pending counts separately. For install/upgrade acceptance, run
  `health-check.ps1 -RequireClean -WaitSeconds 60` and require
  `acceptance_clean: true`.

Supported Windows starts must go through `start-bridge.ps1` (directly, through
`npm start`, or through the scheduled-task launcher). Do not use
`node bridge.mjs` as an operating entry point; the PowerShell entry verifies a
stale or reused PID before any launch.

Graceful restart:

```powershell
.\stop-bridge.ps1
lark-cli event status --json
# Wait until the old scheduled-task instance returns to Ready; IgnoreNew can
# otherwise discard an immediate restart request.
while ((Get-ScheduledTask -TaskName "Codex-Lark-IM-Bridge").State -ne "Ready") {
    Start-Sleep -Milliseconds 500
}
Start-ScheduledTask -TaskName "Codex-Lark-IM-Bridge"
npm run health
```

If `event status` still shows an orphan after the bridge has exited, run
`lark-cli event stop --all`, verify zero consumers, and start once. Do not use a
forced kill for normal recovery.

## Desktop Delivery Failure Recovery

Codex Desktop 26.825 upgraded `thread-follower-start-turn` from wire version 1
to version 2 and replaced `turnStartParams` with `turnStart.request/context`.
The bridge must try the v2 owner request first. It may use the v1 owner request
only after v2 returned the explicit `no-client-found / not_dispatched` result;
timeouts or unknown outcomes never permit a protocol fallback. If both versions
return explicit non-dispatch, classify the result as
`desktop_ipc_no_turn_handler`, not as an owner change.

When a local Desktop message cannot be delivered to the fixed controller, treat
loss of the active controller context as the first recovery hypothesis.

Recovery order:

1. Resolve the exact privately bound controller thread ID. Any user-visible
   title or spoken alias is only a human label and never a routing key.
2. Only after the first attempt returns
   `desktop_ipc_no_owner / not_dispatched`, open
   `codex://threads/<exact-private-id>` through the registered Windows protocol.
   The title is only a human confirmation label and must never replace exact-ID
   routing.
3. Do not treat the protocol launch as activation proof. Poll the Desktop IPC
   owner snapshot for that exact thread and require a verified owner before any
   retry.
4. Retry the original failed message unchanged at most once, preserving the
   same input array, attachment and local-image references,
   `clientUserMessageId`, permissions, deduplication, and FIFO position. Do not
   re-enqueue, summarize, rewrite, or create a replacement/hidden thread.
   If the bridge restarts after `activation_requested` but before
   `activation_verified`, re-verify only the exact owner without opening the
   protocol a second time; fail closed if that proof cannot be restored.
5. Keep activation and receipt evidence separate:
   `activation_requested -> activation_verified -> dispatching ->
   turn_start_receipt_verified`. The internal `receiptVerified` field means only
   that the exact start returned a turn ID; activation and a start receipt are
   not the final turn result.
6. Never activate after an unknown dispatch outcome, an owner-busy or
   owner-changed result, or when this message has already consumed its persisted
   recovery-dispatch allowance. Consume that allowance immediately before the
   Desktop IPC write marker, not while checking whether the owner is ready.
   Owner-busy checks may keep the same FIFO position only within the smaller of
   the controller timeout and five minutes, with a 300-check hard cap; they do
   not consume the allowance or dispatch a duplicate turn.
7. If activation or receipt cannot be verified, preserve the failure record
   until the correlated failure reply is confirmed, then close the pending
   record cleanly. Do not leave a processed message counted as pending, retry
   indefinitely, fan out the message, or claim it was delivered.

This is a recovery path for a failed local delivery. It does not change the
ordinary fixed-controller-only route and does not authorize switching to a
different thread by title, recency, workspace, or semantic similarity.

## Change And Rebind Gate

Before replacing code or dependencies:

1. confirm `pending_fixed_relays = 0` and `pending_replies = 0`;
2. stop gracefully and verify zero consumers;
3. preserve a source snapshot and a private config/state rollback copy;
4. update code or the exact private binding;
5. run `npm ci`, `npm run check`, `npm test`, and `npm run preflight`;
6. start once, run `npm run health`, then perform one real P2P read-back.

To keep the existing binding while removing stale config fields:

```powershell
node .\configure-fixed-controller-relay.mjs
```

To rebind, pass one exact private thread ID and its verified absolute Desktop
task working directory locally:

```powershell
node .\configure-fixed-controller-relay.mjs "<EXACT_THREAD_ID>" "<EXACT_CONTROLLER_CWD>"
```

Then complete the full preflight, health, and harmless live read-back chain.
Never match by title, recent order, workspace, or semantic similarity. A
user-visible task must be created through Codex Desktop's native task tools and
read back from the Desktop list; standalone App Server `thread/start` is not a
Desktop task-creation path.

## External Package Evidence

As of 2026-09-01:

- v0.12.7 current-only syntax and PowerShell parse checks: verified;
- current-only automated tests: 117/117;
- portable v0.12.7 builder uses a 42-file current-only allowlist, external
  guide/readme/hash/manifest, extracted smoke test, publication read-back, and
  one complete release ZIP whose extracted five-file set is verified;
- the same ZIP supports clean install, preserve-config upgrade, and recoverable
  repair installation; the latter two archive old public source and retain the
  receiving device's private config/state rather than merging unknown edits;
- v0.12.7 includes the bounded inactive-controller recovery contract: only a
  confirmed `desktop_ipc_no_owner / not_dispatched` result may request the exact
  private thread deep link, verify the Desktop owner, and retry the identical
  envelope once;
- external-content scanning rejects personalized labels, literal Windows user
  profile paths, and literal private Codex thread URIs before publication;
- no private runtime, credentials, auth data, message content, or full private
  IDs are part of the package;
- the package manifest declares an external new/upgrade/repair audience and states
  that source-computer runtime is not part of package acceptance;
- bot/user identity, Desktop owner, preflight, one-consumer health, Feishu live
  round trip, resource read-backs, reboot, FIFO, attachments, and interrupted
  recovery must be proven separately on each receiving device.

Do not use source-computer runtime state to promote or reject the external
package. Package verification and receiving-device operational acceptance are
separate evidence lanes.

## Historical Boundary

The current skill contains no secretary planner, hidden conversation, task
controller, remote-job registry, Feishu Task commands, group routing, or quoted
confirmation workflow. Historical source is retained only in external rollback
evidence and must not be used as current operating guidance.

The active implementation plan is
`references/implementation-plan.md`.
