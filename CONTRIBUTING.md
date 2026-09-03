# Contributing

Contributions are welcome when they preserve the fixed-controller-only,
transport-only architecture.

Before opening a pull request:

1. Do not include credentials, private IDs, message bodies, logs, attachments,
   or machine-specific runtime state.
2. Keep the bridge semantics-free. Business reasoning belongs to the bound
   local controller, not the transport daemon.
3. Preserve exact-thread routing, FIFO, deduplication, and fail-closed behavior
   for unknown dispatch outcomes.
4. Add or update regression tests.
5. Run from `scripts`:

   ```powershell
   npm ci --ignore-scripts --no-audit --no-fund
   npm run check
   npm test
   ```

6. Describe source verification separately from live Feishu/Lark and receiving-
   device acceptance.

Please keep pull requests focused. Unrelated refactors, task-routing features,
hidden controller creation, and group-chat expansion require separate design
discussion and are not accepted as incidental changes.
