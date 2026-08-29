'use strict';

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const WebSocket = require('ws');

const SERVICE = 'VSExecutor';
const VERSION = '0.1.1';
const DEFAULT_PORT = 1306;
const DEFAULT_HOST = '0.0.0.0';
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_QUEUE_LENGTH = 20;
const PRESENCE_TIMEOUT_MS = 30_000;
const SWEEP_INTERVAL_MS = 5_000;
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;

function randomId() {
    return typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : crypto.randomBytes(16).toString('hex');
}

function text(value, fallback = '') {
    return typeof value === 'string' ? value.trim().slice(0, 512) : fallback;
}

function json(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

function plain(res, status, body) {
    const value = String(body || '');
    res.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(value),
        'Cache-Control': 'no-store',
    });
    res.end(value);
}

function readBody(req, limit = MAX_BODY_BYTES) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];

        req.on('data', chunk => {
            size += chunk.length;
            if (size > limit) {
                reject(new Error('Request body is too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function parseJson(value) {
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
        return null;
    }
}

function startBridge(options = {}) {
    const port = options.port === undefined ? DEFAULT_PORT : Number(options.port);
    const host = options.host || DEFAULT_HOST;
    const clients = new Map();
    const sessions = new Map();
    const extensionSockets = new Set();
    const legacyQueues = new Map();
    const globalLegacyQueue = [];
    const bridgeId = randomId();
    let sweepTimer;
    let httpServer;
    let wss;
    let actualPort = port;
    let lastActivity = Date.now();

    function touch() {
        lastActivity = Date.now();
    }

    function clientList() {
        return Array.from(sessions.values()).map(client => ({
            ClientId: client.transportId,
            SessionId: client.sessionId,
            PlayerName: client.playerName,
            GameName: client.gameName,
            JobId: client.jobId,
            PlaceId: client.placeId,
            Protocol: client.protocol,
            LastSeen: client.lastSeen,
        }));
    }

    function sendToExtensions(message) {
        const payload = JSON.stringify(message);
        for (const socket of extensionSockets) {
            if (socket.readyState === WebSocket.OPEN) socket.send(payload);
        }
    }

    function broadcastClientList() {
        sendToExtensions({ Type: 'client_list', Clients: clientList() });
    }

    function normalizeSessionId(data) {
        const supplied = text(data.SessionId);
        if (supplied) return supplied;
        const jobId = text(data.JobId, 'unknown-job');
        const userId = text(data.UserId, text(data.PlayerName, 'unknown-player'));
        return `${jobId}:${userId}`.slice(0, 512);
    }

    function removeSession(client, reason = 'disconnected') {
        if (!client || sessions.get(client.sessionId) !== client) return;
        sessions.delete(client.sessionId);
        clients.delete(client.transportId);
        if (client.ws && client.ws.readyState === WebSocket.OPEN) {
            client.ws.close(1000, reason);
        }
        broadcastClientList();
    }

    function registerGame(transportId, data, protocol, socket) {
        const sessionId = normalizeSessionId(data);
        const previous = sessions.get(sessionId);
        if (previous && previous.transportId !== transportId) {
            previous.replaced = true;
            if (previous.ws && previous.ws.readyState === WebSocket.OPEN) {
                previous.ws.close(1000, 'Replaced by a newer registration');
            }
            clients.delete(previous.transportId);
        }

        const client = clients.get(transportId) || {
            transportId,
            ws: socket || null,
        };
        Object.assign(client, {
            sessionId,
            type: 'game',
            protocol: protocol || (data.LoaderMode === 'loadstring' || data['Loader Mode'] === 'loadstring' ? 'loadstring' : 'websocket'),
            ws: socket || client.ws || null,
            playerName: text(data.PlayerName, 'Unknown player'),
            gameName: text(data.GameName, 'Unknown game'),
            jobId: text(data.JobId, 'Unknown job'),
            placeId: text(data.PlaceId, 'Unknown place'),
            lastSeen: Date.now(),
        });
        sessions.set(sessionId, client);
        clients.set(transportId, client);
        broadcastClientList();
        return client;
    }

    function enqueue(queue, script) {
        const item = { id: randomId(), script, createdAt: Date.now() };
        queue.push(item);
        while (queue.length > MAX_QUEUE_LENGTH) queue.shift();
        return item.id;
    }

    function queueForSession(sessionId, script) {
        if (!legacyQueues.has(sessionId)) legacyQueues.set(sessionId, []);
        return enqueue(legacyQueues.get(sessionId), script);
    }

    function dequeueForSession(sessionId) {
        const queue = legacyQueues.get(sessionId);
        if (queue && queue.length) return queue.shift();
        return globalLegacyQueue.shift() || null;
    }

    function sendError(socket, message) {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ Type: 'error', Tag: 'Execute', Message: message }));
        }
    }

    function sendGameMessage(client, message) {
        const payload = {
            Type: 'game_message',
            Tag: text(message.Tag, 'Output'),
            Message: message.Message,
            Values: Array.isArray(message.Values) ? message.Values : undefined,
            ClientId: client.transportId,
            SessionId: client.sessionId,
            PlayerName: client.playerName,
            GameName: client.gameName,
            JobId: client.jobId,
            PlaceId: client.placeId,
        };
        if (!payload.Values) delete payload.Values;
        sendToExtensions(payload);
    }

    function routeScript(sender, message) {
        const script = typeof message.Script === 'string' ? message.Script : '';
        if (!script.trim()) {
            sendError(sender.ws, 'Script is empty');
            return;
        }
        if (Buffer.byteLength(script, 'utf8') > MAX_BODY_BYTES) {
            sendError(sender.ws, 'Script is too large');
            return;
        }

        const requestedId = text(message.SessionId) || text(message.ClientId);
        const target = requestedId
            ? (sessions.get(requestedId) || clients.get(requestedId))
            : null;

        if (target) {
            if (target.protocol === 'loadstring' || !target.ws) {
                const requestId = queueForSession(target.sessionId, script);
                sender.ws.send(JSON.stringify({
                    Type: 'script_queued',
                    RequestId: requestId,
                    SessionId: target.sessionId,
                }));
                return;
            }
            if (target.ws.readyState !== WebSocket.OPEN) {
                removeSession(target, 'Target disconnected');
                sendError(sender.ws, 'Target client disconnected');
                return;
            }
            target.ws.send(JSON.stringify({
                Type: 'execute_script',
                Script: script,
                RequestId: text(message.RequestId) || randomId(),
            }));
            sender.ws.send(JSON.stringify({
                Type: 'script_sent',
                RequestId: text(message.RequestId),
                SessionId: target.sessionId,
            }));
            return;
        }

        if (message.Broadcast || requestedId === 'ALL_CLIENTS' || !requestedId) {
            let sent = 0;
            for (const client of sessions.values()) {
                if (client.protocol === 'loadstring' || !client.ws) {
                    queueForSession(client.sessionId, script);
                    sent += 1;
                } else if (client.ws.readyState === WebSocket.OPEN) {
                    client.ws.send(JSON.stringify({ Type: 'execute_script', Script: script }));
                    sent += 1;
                }
            }
            if (!sent) enqueue(globalLegacyQueue, script);
            sender.ws.send(JSON.stringify({ Type: 'script_queued', Broadcast: true, Count: sent }));
            return;
        }

        sendError(sender.ws, 'Target client not found');
    }

    function handleWebSocketMessage(record, raw) {
        const message = parseJson(raw.toString());
        if (!message || typeof message.Type !== 'string') return;
        touch();
        record.lastSeen = Date.now();

        switch (message.Type) {
            case 'register_extension':
                record.type = 'extension';
                record.extensionId = text(message.ExtensionId, randomId());
                extensionSockets.add(record.ws);
                record.ws.send(JSON.stringify({
                    Type: 'bridge_ready',
                    Version: VERSION,
                    BridgeId: bridgeId,
                }));
                record.ws.send(JSON.stringify({ Type: 'client_list', Clients: clientList() }));
                break;

            case 'register_game':
                registerGame(record.transportId, message, 'websocket', record.ws);
                record.sessionId = normalizeSessionId(message);
                break;

            case 'heartbeat':
                if (record.type === 'game') {
                    record.lastSeen = Date.now();
                    record.ws.send(JSON.stringify({ Type: 'heartbeat_ack' }));
                }
                break;

            case 'get_client_list':
                if (record.type === 'extension') {
                    record.ws.send(JSON.stringify({ Type: 'client_list', Clients: clientList() }));
                }
                break;

            case 'execute_script':
                if (record.type === 'extension') routeScript(record, message);
                break;

            case 'game_message':
                if (record.type === 'game') {
                    const client = sessions.get(record.sessionId);
                    if (client) sendGameMessage(client, message);
                }
                break;

            default:
                if (record.type === 'game') {
                    const client = sessions.get(record.sessionId);
                    if (client) sendGameMessage(client, {
                        Tag: message.Tag || 'Output',
                        Message: message.Message || raw.toString(),
                        Values: message.Values,
                    });
                }
                break;
        }
    }

    function handleHttp(req, res) {
        touch();
        const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

        if (req.method === 'GET' && requestUrl.pathname === '/health') {
            json(res, 200, {
                Service: SERVICE,
                Version: VERSION,
                BridgeId: bridgeId,
                Port: actualPort,
                Transports: ['websocket', 'loadstring'],
                Extensions: extensionSockets.size,
                MaxScriptBytes: MAX_BODY_BYTES,
                Pid: process.pid,
            });
            return;
        }

        if (req.method === 'GET' && requestUrl.pathname === '/clients') {
            json(res, 200, { Clients: clientList() });
            return;
        }

        if (req.method === 'GET' && requestUrl.pathname === '/received_script.lua') {
            const sessionId = text(requestUrl.searchParams.get('sessionId'));
            const item = sessionId ? dequeueForSession(sessionId) : globalLegacyQueue.shift();
            plain(res, 200, item ? item.script : '');
            return;
        }

        if (req.method !== 'POST') {
            plain(res, 404, 'Not Found');
            return;
        }

        readBody(req).then(body => {
            if (requestUrl.pathname === '/execute') {
                if (!body.trim()) {
                    plain(res, 400, 'Script is empty');
                    return;
                }
                const sessionId = text(requestUrl.searchParams.get('sessionId'))
                    || text(req.headers['x-vsexecutor-session']);
                const requestId = sessionId ? queueForSession(sessionId, body) : enqueue(globalLegacyQueue, body);
                json(res, 200, { Queued: true, RequestId: requestId, SessionId: sessionId || null });
                return;
            }

            if (requestUrl.pathname === '/legacy/register') {
                const data = parseJson(body);
                if (!data) {
                    json(res, 400, { Error: 'Invalid JSON' });
                    return;
                }
                const client = registerGame(`http:${normalizeSessionId(data)}`, data, 'loadstring', null);
                json(res, 200, { Registered: true, SessionId: client.sessionId });
                return;
            }

            if (requestUrl.pathname === '/legacy/heartbeat') {
                const data = parseJson(body) || {};
                const sessionId = normalizeSessionId(data);
                const client = sessions.get(sessionId);
                if (!client || client.protocol !== 'loadstring') {
                    json(res, 404, { Error: 'Session not found' });
                    return;
                }
                client.lastSeen = Date.now();
                json(res, 200, { Alive: true, SessionId: sessionId });
                return;
            }

            if (requestUrl.pathname === '/legacy/disconnect') {
                const data = parseJson(body) || {};
                const sessionId = normalizeSessionId(data);
                removeSession(sessions.get(sessionId), 'Legacy client disconnected');
                json(res, 200, { Disconnected: true });
                return;
            }

            if (requestUrl.pathname === '/legacy/message') {
                const data = parseJson(body);
                if (!data) {
                    json(res, 400, { Error: 'Invalid JSON' });
                    return;
                }
                const client = sessions.get(normalizeSessionId(data));
                if (!client) {
                    json(res, 404, { Error: 'Session not found' });
                    return;
                }
                client.lastSeen = Date.now();
                sendGameMessage(client, data);
                json(res, 200, { Accepted: true });
                return;
            }

            plain(res, 404, 'Not Found');
        }).catch(error => {
            if (!res.headersSent) json(res, 413, { Error: error.message });
        });
    }

    function removeStaleClients() {
        const now = Date.now();
        for (const client of sessions.values()) {
            if (now - client.lastSeen > PRESENCE_TIMEOUT_MS) {
                removeSession(client, 'Heartbeat timeout');
            }
        }
        if (!sessions.size && !extensionSockets.size && now - lastActivity > IDLE_TIMEOUT_MS) {
            clearInterval(sweepTimer);
            for (const socket of wss.clients) socket.close();
            wss.close(() => httpServer.close(() => process.exit(0)));
        }
    }

    return new Promise((resolve, reject) => {
        httpServer = http.createServer(handleHttp);
        wss = new WebSocket.Server({ server: httpServer, maxPayload: MAX_BODY_BYTES });

        wss.on('connection', socket => {
            const record = {
                transportId: randomId(),
                type: 'unknown',
                ws: socket,
                lastSeen: Date.now(),
            };
            clients.set(record.transportId, record);

            socket.on('pong', () => {
                record.lastSeen = Date.now();
            });
            socket.on('message', raw => {
                try {
                    handleWebSocketMessage(record, raw);
                } catch (error) {
                    sendError(socket, error.message);
                }
            });
            socket.on('close', () => {
                extensionSockets.delete(socket);
                if (record.type === 'game') removeSession(record, 'Socket closed');
                else clients.delete(record.transportId);
            });
            socket.on('error', () => {
                extensionSockets.delete(socket);
                if (record.type === 'game') removeSession(record, 'Socket error');
                else clients.delete(record.transportId);
            });
        });

        httpServer.once('error', reject);
        httpServer.listen(port, host, () => {
            actualPort = httpServer.address().port;
            sweepTimer = setInterval(removeStaleClients, SWEEP_INTERVAL_MS);
            console.log(`Server started on ${host}:${actualPort}`);
            process.stdout.write('Server started\n');
            resolve({
                service: SERVICE,
                version: VERSION,
                bridgeId,
                port: actualPort,
                host,
                close() {
                    clearInterval(sweepTimer);
                    for (const socket of wss.clients) socket.close();
                    return new Promise(done => {
                        wss.close(() => httpServer.close(() => done()));
                    });
                },
            });
        });
    });
}

module.exports = { startBridge, VERSION, SERVICE };

if (require.main === module) {
    const args = process.argv.slice(2);
    const portArg = args.find(arg => arg.startsWith('--port='));
    const hostArg = args.find(arg => arg.startsWith('--host='));
    startBridge({
        port: portArg ? Number(portArg.slice('--port='.length)) : DEFAULT_PORT,
        host: hostArg ? hostArg.slice('--host='.length) : DEFAULT_HOST,
    }).catch(error => {
        console.error('Failed to start VSExecutor bridge:', error.message);
        process.exitCode = 1;
    });
}
