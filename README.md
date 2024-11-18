## Installation

1. Install the [vsexecutor.vsix](https://github.com/egoDtheTurtle/vsexecutor/releases) file.
2. Open Visual Studio Code (VSC) and navigate to Extensions. Click on the three-dot menu (...) at the top-right corner, then select the option "Install from VSIX..." and choose the `vsexecutor.vsix` file you just downloaded.
3. Place the following script inside your executor's autoexec folder:
```lua
loadstring(game:HttpGet("https://raw.githubusercontent.com/egoDtheTurtle/vsexecutor/main/src/lua_handler.lua"))()
```
- If you want to update the extension, just uninstall the current one by right-clicking it in the Extensions section and pressing "Uninstall". Close and reopen VSCode, then follow the Installation steps again.


## Usage

- In Visual Studio Code, you should see the "Execute" button at the bottom (Status Bar), or simply press `F1` and type "Execute Lua Script", then press Enter to run the script.
- Press `Ctrl` + `` ` `` to open the Terminal. Then go to the "Output" section, where you will find a dropdown showing outputs from other extensions. Select `VSExecutor`, and your in-game Roblox developer console data will be synced with the console. Note: This will only sync client (executor) outputs. To also sync the game's console output, add the following line at the top of the loadstring script (inside the autoexec folder):
```lua
getgenv().LogGameOutput = true
```

## Troubleshooting

- **Got message "WebSocket connection is not open. Please check the connection." after pressing "Execute" button:**
1. Try to disable your firewall (completely).
2. Close all the VSCode tabs (File -> Exit).
After completing these steps, try again.

- **Script not executing in-game after pressing "Execute" button:**
1. Add this line at the top of the loadstring script (inside the autoexec folder):
```lua
getgenv().EthernetIPv4 = "Your Ethernet IPv4"
```
2. To find your Ethernet IPv4, install and run [EthernetIPv4.exe](https://github.com/egoDtheTurtle/vsexecutor/releases).

- If the above method doesn't work, it might be because the executor/emulator does not support localhost connection. Try using a different executor/emulator.


## If the new version (WebSocket-based) isn't working for you  
Use the old loadstring-raw based version instead. Download the [Legacy](https://github.com/egoDtheTurtle/vsexecutor/releases/tag/v0.0.2) version.