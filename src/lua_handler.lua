if not game:IsLoaded() then
    game.Loaded:Wait()
end

local ws = WebSocket and WebSocket.connect or websocket and websocket.connect

local host = getgenv().EthernetIPv4 or game.Players.LocalPlayer.PlayerGui:FindFirstChild('TouchGui') and "10.0.2.2" or "localhost"
local wsUrl = "ws://" .. host .. ":1306"

local function connectWebSocket()
    getgenv().web = nil
    repeat wait() until pcall(function()
        getgenv().web = ws(wsUrl)
    end) == true

    getgenv().web.OnMessage:Connect(function(msg)
        if msg ~= "Client connected" and msg ~= "Client disconnected" then
            if getgenv().web then
                local messageType2 = tostring(messageType)
                getgenv().web:Send(HttpService:JSONEncode({
                    ["Tag"] = "Websocket",
                    ["Message"] = "Script executed"
                }))
            end
            local s, e = pcall(loadstring(msg))
            if e then
                warn(e)
            end
        end
    end)
    getgenv().web.OnClose:Connect(function()
        connectWebSocket()
    end)
end
connectWebSocket()

local HttpService = game:GetService("HttpService")
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
    local oldprint = print
    getgenv().print = function(...)
        local args = {...}
        if getgenv().web then
            getgenv().web:Send(HttpService:JSONEncode({
                ["Tag"] = "Output",
                ["Message"] = args
            }))
        end
        return oldprint(...)
    end

    local oldwarn = warn
    getgenv().warn = function(...)
        local args = {...}
        if getgenv().web then
            getgenv().web:Send(HttpService:JSONEncode({
                ["Tag"] = "Warning",
                ["Message"] = args
            }))
        end
        return oldwarn(...)
    end

    local olderror = error
    getgenv().error = function(...)
        local args = {...}
        if getgenv().web then
            getgenv().web:Send(HttpService:JSONEncode({
                ["Tag"] = "Error",
                ["Message"] = args
            }))
        end
        return olderror(...)
    end
end