## Installation

1. Install the [vsexecutor.vsix](https://github.com/egoDtheTurtle/vsexecutor/releases) file.
2. Open Visual Studio Code (VSC) and navigate to Extensions. Click on the three-dot menu (...) at the top-right corner, then select the option "Install from VSIX..." and choose the `vsexecutor.vsix` file you just downloaded.
3. Place the following script inside your executor's autoexec folder:
```lua
loadstring(game:HttpGet("https://raw.githubusercontent.com/egoDtheTurtle/vsexecutor/main/lua_backend.lua"))()
```
- If you want to update the extension, just uninstall the current one by right-clicking it in the Extensions section and pressing "Uninstall". Close and reopen VSCode, then follow the Installation steps again.


## Usage

- In Visual Studio Code, you should see the "Execute" button at the bottom (Status Bar), or simply press `F1` and type "Execute File", then press Enter to run the script.

## Troubleshooting

- **Got message "Problem with request: connect ECONNREFUSED" after pressing "Execute" button:**
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