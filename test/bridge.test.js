const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const WebSocket = require('ws');
const { startBridge } = require('../server');

function request(port, method, path, body) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path,
            method,
            headers: body === undefined ? undefined : {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject);
        if (body !== undefined) req.write(body);
        req.end();
    });
}

function connect(port) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}`);
        socket.once('open', () => resolve(socket));
        socket.once('error', reject);
    });
}

function messages(socket) {
    const values = [];
    socket.on('message', data => {
        try { values.push(JSON.parse(data.toString())); } catch (_) { /* ignore */ }
    });
    return values;
}

async function waitFor(values, predicate) {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
        const value = values.find(predicate);
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for bridge message');
}

test('bridge routes both protocols and replaces duplicate sessions', async t => {
    const bridge = await startBridge({ host: '127.0.0.1', port: 0 });
    t.after(() => bridge.close());
    const port = bridge.port;

    const extension = await connect(port);
    const extensionMessages = messages(extension);
    extension.send(JSON.stringify({ Type: 'register_extension', ExtensionId: 'test-extension' }));
    await waitFor(extensionMessages, message => message.Type === 'bridge_ready');
    const health = await request(port, 'GET', '/health');
    assert.equal(JSON.parse(health.body).Extensions, 1);
    assert.ok(JSON.parse(health.body).MaxScriptBytes >= 8 * 1024 * 1024);

    const firstGame = await connect(port);
    const firstMessages = messages(firstGame);
    firstGame.send(JSON.stringify({
        Type: 'register_game',
        SessionId: 'job:user',
        PlayerName: 'Player',
        GameName: 'Test Game',
        JobId: 'job',
        PlaceId: '1',
    }));
    const firstList = await waitFor(extensionMessages, message => message.Type === 'client_list' && message.Clients.length === 1);
    assert.equal(firstList.Clients[0].GameName, 'Test Game');

    const secondGame = await connect(port);
    const secondMessages = messages(secondGame);
    secondGame.send(JSON.stringify({
        Type: 'register_game',
        SessionId: 'job:user',
        PlayerName: 'Player',
        GameName: 'Test Game',
        JobId: 'job',
        PlaceId: '1',
    }));
    const replacedList = await waitFor(extensionMessages, message => message.Type === 'client_list' && message.Clients.length === 1 && message.Clients[0].ClientId !== firstList.Clients[0].ClientId);
    assert.equal(replacedList.Clients[0].SessionId, 'job:user');

    extension.send(JSON.stringify({ Type: 'execute_script', SessionId: 'job:user', Script: 'return 42' }));
    const execution = await waitFor(secondMessages, message => message.Type === 'execute_script');
    assert.equal(execution.Script, 'return 42');

    const largeScript = 'local value = 1\n'.repeat(140_000);
    extension.send(JSON.stringify({ Type: 'execute_script', SessionId: 'job:user', Script: largeScript }));
    const largeExecution = await waitFor(secondMessages, message => message.Type === 'execute_script' && message.Script && message.Script.length === largeScript.length);
    assert.equal(largeExecution.Script.length, largeScript.length);

    const legacyPayload = JSON.stringify({
        SessionId: 'legacy-job:user',
        PlayerName: 'Legacy Player',
        GameName: 'Legacy Game',
        JobId: 'legacy-job',
        PlaceId: '2',
        UserId: 'user',
    });
    const registration = await request(port, 'POST', '/legacy/register', legacyPayload);
    assert.equal(registration.status, 200);
    const queued = await request(port, 'POST', '/execute?sessionId=legacy-job%3Auser', 'print(1)');
    assert.equal(queued.status, 200);
    const consumed = await request(port, 'GET', '/received_script.lua?sessionId=legacy-job%3Auser');
    assert.equal(consumed.body, 'print(1)');
    const empty = await request(port, 'GET', '/received_script.lua?sessionId=legacy-job%3Auser');
    assert.equal(empty.body, '');

    const legacyMessage = JSON.stringify({
        SessionId: 'legacy-job:user',
        Tag: 'Output',
        Message: 'hello',
        Values: [{ kind: 'text', value: 'hello' }],
    });
    await request(port, 'POST', '/legacy/message', legacyMessage);
    const output = await waitFor(extensionMessages, message => message.Type === 'game_message' && message.SessionId === 'legacy-job:user');
    assert.equal(output.Values[0].value, 'hello');

    secondGame.close();
    await waitFor(extensionMessages, message => message.Type === 'client_list' && message.Clients.length === 1 && message.Clients[0].SessionId === 'legacy-job:user');
    firstGame.close();
    extension.close();
});

test('shared bridge keeps other extension windows connected', async t => {
    const bridge = await startBridge({ host: '127.0.0.1', port: 0 });
    t.after(() => bridge.close());
    const port = bridge.port;
    const first = await connect(port);
    const second = await connect(port);
    const firstMessages = messages(first);
    const secondMessages = messages(second);
    first.send(JSON.stringify({ Type: 'register_extension', ExtensionId: 'window-1' }));
    second.send(JSON.stringify({ Type: 'register_extension', ExtensionId: 'window-2' }));
    await waitFor(firstMessages, message => message.Type === 'bridge_ready');
    await waitFor(secondMessages, message => message.Type === 'bridge_ready');

    const game = await connect(port);
    game.send(JSON.stringify({
        Type: 'register_game',
        SessionId: 'shared-job:user',
        PlayerName: 'Player',
        GameName: 'Shared Game',
        JobId: 'shared-job',
        PlaceId: '3',
    }));
    await waitFor(firstMessages, message => message.Type === 'client_list' && message.Clients.length === 1);
    await waitFor(secondMessages, message => message.Type === 'client_list' && message.Clients.length === 1);

    first.close();
    await new Promise(resolve => setTimeout(resolve, 20));
    game.send(JSON.stringify({ Type: 'game_message', Tag: 'Output', Message: 'still connected' }));
    const output = await waitFor(secondMessages, message => message.Type === 'game_message' && message.Message === 'still connected');
    assert.equal(output.GameName, 'Shared Game');
    second.close();
    game.close();
});
