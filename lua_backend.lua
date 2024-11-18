-- Could've code better in lua, don't give a shit, if it work, it worked
repeat wait() until game:IsLoaded()

local host = getgenv().EthernetIPv4 or game.Players.LocalPlayer.PlayerGui:FindFirstChild('TouchGui') and "10.0.2.2" or "localhost"
local serverUrl = "http://" .. host .. ":1306/received_script.lua"

local function fetchScript()
    local success, response = pcall(function()
        return request({Url = serverUrl, Method='GET'}).Body
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
    if scriptContent then
        if scriptContent ~= "" and scriptContent ~= "HTTP Error Code: 404 Reason: Not Found" then
            print("[VSExecutor]: Executing new script")
            spawn(function()
                executeScript(scriptContent)
            end)
        end
    end
end

local function checkAndClearServer()
    local timeout = tick()
    repeat wait(1)
        local success, response = pcall(function()
            return request({Url = serverUrl, Method='GET'}).Body
        end)
        if success and response == "" then
            return true
        elseif tick() - timeout > 6 then
            warn("[VSExecutor]: localhost server not working properly")
            return false
        end
    until false
end

if checkAndClearServer() then
    print("[VSExecutor]: Server connected and ready to execute script.")
else
    print("[VSExecutor]: Failed to connect to the server.")
end

while wait(.2) do
    checkAndExecuteNewScript()
end
