# VSExecutor

VSExecutor sends Lua from Visual Studio Code to a Roblox client through a
local bridge. The current release uses one autoexec loader that supports both
WebSocket and legacy HTTP polling.

## Install

1. Download the latest `vsexecutor-*.vsix` from the
   [releases page](https://github.com/egoDtheTurtle/vsexecutor/releases).
2. In VS Code open Extensions, select the `...` menu, choose **Install from
   VSIX...**, and select the downloaded file.
3. Put the unified loader snippet below in the executor's autoexec folder.

The old `src/lua_handler.lua` and `lua_backend.lua` files were replaced by
`src/vsexecutor.lua`. The old split loader URLs are intentionally retired.
The raw GitHub URL below must point at a branch or commit that contains this
new file; it will return 404 until the rewrite is pushed.

## Autoexec loader

```lua
loadstring(game:HttpGet("https://raw.githubusercontent.com/egoDtheTurtle/vsexecutor/main/src/vsexecutor.lua", true), "src/vsexecutor")()({
    ["Log Game Output"] = false,
    ["Ethernet IPv4"] = "",
    ["Loader Mode"] = "websocket",
})
```

Options are passed directly to the loader. No user configuration global is
required.

| Option | Type | Meaning |
| --- | --- | --- |
| `"Log Game Output"` | boolean | Forward Roblox `LogService` output instead of only executor `print` and `warn` calls. |
| `"Ethernet IPv4"` | string | Optional host override for executors that cannot reach `localhost`. Leave empty for automatic localhost/emulator detection. |
| `"Loader Mode"` | string | Use exactly `"websocket"` or `"loadstring"`. `"loadstring"` uses the v0.0.2-compatible HTTP polling path. |

The extension command **VSExecutor: Copy Autoexec Script** generates this
snippet and lets you choose the value of `"Loader Mode"`. The
`vsexecutor.defaultLoaderMode` setting only controls that command's default;
the options table controls the Roblox client.

## Use VSExecutor

- Open any text document containing Lua. The status bar button follows the
  largest visible text editor, so focusing the Output panel does not change the
  script source.
- Click **Execute Script** or run **VSExecutor: Execute Main Editor** from the
  command palette (`F1`). Language ID and file extension do not restrict
  execution. Empty documents are rejected; compiler errors are sent back to
  the output.
- With one client, execution is sent directly. With multiple WebSocket clients,
  choose a session from QuickPick or use **Execute All**. Entries show game
  name, job ID, place ID, player, and protocol instead of the internal client
  UUID.
- Scripts up to 8 MiB are accepted by the bridge, which covers large bundled
  files such as Anime Expeditions. Larger files need to be split or reduced.
- Loadstring clients use the HTTP polling queue retained from the v0.0.2
  protocol. Registered clients can receive a session-targeted queue; an
  unregistered old-style poller consumes the compatibility queue.

## Commands

| Command | Action |
| --- | --- |
| **VSExecutor: Execute Main Editor** | Execute the main visible text editor. |
| **VSExecutor: Get Ethernet IPv4** | Find non-internal IPv4 addresses and copy the selected adapter address. |
| **VSExecutor: Copy Autoexec Script** | Copy the unified loader with WebSocket or loadstring selected. |
| **VSExecutor: Refresh Clients** | Reconcile the current bridge client list. |
| **VSExecutor: Open Output Viewer** | Open the rich structured output panel. |

## Output

The extension keeps the `VSExecutor` Output channel as a plain-text fallback
and also provides a theme-aware Output Viewer.

- Tables are serialized with keys, indentation, nested values, cycle markers,
  and visible safety-limit notices.
- Roblox Instances are represented by a captured name, class, and full path.
  For example, `print(game.Workspace)` displays a muted `Workspace` token with
  its captured details available on click.
- A normal VS Code Output channel cannot style individual values or handle
  clicks. The Output Viewer uses a Webview for colors, expandable tables, and
  object snapshots. It cannot query a Roblox Instance after it has been
  serialized; live property lookup would need an additional request protocol.

## Configuration

The extension starts one shared bridge on port `1306` and reuses it across VS
Code windows. Available settings:

```json
{
    "vsexecutor.host": "localhost",
    "vsexecutor.port": 1306,
    "vsexecutor.defaultLoaderMode": "websocket"
}
```

`host` and `port` describe the bridge from VS Code's point of view. The bridge
serves HTTP and WebSocket simultaneously. Opening or reloading another VS Code
window attaches another extension client instead of killing the existing
bridge or window.

## Troubleshooting

### No clients are shown

1. Confirm the loader is the new callable form: `loadstring(... )()({ ... })`.
2. Confirm the bridge is reachable on port `1306`.
3. Run **VSExecutor: Refresh Clients**.
4. If the executor cannot connect to localhost, run **VSExecutor: Get Ethernet
   IPv4**, paste the copied address into `"Ethernet IPv4"`, and restart the
   autoexec loader.
5. Use `"Loader Mode" = "loadstring"` when the executor does not provide a
   working WebSocket API.

### A client appears twice or remains after Roblox closes

The loader derives one session ID from the Roblox job and player, and the
bridge removes duplicate sessions and expires missing heartbeats. A hard crash
or blocked network may take up to the presence timeout to disappear.

### The script comes from the wrong tab

VSExecutor ranks visible text editors by their visible area and ignores the
Output panel and timestamped VSExecutor log documents. Close or resize split
editors if you need to make another editor the largest pane.

If a parser error mentions a leading timestamp such as `20:14:18`, the old
version sent a log document as code. Reload the extension so the log-document
guard is active, then run **VSExecutor: Execute Main Editor** again.

### Port 1306 is already in use

VSExecutor checks `/health` and reuses a compatible bridge. It never force-kills
an unrelated process. An older VSExecutor bridge that lacks the current payload
capacity is replaced only after its process is verified as a VSExecutor
`server.js`. Stop any unrelated service or change `vsexecutor.port` in VS Code,
then restart the extension host.

## Development

```powershell
npm ci
npm run compile
npm run lint
npx vsce package
```

The VSIX includes the compiled extension, `server.js`, and
`src/vsexecutor.lua`. Source TypeScript, maps, and development helpers are
excluded from the package.

## Responsible use

Use the bridge only with Roblox clients and experiences you are authorized to
test. The local bridge has no authentication, so keep its host and port private
on networks you do not trust.
