if not game:IsLoaded() then
    game.Loaded:Wait()
end

local HttpService = game.HttpService -- Not using GetService and using HttpService.JSONEncode(HttpService, ...) to call to prevent issue with getrawmetatable
local wsConnect = WebSocket and WebSocket.connect or websocket and websocket.connect

local host = getgenv().EthernetIPv4 or game.Players.LocalPlayer.PlayerGui:FindFirstChild('TouchGui') and "10.0.2.2" or "localhost"

local function isValidJSON(str)
    local success, result = pcall(function()
        return HttpService:JSONDecode(str)
    end)
    if success and result then
        return true
    else
        return false
    end
end

local function connectWebSocket()
    local VSExtensionWS = nil

    local success = pcall(function()
        spawn(function()
            VSExtensionWS = wsConnect("ws://" .. host .. ":1306")
        end)
        local timeout = tick()
        repeat wait() until VSExtensionWS or tick() - timeout > 5
        if not VSExtensionWS or typeof(VSExtensionWS) ~= "WebSocket" then
            return connectWebSocket()
        end
    end)
    if not success then return connectWebSocket() end
    
    VSExtensionWS.OnMessage:Connect(function(msg)
        if msg ~= "Client connected" and msg ~= "Client disconnected"
        and ( -- Detect to prevent overflow error with multiple instances connected to the websocket (because of the websocket send to server "Script executed" below)
            not string.find(msg, '"Message":') and not string.find(msg, '"Tag":')
            or not isValidJSON(msg)
        ) then
            if VSExtensionWS then
                local messageType2 = tostring(messageType)
                VSExtensionWS:Send(HttpService:JSONEncode({
                    ["Tag"] = "Websocket",
                    ["Message"] = "Script executed"
                }))
            end
            
            local success, result = pcall(function()
                task.spawn(function() -- method prevent "attempt to yield across metamethod/C-call boundary" for some executor
                    local s, e = pcall(loadstring(msg))
                    if not s then
                        warn(e)
                    end
                end)
            end)
    
            if not success then
                warn(result)
            end
        end
    end)
    
    VSExtensionWS.OnClose:Connect(function()
        connectWebSocket()
    end)
end

connectWebSocket()

if getgenv().LogGameOutput then
    game:GetService("LogService").MessageOut:Connect(function(message, messageType)
        if getgenv().web then
            local messageType2 = tostring(messageType)
            getgenv().web:Send(HttpService:JSONEncode({
                ["Tag"] = messageType2:gsub("Enum.MessageType.Message", ""),
                ["Message"] = tostring(message)
            }))
        end
    end)
else
    -- # Not using ":" to prevent getmetatable issues
    
    -- Using a BindableEvent to call the function preventing thread cannot access
    local BindEvent = Instance.new("BindableEvent")
    BindEvent.Event:Connect(function(f) return f() end)

    local oldprint = getgenv().print
    getgenv().print = function(...)
        local args = {...}
        BindEvent:Fire(function() 
            if getgenv().web then
                getgenv().web.Send(getgenv().web, HttpService.JSONEncode(HttpService, {
                    ["Tag"] = "Output",
                    ["Message"] = args
                }))
            end
        end)
        return oldprint(...)
    end
    

    local oldwarn = getgenv().warn
    getgenv().warn = function(...)
        local args = {...}
        BindEvent:Fire(function() 
            if getgenv().web then
                getgenv().web.Send(getgenv().web, HttpService.JSONEncode(HttpService, {
                    ["Tag"] = "Warning",
                    ["Message"] = args
                }))
            end
        end)
        return oldwarn(...)
    end

    local olderror = getgenv().error
    getgenv().error = function(...)
        local args = {...}
        BindEvent:Fire(function() 
            if getgenv().web then
                getgenv().web.Send(getgenv().web, HttpService.JSONEncode(HttpService, {
                    ["Tag"] = "Error",
                    ["Message"] = args
                }))
            end
        end)
        return olderror(...)
    end
end
