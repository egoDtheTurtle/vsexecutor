1. Install the [vsexecutor.vsix](https://github.com/egoDtheTurtle/vsexecutor/releases) file.
2. Open Visual Studio Code (VSC) and navigate to Extensions. Click on the three-dot menu (...) at the top-right corner, then select the option "Install from VSIX..." and choose the `vsexecutor.vsix` file you just downloaded.
3. Place the following script inside your executor's autoexec folder:
```lua
loadstring(game:HttpGet("https://raw.githubusercontent.com/egoDtheTurtle/vsexecutor/main/lua_backend.lua"))()
```
4. In Visual Studio Code, you should see the "Execute" button at the bottom (Status Bar), or simply press `F1` and type "Execute File", then press Enter to run the script.