# VSExecutor improvement plan

Status: implementation complete. This file records the approved rewrite and
its verification results. The final package label is intentionally `0.0.7` per
the release request.

## Goals

- Keep the current WebSocket workflow as the default.
- Add a selectable legacy loadstring/HTTP workflow compatible with the
  [v0.0.2 release](https://github.com/egoDtheTurtle/vsexecutor/releases/tag/v0.0.2).
- Make client presence accurate across script re-runs, disconnects, and
  Roblox exits.
- Make the Execute button follow the main visible code editor, not whichever
  tab or output pane currently has focus.
- Allow any text editor containing Lua, including `.py` or untitled files.
- Show game name and job ID for each session.
- Add command-palette QOL commands for IPv4 and autoexec snippets.
- Make autoexec loaders accept an options table, so users do not need to set
  configuration globals.
- Consolidate the WebSocket and HTTP/loadstring client logic into one clearly
  named Lua loader selected by the options table.
- Make output values readable as structured tables and identifiable Roblox
  objects.
- Let multiple VS Code windows share one bridge and work at the same time.
- Treat the loader path change as an intentional rewrite: remove the obsolete
  split loader files and document the new canonical autoexec URL.

## Findings in the current tree

- `src/extension.ts` owns a single WebSocket connection and a
  `Map<clientId, playerName>`; the ID is generated per transport connection.
- `server.js` has no stable session key, heartbeat, stale-client pruning, or
  full-list broadcast on every lifecycle transition.
- Re-running `src/lua_handler.lua` creates another socket and another output
  hook. Its reconnect path is recursive and can leave old workers alive.
- `lua_backend.lua` polls the legacy endpoint but has no re-run singleton or
  presence registration.
- Startup checks port 1306 and force-kills whatever owns it, then starts a
  child server and waits a fixed one second. This is fragile during extension
  reloads and can kill an unrelated local process.
- Execution and button state use `activeTextEditor` and reject every language
  except `lua`.
- The IPv4 helper is external to the extension, and there are no commands for
  mode selection, IPv4 lookup, or autoexec-copying.
- Output is written as plain strings to a standard `OutputChannel`; the Lua
  serializer currently stringifies tables and Roblox objects before VS Code can
  render them, and the current array/quote cleanup is lossy.
- Every VS Code window tries to own port 1306 and kills the previous server, so
  opening a second window disconnects the first one.
- The tracked VSIX is generated output and the README has stale/garbled text.

## Decisions and assumptions

1. WebSocket is the default loader behavior, represented by
   `"Loader Mode" = "websocket"`.
2. `loadstring` means the v0.0.2 polling contract: the extension queues a
   script with HTTP `POST /execute`, and the legacy script consumes it from
   `GET /received_script.lua`. That path remains broadcast-oriented because
   the old protocol has no target-session field.
3. The bridge will expose HTTP and WebSocket endpoints from one shared server,
   while each extension window uses a control connection and dispatches through
   the client's reported protocol. A singleton bridge is reused by all VS Code
   windows; ordinary extension deactivation must not kill it out from under
   another window.
4. Game name lookup is best-effort and protected. If Roblox product metadata is
   unavailable, the UI will show `Unknown game` plus the place ID and still
   retain the job ID.
5. VS Code does not expose pane pixels directly. The main editor heuristic will
   rank `visibleTextEditors` by visible text area (visible line count, then
   stable view-column tie-breakers) and remember the last main document when an
   output panel receives focus.
6. This is a rewrite, so a small purposeful layout change is allowed. Use one
   canonical loader, recommended as `src/vsexecutor.lua`, and remove the old
   split `src/lua_handler.lua` and root `lua_backend.lua` files. The README and
   autoexec command will point to the new URL; preserving the obsolete raw URLs
   is not a requirement.
7. The new loader API follows the
   [UniversalSynSaveInstance loadstring pattern](https://github.com/luau/UniversalSynSaveInstance#loadstring):
   the fetched chunk returns an initializer and the options table is passed to
   that initializer. `Params.SSI` is used as the chunk label/path, not as a
   hidden global configuration channel. The canonical options keys are exactly
   `"Log Game Output"`, `"Ethernet IPv4"`, and `"Loader Mode"`.
8. `"Loader Mode" = "loadstring"` selects the HTTP polling implementation;
   `"websocket"` selects WebSocket. The options table is the source of truth
   for a Roblox client. The extension keeps one WebSocket control connection to
   the bridge, reads each client's reported protocol, and dispatches execution
   through the matching endpoint, so users do not have to maintain two mode
   switches.
9. A private, namespaced runtime marker may remain in `getgenv()` solely to stop
   old workers and hooks on re-run. User configuration itself will live in the
   options table and will not require a global variable.

## Newly requested TODOs

- [ ] Replace required user globals in the documented autoexec form with a
  returned initializer that accepts an options table, following the
  `loadstring(HttpGet(...), Params.SSI)()({ ... })` pattern and these exact
  option keys: `Log Game Output`, `Ethernet IPv4`, and `Loader Mode`.
- [ ] Add structured output rendering: complete safe table views, muted object
  tokens with name/class/path snapshots, and a richer clickable viewer where
  the VS Code API allows it.
- [ ] Make multiple VS Code windows first-class bridge clients instead of
  killing the previous window's server or connection.

The detailed implementation and verification items for these TODOs are in
Phases 1, 3, 5, and the verification matrix below.

## Proposed layout after the rewrite

```text
src/
  extension.ts
  vsexecutor.lua       # one callable loader; chooses WebSocket or HTTP
  output-view.ts       # only if the rich console needs a separate module
server.js              # shared HTTP + WebSocket bridge
```

`src/lua_handler.lua` and `lua_backend.lua` were removed after
`src/vsexecutor.lua` passed both transport checks. The old file names are not
kept as aliases; the README and generated autoexec snippet use the new
canonical path.

## Implementation phases

### Phase 1: one lifecycle-safe bridge with two transports

Files: `server.js`, `src/extension.ts`, `package.json`.

- Turn `server.js` into a small start/stop bridge factory, while retaining a
  standalone entry point for local debugging.
- Run one shared bridge process per user/port, with a health handshake and an
  atomic lock/lease so two windows cannot start competing servers. If port 1306
  already has a compatible VSExecutor bridge, reuse it; if it is unrelated,
  report the conflict instead of killing it.
- Treat extension windows as independent bridge clients. Each window gets its
  own WebSocket/HTTP transport connection and receives the same canonical
  client list and output events. Normal `deactivate` must detach only that
  window, not stop the shared bridge. Provide an explicit stop path or an idle
  timeout for bridge cleanup.
- Give each extension connection a short `ExtensionId` so the bridge can
  remove only the closing window and keep the other window subscriptions
  alive. A window may have its own autoexec default, while the shared bridge
  continues to serve both protocols.
- Replace the current fixed delay and arbitrary `taskkill`/`kill -9` path with
  readiness polling and reconnect backoff. A bridge started by one window must
  remain usable when that window closes while another window is still open.
- Share one HTTP server with the WebSocket server. Keep these compatibility
  endpoints:
  - `GET /health` for readiness and bridge version.
  - `POST /execute` for legacy script queueing.
  - `GET /received_script.lua` for one-shot legacy consumption.
- Make legacy consumption atomic and no-cache. Bound request/script size and
  return clear HTTP errors for malformed or oversized requests.
- Keep one WebSocket control connection from each extension window for client
  lists, output, and WebSocket execution. For a client registered with
  `"Loader Mode" = "loadstring"`, dispatch the script through the HTTP queue
  instead of requiring the extension to switch its own control transport.
- Add an explicit bridge/client status (`WebSocket client`, `Loadstring
  client`, disconnected) to the status bar and output channel. An optional
  `vsexecutor.defaultLoaderMode` setting may control the mode preselected by
  the autoexec-copy command, but it is not a second execution source of truth.

### Phase 2: stable session identity and presence

Files: `server.js`, `src/extension.ts`, and the new unified
`src/vsexecutor.lua` loader.

- Extend game registration with a deterministic `SessionId` based on the
  current Roblox job and player, plus `PlayerName`, `GameName`, `JobId`,
  `PlaceId`, and protocol name/version. Keep the random transport ID internal
  for routing only.
- On duplicate `SessionId`, close the old socket before accepting the new
  record. Ignore a late close from the old socket so it cannot delete the new
  record. Broadcast one canonical `client_list` after replacement.
- Track `lastSeen` on every valid message. Add a bounded server sweep and
  heartbeat handling; close and remove sessions that stop checking in. A
  normal WebSocket close remains immediate, while an unclean Roblox exit is
  removed after the heartbeat timeout.
- Add HTTP register/heartbeat records for the loadstring branch of the unified
  loader. The endpoint and one-shot polling behavior remain compatible with
  the v0.0.2 protocol, even though the obsolete source file is removed.
- Change the extension state to a typed `ClientInfo` map and render entries as
  `Game name`, `Job ID`, and player. Do not show the internal Client ID in the
  status bar or QuickPick descriptions.
- Reconcile the full list on connect, replacement, close, and timeout so a
  missed event cannot leave a stale UI row.

### Phase 3: one callable, dual-mode Lua loader

Files: new `src/vsexecutor.lua`; delete the obsolete `src/lua_handler.lua` and
root `lua_backend.lua` after the replacement is verified.

The implementation will follow the requested skills from
`D:\Scripting Project\.agents\skills`, specifically:

- `roblox-automation-maintenance`: generation-owned workers, bounded
  reconnects, lifecycle cleanup, no stale hooks, and observable verification.
- `human-taste-code`: one direct loader with the existing `loadstring`
  execution method, adding only helpers needed for lifecycle and metadata.
- `roblox-executor-mcp`: live smoke tests after implementation, using the
  required list-client, context, execute, and follow-up verification order.

Changes:

- Make `src/vsexecutor.lua` return one initializer function. The initializer
  accepts the exact public options table requested by the user:

  ```lua
  local Params = {
      RepoURL = "https://raw.githubusercontent.com/egoDtheTurtle/vsexecutor/main/",
      SSI = "src/vsexecutor",
  }

  loadstring(game:HttpGet(Params.RepoURL .. Params.SSI .. ".lua", true), Params.SSI)()({
      ["Log Game Output"] = true,
      ["Ethernet IPv4"] = "123.123.123.123",
      ["Loader Mode"] = "websocket",
  })
  ```

  The extension's autoexec command generates this snippet with the selected
  mode. For the loadstring version the only change is
  `["Loader Mode"] = "loadstring"`; for WebSocket it is
  `["Loader Mode"] = "websocket"`. `Params.SSI` is both the URL stem and the
  useful chunk label, matching the referenced UniversalSynSaveInstance
  convention.
- Use `"Loader Mode" == "loadstring"` for the HTTP polling branch and
  `"websocket"` for the WebSocket branch. Both branches share registration
  metadata, heartbeat, output serialization, and script execution error
  handling. The bridge keeps both endpoints available. The extension reads the
  protocol reported during registration and routes each execution to the
  matching endpoint.
- Use `"Ethernet IPv4"` as an optional host override and
  `"Log Game Output"` as the output-source switch. No user-facing setup step
  requires `getgenv().EthernetIPv4`, `getgenv().LogGameOutput`, or any other
  configuration global. Invalid or missing options fall back to localhost and
  disabled game-console forwarding with a clear diagnostic.
- This is an intentional loader API migration. Do not keep the old split files
  or guess whether a caller used the old bare invocation. The README and
  `Copy Autoexec Script` command will provide only the new callable form, and
  the release notes will call out the new URL and options keys.
- Before startup, stop the previous private runtime, close its socket, cancel
  its poll/heartbeat workers, disconnect its event connections, and increment a
  generation. Every worker checks that generation after waits and before
  sending or executing.
- Replace recursive reconnect calls with one bounded backoff loop. Avoid a
  global message cooldown that can drop execute commands; rate-limit only noisy
  diagnostics if needed.
- Send a small heartbeat while connected and stop it on close or generation
  invalidation. The loadstring branch registers and heartbeats over HTTP while
  retaining the v0.0.2 one-shot `/received_script.lua` polling behavior.
- Install print/warn or `LogService` forwarding only once per runtime. Re-runs
  must not stack output hooks or duplicate console lines.
- Resolve `GameName` with a protected `MarketplaceService:GetProductInfo`
  call, apply the supplied bracket-prefix cleanup rule safely, and send
  `game.JobId` as `JobId` (the supplied example's undefined `gameId` will not be
  copied).
- Keep the exact Roblox client binding required by the skill:
  `local plr = game.Players.LocalPlayer`.

### Phase 4: editor selection and command-palette QOL

Files: `src/extension.ts`, `package.json`.

- Add one `getMainEditor()` path used by both the command and button state:
  choose the largest visible text editor, ignore output channels, and retain
  the last valid main document when focus leaves the editor area.
- Listen to active-editor and visible-editor changes, but do not let an output
  pane turn a valid script into `Lua Only`.
- Remove the language-ID execution gate. Any non-empty visible text document is
  executable; compilation errors are reported by the existing output path.
  Rename copy such as `Execute Lua Script` to `Execute Script` where it is user
  visible.
- Add these command-palette commands:
  - `VSExecutor: Execute Main Editor`.
  - `VSExecutor: Get Ethernet IPv4` (lists non-internal IPv4 addresses and
    copies the selected address to the clipboard).
  - `VSExecutor: Copy Autoexec Script` (offers WebSocket or loadstring,
    remembers the optional default, and copies the one unified loader with the
    corresponding `"Loader Mode"` value).
  - `VSExecutor: Refresh Clients` (manual recovery when a firewall or executor
    delays a lifecycle event).
- Use Node's built-in `os.networkInterfaces()` for IPv4 discovery; do not spawn
  Python or require a new dependency. The old helper file is removed now that
  the command is verified.
- Keep multiple-client selection for WebSocket clients. For loadstring clients,
  explain that the v0.0.2-compatible HTTP queue is broadcast-oriented rather
  than pretending it can target one client.

### Phase 5: structured output viewer

Files: `src/vsexecutor.lua`, `server.js`,
`src/extension.ts`, and a small output-view module only if the extension file
would otherwise become harder to read.

- Keep the existing plain `Message` field for older bridge clients and add an
  optional structured `Values` field for the unified loader. Each value carries
  a small kind
  such as `text`, `number`, `boolean`, `nil`, `table`, `instance`, or
  `userdata`.
- Replace the current lossy `JSON.stringify` and quote-stripping path with a
  bounded recursive serializer. Tables render with keys, indentation, nested
  values, and cycle markers; the full reachable table is shown up to explicit
  depth, entry, and byte safety limits. Limits are reported visibly instead of
  silently dropping data.
- Represent an `Instance` as a safe snapshot containing its `Name`,
  `ClassName`, and protected `GetFullName()` result. A print such as
  `print(game.Workspace)` will therefore render a `Workspace` object token,
  with its name shown in a muted/light-gray style rather than an opaque table
  dump.
- Improve the existing output fallback with readable pretty text, stable
  timestamps, severity badges, and game/job context. Escape values before
  inserting them into any HTML.
- A standard VS Code `OutputChannel` cannot color individual spans, expand a
  table, or handle clicks. Add a theme-aware `WebviewPanel` opened by
  `VSExecutor: Open Output Viewer` for the rich presentation. Keep the
  `OutputChannel` as a plain-text fallback so logs remain available in remote
  or restricted extension hosts.
- Make table rows collapsible and instance tokens clickable to show the
  captured name/class/path snapshot. Live property lookup is possible, but it
  would require a new request/response message and a resolver in the Roblox
  loader; keep that as an opt-in follow-up rather than pretending a stale
  `Instance` can be queried from VS Code after it was serialized.
- Do not add the output-filter backlog items that were removed from this plan.
  The viewer's first version is focused on readable values and presentation.

### Phase 6: docs, packaging, and release hygiene

Files: `README.md`, `package.json`, optional `.vscodeignore`,
`vsexecutor-<version>.vsix`.

- Rewrite the README in clean UTF-8 with prerequisites, both mode setup
  snippets, configuration, command-palette commands, metadata display,
  structured-output viewer behavior, troubleshooting, and the legacy
  compatibility note.
- Document the one canonical autoexec URL:
  - `main/src/vsexecutor.lua`, loaded with the callable options-table form.
  - Explain that `"Loader Mode"` selects the legacy HTTP behavior, so no
    second Lua file, legacy global, or VS Code transport switch is needed.
- Document that `Job ID` identifies a Roblox server session and that an
  Ethernet override is only needed when localhost is not reachable.
- Add a focused VSIX file allow-list/ignore file so source maps, tests, and
  development-only files are not shipped. Keep `src/vsexecutor.lua` in the
  package and remove the obsolete loader files.
- Bump the extension patch version, regenerate the VSIX from a clean install,
  and verify its manifest contains the bridge, compiled extension, README, and
  the unified Lua loader.

## Verification matrix

### Automated/local checks

- `npm ci`.
- `npm run compile` and `npm run lint`.
- A small Node protocol smoke check using `node:test` or `assert` that covers
  health, HTTP queue/consume, WebSocket registration, duplicate replacement,
  and heartbeat expiry. No new test framework is needed.
- Extension helper checks for main-editor ranking, language-agnostic execution,
  IPv4 filtering, autoexec URL/config-table generation, and structured-value
  formatting.
- Confirm no arbitrary process is killed when port 1306 is occupied.
- Start two extension clients against one bridge and confirm both stay
  connected when either client detaches.

### Roblox Executor MCP checks

1. Call `list-clients`; select an active client only if needed.
2. Read game/place/job context with a compact probe.
3. Run the WebSocket loader twice. Verify exactly one session is listed and the
   metadata contains game name and job ID.
4. Execute a small script through the bridge and verify the resulting output,
   not only the scheduling response.
5. End the client or close its connection, wait for the bounded timeout, and
   verify the extension list reaches zero.
6. Run `src/vsexecutor.lua` with `"Loader Mode" = "loadstring"`, POST a script, and
   verify one execution through the v0.0.2-compatible polling endpoint.
7. Re-run the unified loader with the options-table form and confirm the
   supplied `"Ethernet IPv4"` and `"Log Game Output"` values are used without
   requiring user globals.
8. Re-run the unified loader with both values of `"Loader Mode"` and confirm
   only one worker and one output hook remain after each switch.
9. Send primitive, nested/cyclic table, and `game.Workspace` values. Verify the
   plain fallback and rich viewer show complete safe snapshots with no Lua or
   HTML errors.

### Manual VS Code checks

- Open a Lua file beside another text file, focus the output panel, and confirm
  the button still executes the largest code editor.
- Put valid Lua in a `.py` or untitled document and execute it.
- Connect two sessions and confirm QuickPick shows game/job metadata, not raw
  client IDs.
- Choose WebSocket and loadstring from the autoexec command and confirm the
  copied options-table snippet changes only `"Loader Mode"` while the
  extension control connection remains available.
- Run the IPv4 command with one and multiple adapters and confirm the copied
  value is a non-internal IPv4 address.
- Open two VS Code windows, connect both to the bridge, and confirm closing or
  reloading one leaves the other usable.
- Open `VSExecutor: Open Output Viewer`, print a nested table, and print
  `game.Workspace`; confirm tables expand and the object token is muted/light
  gray with its captured details available on click.

## Suggested QOL backlog after the core fixes

These are intentionally separate from the must-have fixes so the first release
stays small:

- Pin a preferred client for one-click execution.
- Add an execution history with a single `Run Again` action.
- Add a reconnect indicator and a retry action when the bridge is unavailable.
- Add optional notification suppression for successful sends.
- Add a small status view listing transport, bridge version, and last heartbeat.

## Completion record

- Implemented the shared HTTP/WebSocket bridge, stable session replacement,
  heartbeat expiry, per-protocol dispatch, main-editor selection, native IPv4
  and autoexec commands, structured output viewer, README, package metadata,
  tests, and VSIX.
- Replaced `src/lua_handler.lua` and `lua_backend.lua` with
  `src/vsexecutor.lua` and the callable options-table API.
- Local verification passed: `npm run compile`, `npm run lint`, `npm test`,
  `npx vsce package`, and `npx vsce ls`; the generated artifact is
  `vsexecutor-0.0.8.vsix`.
- Roblox Executor MCP verification passed for WebSocket registration, re-run
  de-duplication, game/job metadata, structured table/Instance output,
  loadstring polling, and clean runtime stop.
- The shared bridge uses the operating system's single port bind as the race
  guard between windows and exits after its idle timeout.
- Follow-up packaging fix: `vsexecutor-0.0.7.vsix` omitted the `ws` runtime,
  causing activation failure. `vsexecutor-0.0.8.vsix` includes only the `ws`
  package files and was verified in an isolated VS Code profile without an
  activation error.
- Follow-up API cleanup: renamed the loader switch to `"Loader Mode"` with
  string values `"websocket"` and `"loadstring"`, and removed the unused
  deprecated `vscode` dev dependency so the generated lockfile is smaller.
- Follow-up stability fix: WebSocket reconnect attempts now wait at least one
  second between starts and use exponential backoff after failures.
- Follow-up large-script fix: raised the bridge's validated HTTP/WebSocket body
  limit to 8 MiB and added a regression test for a 2 MiB execute frame, so
  Anime Expeditions-sized bundles do not trigger a socket close.
- Added an extension-side 8 MiB preflight so larger files are rejected with a
  clear message before a WebSocket frame is sent.
- Bridge health now reports `MaxScriptBytes` and the owning PID. An older
  verified VSExecutor `server.js` daemon is replaced automatically instead of
  being reused with its stale 1 MiB limit.
- Final integration check passed: the installed extension host registered with
  its bridge, Roblox MCP connected through both loader modes, and a mocked
  failed-connect run made only two attempts over 5.2 seconds.
- Follow-up UI fix: a single connected client now shows only its game name in
  the status bar. Job ID remains available in the multi-client picker and
  session metadata. The rebuilt package is `vsexecutor-0.0.7.vsix` as
  requested.
- Follow-up execution fix: log-like documents are excluded from main-editor
  selection, and duplicate severity labels such as `ERROR [Error]` are
  normalized to a single `ERROR` label.

## Review checkpoint

Review the implementation and call out any follow-up changes to loader behavior,
output presentation, multi-window ownership, or the remaining QOL backlog.
