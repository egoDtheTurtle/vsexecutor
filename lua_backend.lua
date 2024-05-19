repeat wait() until game:IsLoaded()

local host = game.Players.LocalPlayer.PlayerGui:FindFirstChild('TouchGui') and "10.0.2.2" or "localhost"
local serverUrl = "http://" .. host .. ":1306/received_script.lua"

local lastScript = ""

local function fetchScript()
    local success, response = pcall(function()
        return game:HttpGet(serverUrl)
    end)

    if success then
        return response
    else
        warn("[VSExecutor]: Failed to fetch script: " .. tostring(response))
        return nil
    end
end

local function executeScript(scriptContent)
    local success, errorMessage = pcall(function()
        loadstring(scriptContent)()
    end)

    if not success then
        warn("[VSExecutor]: Error executing script: " .. errorMessage)
    end
end

local function checkAndExecuteNewScript()
    local scriptContent = fetchScript()
    if scriptContent and scriptContent ~= "" and scriptContent ~= "HTTP Error Code: 404 Reason: Not Found" then
        print("[VSExecutor]: Executing new script")
        executeScript(scriptContent)
    end
end
print("[VSExecutor]: Connected")
while wait(.4) do
    checkAndExecuteNewScript()
end