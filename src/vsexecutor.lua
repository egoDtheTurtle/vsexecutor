local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local MarketplaceService = game:GetService("MarketplaceService")

local MAX_TABLE_DEPTH = 12
local MAX_TABLE_ENTRIES = 500
local MAX_RECONNECT_DELAY = 10
local CONNECT_COOLDOWN = 1
local HEARTBEAT_INTERVAL = 5
local POLL_INTERVAL = 0.2

local function jsonDecode(value)
    local success, result = pcall(HttpService.JSONDecode, HttpService, value)
    if success and type(result) == "table" then
        return result
    end
    return nil
end

local function encode(value)
    local success, result = pcall(HttpService.JSONEncode, HttpService, value)
    if success then
        return result
    end
    return nil
end

local function urlEncode(value)
    return tostring(value):gsub("[^%w%-_%.~]", function(character)
        return string.format("%%%02X", string.byte(character))
    end)
end

local function gameName()
    local name = "Unknown game"
    local success, product = pcall(MarketplaceService.GetProductInfo, MarketplaceService, game.PlaceId)
    if success and type(product) == "table" and type(product.Name) == "string" and product.Name ~= "" then
        name = product.Name
    end

    local cleaned = name:match("^%b[]%s+(.+)$")
    return cleaned or name
end

local function snapshotInstance(value)
    local result = {
        kind = "instance",
        name = "Instance",
        className = "Instance",
    }
    pcall(function()
        result.name = value.Name
        result.className = value.ClassName
        result.fullName = value:GetFullName()
    end)
    return result
end

local function serializeValue(value, state, depth)
    local valueType = typeof(value)
    if value == nil then
        return { kind = "nil" }
    end
    if valueType == "Instance" then
        return snapshotInstance(value)
    end
    if valueType == "string" or valueType == "number" or valueType == "boolean" then
        return { kind = valueType, value = value }
    end
    if type(value) ~= "table" then
        return { kind = "userdata", value = tostring(value) }
    end
    if state.visited[value] then
        return { kind = "text", value = "<circular table>" }
    end
    if depth >= MAX_TABLE_DEPTH then
        return { kind = "table", entries = {}, truncated = true }
    end

    state.visited[value] = true
    local entries = {}
    local count = 0
    local truncated = false
    for key, item in value do
        count = count + 1
        if count > MAX_TABLE_ENTRIES then
            truncated = true
            break
        end
        entries[#entries + 1] = {
            key = tostring(key),
            value = serializeValue(item, state, depth + 1),
        }
    end
    state.visited[value] = nil
    return { kind = "table", entries = entries, truncated = truncated }
end

local function serializeValues(arguments)
    local state = { visited = {} }
    local values = {}
    for index, value in arguments do
        values[index] = serializeValue(value, state, 0)
    end
    return values
end

local function cleanError(value)
    return tostring(value):gsub("[%z\1-\31\127-\255]", "")
end

return function(options)
    if not game:IsLoaded() then
        game.Loaded:Wait()
    end
    options = type(options) == "table" and options or {}

    local globalEnv = getgenv()
    local previous = globalEnv.__VSExecutorRuntime
    if previous and type(previous.stop) == "function" then
        pcall(previous.stop)
    end

    globalEnv.__VSExecutorGeneration = (tonumber(globalEnv.__VSExecutorGeneration) or 0) + 1
    local generation = globalEnv.__VSExecutorGeneration
    local plr = game.Players.LocalPlayer
    if not plr then
        warn("[VSExecutor]: LocalPlayer is not ready")
        return
    end

    local loaderMode = options["Loader Mode"] == "loadstring" and "loadstring" or "websocket"
    local useLoadstring = loaderMode == "loadstring"
    local logGameOutput = options["Log Game Output"] == true
    local configuredHost = options["Ethernet IPv4"]
    local host = type(configuredHost) == "string" and configuredHost ~= "" and configuredHost
        or (plr.PlayerGui:FindFirstChild("TouchGui") and "10.0.2.2" or "localhost")
    local port = tonumber(options.Port) or 1306
    local jobId = tostring(game.JobId or "")
    local placeId = tostring(game.PlaceId or "")
    local sessionId = string.format("%s:%s", jobId ~= "" and jobId or placeId, tostring(plr.UserId))
    local metadata = {
        SessionId = sessionId,
        PlayerName = plr.Name,
        UserId = tostring(plr.UserId),
        GameName = gameName(),
        JobId = jobId ~= "" and jobId or "Unknown job",
        PlaceId = placeId,
        Protocol = useLoadstring and "loadstring" or "websocket",
    }
    local serverUrl = "http://" .. host .. ":" .. tostring(port)
    local runtime = {
        alive = true,
        generation = generation,
        socket = nil,
        connections = {},
        restoreOutput = nil,
    }
    globalEnv.__VSExecutorRuntime = runtime

    local function isCurrent()
        return globalEnv.__VSExecutorRuntime == runtime
            and globalEnv.__VSExecutorGeneration == generation
            and runtime.alive
    end

    local function addConnection(connection)
        if connection then
            runtime.connections[#runtime.connections + 1] = connection
        end
        return connection
    end

    local function disconnectConnections()
        for _, connection in runtime.connections do
            pcall(function()
                connection:Disconnect()
            end)
        end
        runtime.connections = {}
    end

    local function closeSocket(socket)
        if not socket then
            return
        end
        pcall(function()
            if socket.Close then
                socket:Close()
            elseif socket.close then
                socket:close()
            end
        end)
    end

    local requestFunction = type(request) == "function" and request
        or type(http_request) == "function" and http_request
        or (syn and syn.request)
    local function httpRequest(method, url, body)
        if type(requestFunction) ~= "function" then
            return nil
        end
        local success, response = pcall(requestFunction, {
            Url = url,
            Method = method,
            Headers = body and { ["Content-Type"] = "application/json" } or nil,
            Body = body,
        })
        if not success or type(response) ~= "table" then
            return nil
        end
        if response.Success == false then
            return nil
        end
        local statusCode = tonumber(response.StatusCode)
        if statusCode and (statusCode < 200 or statusCode >= 300) then
            return nil
        end
        return response
    end

    local function sendSocketMessage(messageType, data)
        if not isCurrent() or not runtime.socket then
            return false
        end
        local payload = { Type = messageType }
        if type(data) == "table" then
            for key, value in data do
                payload[key] = value
            end
        end
        local json = encode(payload)
        if not json then
            return false
        end
        local success = pcall(function()
            runtime.socket:Send(json)
        end)
        return success
    end

    local function sendHttpMessage(messageType, data)
        if not isCurrent() then
            return false
        end
        local payload = { Type = messageType }
        if type(data) == "table" then
            for key, value in data do
                payload[key] = value
            end
        end
        local json = encode(payload)
        return json ~= nil and httpRequest("POST", serverUrl .. "/legacy/message", json) ~= nil
    end

    local function sendMessage(messageType, data)
        if useLoadstring then
            return sendHttpMessage(messageType, data)
        end
        return sendSocketMessage(messageType, data)
    end

    local function sendOutput(tag, arguments)
        local values = serializeValues(arguments)
        sendMessage("game_message", {
            Tag = tag,
            Message = values,
            Values = values,
        })
    end

    local function executeScript(content)
        if not isCurrent() or type(content) ~= "string" or content:match("^%s*$") then
            return
        end
        local scriptFunction, compileError = loadstring(content)
        if not scriptFunction then
            sendOutput("Error", { "Script compilation failed: " .. cleanError(compileError) })
            return
        end
        local success, executionError = pcall(scriptFunction)
        if not success then
            sendOutput("Error", { "Script execution failed: " .. cleanError(executionError) })
        end
    end

    local function installOutputHook()
        if logGameOutput then
            local logService = game:GetService("LogService")
            addConnection(logService.MessageOut:Connect(function(message, messageType)
                if isCurrent() then
                    sendOutput(tostring(messageType):gsub("Enum.MessageType.", ""), { tostring(message) })
                end
            end))
            return
        end

        local originalPrint = globalEnv.print or print
        local originalWarn = globalEnv.warn or warn
        local wrap = newcclosure or function(functionValue)
            return functionValue
        end
        globalEnv.print = wrap(function(...)
            local arguments = { ... }
            if isCurrent() then
                sendOutput("Output", arguments)
            end
            return originalPrint(...)
        end)
        globalEnv.warn = wrap(function(...)
            local arguments = { ... }
            if isCurrent() then
                sendOutput("Warning", arguments)
            end
            return originalWarn(...)
        end)
        runtime.restoreOutput = function()
            globalEnv.print = originalPrint
            globalEnv.warn = originalWarn
        end
    end

    local function registerHttp()
        local json = encode(metadata)
        return json and httpRequest("POST", serverUrl .. "/legacy/register", json) ~= nil
    end

    local function httpHeartbeatLoop()
        while isCurrent() do
            local json = encode({ SessionId = sessionId, JobId = jobId, UserId = tostring(plr.UserId) })
            if json then
                httpRequest("POST", serverUrl .. "/legacy/heartbeat", json)
            end
            task.wait(HEARTBEAT_INTERVAL)
        end
    end

    local function httpPollLoop()
        local endpoint = serverUrl .. "/received_script.lua?sessionId=" .. urlEncode(sessionId)
        while isCurrent() do
            local response = httpRequest("GET", endpoint)
            if response and type(response.Body) == "string" and response.Body ~= "" then
                task.spawn(executeScript, response.Body)
            end
            task.wait(POLL_INTERVAL)
        end
    end

    local function connectWebSocket()
        local webSocketApi = WebSocket or websocket
        local connect = webSocketApi and webSocketApi.connect
        if type(connect) ~= "function" then
            warn("[VSExecutor]: WebSocket API is unavailable")
            return nil
        end
        local success, socket = pcall(connect, "ws://" .. host .. ":" .. tostring(port))
        if not success or not socket then
            return nil
        end
        if not socket.OnMessage or not socket.OnClose or type(socket.Send) ~= "function" then
            closeSocket(socket)
            return nil
        end
        return socket
    end

    local function websocketLoop()
        local retryDelay = 1
        local nextAttemptAt = 0
        while isCurrent() do
            local waitFor = nextAttemptAt - tick()
            if waitFor > 0 then
                task.wait(waitFor)
            end
            if not isCurrent() then
                break
            end

            nextAttemptAt = tick() + math.max(retryDelay, CONNECT_COOLDOWN)
            local socket = connectWebSocket()
            if socket then
                runtime.socket = socket
                retryDelay = 1
                addConnection(socket.OnMessage:Connect(function(message)
                    if not isCurrent() then
                        return
                    end
                    local parsed = type(message) == "string" and jsonDecode(message) or nil
                    if parsed and parsed.Type == "execute_script" then
                        task.spawn(executeScript, parsed.Script)
                    elseif not parsed and message ~= "Client connected" and message ~= "Client disconnected" then
                        task.spawn(executeScript, message)
                    end
                end))
                addConnection(socket.OnClose:Connect(function()
                    if runtime.socket == socket then
                        runtime.socket = nil
                    end
                end))
                sendSocketMessage("register_game", metadata)
                task.spawn(function()
                    while isCurrent() and runtime.socket == socket do
                        sendSocketMessage("heartbeat", { SessionId = sessionId })
                        task.wait(HEARTBEAT_INTERVAL)
                    end
                end)
                while isCurrent() and runtime.socket == socket do
                    task.wait(1)
                end
                closeSocket(socket)
                runtime.socket = nil
                if isCurrent() then
                    nextAttemptAt = tick() + CONNECT_COOLDOWN
                end
            else
                retryDelay = math.min(retryDelay * 2, MAX_RECONNECT_DELAY)
                nextAttemptAt = tick() + retryDelay
            end
        end
    end

    runtime.stop = function()
        if not runtime.alive then
            return
        end
        runtime.alive = false
        disconnectConnections()
        closeSocket(runtime.socket)
        runtime.socket = nil
        if runtime.restoreOutput then
            pcall(runtime.restoreOutput)
            runtime.restoreOutput = nil
        end
        if useLoadstring then
            local json = encode({ SessionId = sessionId, JobId = jobId, UserId = tostring(plr.UserId) })
            if json then
                httpRequest("POST", serverUrl .. "/legacy/disconnect", json)
            end
        end
        if globalEnv.__VSExecutorRuntime == runtime then
            globalEnv.__VSExecutorRuntime = nil
        end
    end

    installOutputHook()
    if useLoadstring then
        if registerHttp() then
            task.spawn(httpHeartbeatLoop)
            task.spawn(httpPollLoop)
        else
            warn("[VSExecutor]: Loadstring bridge is not reachable")
        end
    else
        task.spawn(websocketLoop)
    end
end
