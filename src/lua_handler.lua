if not game:IsLoaded() then
    game.Loaded:Wait()
end

local HttpService = game.HttpService
local wsConnect = WebSocket and WebSocket.connect or websocket and websocket.connect

local host = getgenv().EthernetIPv4 or game.Players.LocalPlayer.PlayerGui:FindFirstChild('TouchGui') and "10.0.2.2" or "localhost"
local playerName = game.Players.LocalPlayer.Name

local function isValidJSON(str)
    local success, result = pcall(function()
        return HttpService:JSONDecode(str)
    end)
    if success and result then
        return true, result
    else
        return false, nil
    end
end

local function deepCopy(original, visited, depth)
    visited = visited or {}
    depth = depth or 0
    
    if depth > 50 then
        return "-- STACK OVERFLOW"
    end
    
    if visited[original] then
        return "-- CIRCULAR REFERENCE"
    end
    
    if typeof(original) ~= "table" then
        return original
    end
    
    visited[original] = true
    local copy = {}
    
    for k, v in pairs(original) do
        if typeof(v) == "table" then
            copy[k] = deepCopy(v, visited, depth + 1)
        else
            copy[k] = v
        end
    end
    
    visited[original] = nil
    return copy
end

local function convertTableToString(tbl)
    for key, value in pairs(tbl) do
        local valueType = typeof(value)
        if valueType == "table" then
            convertTableToString(value)
        elseif valueType ~= "string" and valueType ~= "number" and valueType ~= "boolean" then
            tbl[key] = tostring(value)
        end
    end
    return tbl
end

local VSExtensionWS

local function sendMessage(messageType, data)
    if VSExtensionWS then
        local message = {
            Type = messageType
        }
        
        local dataTable = deepCopy(data or {})
        dataTable = convertTableToString(dataTable)

        for key, value in pairs(dataTable) do
            message[key] = value
        end
        
        local success, jsonString = pcall(function()
            return HttpService:JSONEncode(message)
        end)
        
        if success then
            VSExtensionWS:Send(jsonString)
        else
            warn("Failed to encode message:", jsonString)
        end
    else
        warn("VSExecutor: Cannot send message - WebSocket not connected")
    end
end

local function sendOutput(tag, message)
    sendMessage("game_message", {
        Tag = tag,
        Message = message
    })
end

local function connectWebSocket()
    local success, err = pcall(function()
        spawn(function()
            VSExtensionWS = wsConnect("ws://" .. host .. ":1306")
        end)

        local timeout = tick()
        repeat wait() until VSExtensionWS or tick() - timeout > 3

        if not VSExtensionWS
        or not pcall(function()
            return VSExtensionWS.OnMessage and VSExtensionWS.OnClose and VSExtensionWS.Send
        end) then
            return connectWebSocket()
        end
    end)
    
    if not success then 
        VSExtensionWS = nil
        return connectWebSocket() 
    end

    getgenv().VSExecutor_messageCooldown = 0
    VSExtensionWS.OnMessage:Connect(function(msg)
        
        if tick() - getgenv().VSExecutor_messageCooldown < 0.1 then
            return
        end
        getgenv().VSExecutor_messageCooldown = tick()

        local isJson, parsedData = isValidJSON(msg)
        
        if isJson and parsedData then
            -- Handle structured messages
            if parsedData.Type == "execute_script" then
                local success, result = pcall(function()
                    task.spawn(function()
                        local scriptFunc, loadError = loadstring(parsedData.Script)
                        if scriptFunc then
                            local execSuccess, execError = pcall(scriptFunc)
                            if not execSuccess then
                                -- Remove non-printable characters
                                execError = execError:gsub("[%z\1-\31\127-\255]", "")
                                
                                sendOutput("Error", "Script execution failed: " .. tostring(execError))
                            end
                        else
                            sendOutput("Error", "Script compilation failed: " .. tostring(loadError))
                        end
                    end)
                end)
                
                if not success then
                    sendOutput("Error", "Failed to spawn script: " .. tostring(result))
                end
            end
        else
            -- Handle legacy string messages (backward compatibility)
            if msg ~= "Client connected" and msg ~= "Client disconnected" then
                local success, result = pcall(function()
                    task.spawn(function()
                        local scriptFunc, loadError = loadstring(msg)
                        if scriptFunc then
                            local execSuccess, execError = pcall(scriptFunc)
                            if not execSuccess then
                                sendOutput("Error", "Legacy script execution failed: " .. tostring(execError))
                            end
                        else
                            sendOutput("Error", "Legacy script compilation failed: " .. tostring(loadError))
                        end
                    end)
                end)
                
                if not success then
                    sendOutput("Error", "Failed to spawn legacy script: " .. tostring(result))
                end
            end
        end

    end)

    VSExtensionWS.OnClose:Connect(function()
        wait(10)
        VSExtensionWS = nil
        connectWebSocket()
    end)
    
    wait(0.5)
    
    local function registerClient()
        if VSExtensionWS then
            sendMessage("register_game", {
                PlayerName = playerName
            })
        else
            wait(1)
            registerClient()
        end
    end
    
    registerClient()
end

connectWebSocket()

-- Hook into print, warn, and error functions to send output to VS Code
if getgenv().LogGameOutput then
    game:GetService("LogService").MessageOut:Connect(function(message, messageType)
        if VSExtensionWS then
            local messageType2 = tostring(messageType)
            sendOutput(messageType2:gsub("Enum.MessageType.", ""), tostring(message))
        end
    end)
else
    -- Using a BindableEvent to call the function preventing thread cannot access
    local BindEvent = Instance.new("BindableEvent")
    BindEvent.Event:Connect(function(f) return f() end)

    local oldprint = getgenv().print
    getgenv().print = function(...)
        local args = {...}
        if VSExtensionWS then
            BindEvent:Fire(function() 
                sendOutput("Output", args)
            end)
        end
        return oldprint(...)
    end

    local oldwarn = getgenv().warn
    getgenv().warn = function(...)
        local args = {...}
        if VSExtensionWS then
            BindEvent:Fire(function() 
                sendOutput("Warning", args)
            end)
        end
        return oldwarn(...)
    end

    local olderror = getgenv().error
    getgenv().error = function(...)
        local args = {...}
        if VSExtensionWS then
            BindEvent:Fire(function() 
                sendOutput("Error", args)
            end)
        end
        return olderror(...)
    end
end
