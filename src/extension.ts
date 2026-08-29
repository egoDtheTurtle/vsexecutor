import * as vscode from 'vscode';
import * as path from 'path';
import * as http from 'http';
import * as os from 'os';
import * as process from 'process';
import { execFile, spawn } from 'child_process';
import * as crypto from 'crypto';
import WebSocket from 'ws';

import { OutputRecord, OutputValue, OutputView } from './output-view';

type Protocol = 'websocket' | 'loadstring';
type LoaderMode = Protocol;
const MAX_SCRIPT_BYTES = 8 * 1024 * 1024;

interface ClientInfo {
    clientId: string;
    sessionId: string;
    protocol: Protocol;
    playerName: string;
    gameName: string;
    jobId: string;
    placeId: string;
    lastSeen?: number;
}

interface BridgeHealth {
    Service: string;
    Version: string;
    BridgeId: string;
    Port: number;
    Transports: string[];
    MaxScriptBytes?: number;
    Pid?: number;
}

interface HttpResponse {
    status: number;
    body: string;
}

interface QuickPickClient extends vscode.QuickPickItem {
    sessionId: string;
    broadcast?: boolean;
}

let ws: WebSocket | undefined;
let outputChannel: vscode.OutputChannel;
let outputView: OutputView;
let executeButton: vscode.StatusBarItem;
let lastMainEditor: vscode.TextEditor | undefined;
let reconnectTimer: NodeJS.Timeout | undefined;
let reconnectDelay = 500;
let shuttingDown = false;
const connectedClients = new Map<string, ClientInfo>();

function config() {
    return vscode.workspace.getConfiguration('vsexecutor');
}

function bridgeHost() {
    return config().get<string>('host', 'localhost');
}

function bridgePort() {
    return config().get<number>('port', 1306);
}

function newId() {
    return typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : crypto.randomBytes(16).toString('hex');
}

function logToOutput(message: string) {
    outputChannel?.appendLine(message);
}

function formatLogMessage(tag: string, message: string, level = 'INFO') {
    const timestamp = new Date().toLocaleTimeString([], { hour12: false });
    const normalizedTag = tag.trim().toLowerCase();
    const label = normalizedTag === level.toLowerCase() ? level : `${level} [${tag}]`;
    return `${timestamp} ${label}: ${message}`;
}

function log(tag: string, message: string, level = 'INFO') {
    logToOutput(formatLogMessage(tag, message, level));
}

function levelForTag(tag: string) {
    const value = tag.toLowerCase();
    if (value.includes('error')) return 'ERROR';
    if (value.includes('warning')) return 'WARNING';
    if (value.includes('success')) return 'SUCCESS';
    if (value.includes('debug')) return 'DEBUG';
    return 'INFO';
}

function formatLegacyMessage(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value === undefined) return '';
    try {
        return JSON.stringify(value, null, 2);
    } catch (_) {
        return String(value);
    }
}

function formatOutputValue(value: OutputValue | unknown, depth = 0): string {
    if (!value || typeof value !== 'object') return String(value ?? 'nil');
    const typed = value as OutputValue;
    if (typed.kind === 'table') {
        const entries = typed.entries || [];
        const body = entries.map(entry => `${'  '.repeat(depth + 1)}${entry.key} = ${formatOutputValue(entry.value, depth + 1)}`).join('\n');
        const suffix = typed.truncated ? '\n' + '  '.repeat(depth + 1) + '... safety limit reached' : '';
        return `{${body ? `\n${body}\n${'  '.repeat(depth)}` : ''}${suffix}}`;
    }
    if (typed.kind === 'instance') {
        const details = [typed.className, typed.fullName].filter(Boolean).join(' | ');
        return details ? `${typed.name || 'Instance'} <${details}>` : (typed.name || 'Instance');
    }
    if (typed.kind === 'nil') return 'nil';
    if (typed.kind === 'userdata') return String(typed.value || 'userdata');
    return String(typed.value ?? 'nil');
}

function outputMessage(data: Record<string, unknown>) {
    const values = Array.isArray(data.Values) ? data.Values as OutputValue[] : undefined;
    return {
        text: values ? values.map(value => formatOutputValue(value)).join(' ') : formatLegacyMessage(data.Message),
        values,
    };
}

function makeClient(data: Record<string, unknown>): ClientInfo {
    const protocol = data.Protocol === 'loadstring' ? 'loadstring' : 'websocket';
    const clientId = String(data.ClientId || data.SessionId || newId());
    return {
        clientId,
        sessionId: String(data.SessionId || clientId),
        protocol,
        playerName: String(data.PlayerName || 'Unknown player'),
        gameName: String(data.GameName || 'Unknown game'),
        jobId: String(data.JobId || 'Unknown job'),
        placeId: String(data.PlaceId || 'Unknown place'),
        lastSeen: typeof data.LastSeen === 'number' ? data.LastSeen : undefined,
    };
}

function applyClientList(data: unknown) {
    const clients = data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).Clients)
        ? (data as Record<string, unknown>).Clients as unknown[]
        : [];
    connectedClients.clear();
    for (const value of clients) {
        if (!value || typeof value !== 'object') continue;
        const client = makeClient(value as Record<string, unknown>);
        connectedClients.set(client.sessionId, client);
    }
    updateButtonText();
}

function handleBridgeMessage(raw: WebSocket.RawData) {
    let data: Record<string, unknown>;
    try {
        const parsed = JSON.parse(raw.toString());
        if (!parsed || typeof parsed !== 'object') return;
        data = parsed as Record<string, unknown>;
    } catch (_) {
        log('Bridge', raw.toString(), 'WARNING');
        return;
    }

    const type = String(data.Type || '');
    if (type === 'bridge_ready') {
        log('Bridge', `Connected to bridge ${String(data.Version || '')}` , 'SUCCESS');
        return;
    }
    if (type === 'client_list') {
        applyClientList(data);
        return;
    }
    if (type === 'client_connected') {
        const client = makeClient(data);
        connectedClients.set(client.sessionId, client);
        updateButtonText();
        return;
    }
    if (type === 'client_disconnected') {
        const sessionId = String(data.SessionId || data.ClientId || '');
        connectedClients.delete(sessionId);
        updateButtonText();
        return;
    }
    if (type === 'script_sent' || type === 'script_queued') {
        log('Execute', type === 'script_sent' ? 'Script sent to the WebSocket client' : 'Script queued for the loadstring client', 'SUCCESS');
        return;
    }
    if (type === 'error') {
        log(String(data.Tag || 'Bridge'), String(data.Message || 'Unknown bridge error'), 'ERROR');
        return;
    }
    if (type !== 'game_message') return;

    const tag = String(data.Tag || 'Output');
    const level = levelForTag(tag);
    const message = outputMessage(data);
    const record: OutputRecord = {
        timestamp: new Date().toLocaleTimeString([], { hour12: false }),
        level,
        tag,
        message: message.text,
        values: message.values,
        gameName: typeof data.GameName === 'string' ? data.GameName : undefined,
        jobId: typeof data.JobId === 'string' ? data.JobId : undefined,
    };
    log(tag, message.text, level);
    outputView?.append(record);
}

function sendControl(message: Record<string, unknown>) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
        ws.send(JSON.stringify(message));
        return true;
    } catch (error) {
        log('Bridge', `Failed to send message: ${String(error)}`, 'ERROR');
        return false;
    }
}

function scheduleReconnect() {
    if (shuttingDown || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        connectControl();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
}

function connectControl() {
    if (shuttingDown || (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))) return;
    const socket = new WebSocket(`ws://${bridgeHost()}:${bridgePort()}`);
    ws = socket;
    socket.on('open', () => {
        reconnectDelay = 500;
        log('WebSocket', 'Control connection established', 'SUCCESS');
        sendControl({ Type: 'register_extension', ExtensionId: newId() });
        sendControl({ Type: 'get_client_list' });
    });
    socket.on('message', data => handleBridgeMessage(data));
    socket.on('error', error => log('WebSocket', String(error), 'ERROR'));
    socket.on('close', () => {
        if (ws !== socket) return;
        ws = undefined;
        connectedClients.clear();
        updateButtonText();
        log('WebSocket', 'Control connection closed', 'WARNING');
        scheduleReconnect();
    });
}

function requestHttp(method: string, requestPath: string, body?: string): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
        const request = http.request({
            hostname: bridgeHost(),
            port: bridgePort(),
            path: requestPath,
            method,
            headers: body === undefined ? undefined : {
                'Content-Type': 'text/plain; charset=utf-8',
                'Content-Length': Buffer.byteLength(body),
            },
        }, response => {
            const chunks: Buffer[] = [];
            response.on('data', chunk => chunks.push(Buffer.from(chunk)));
            response.on('end', () => resolve({
                status: response.statusCode || 0,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        request.setTimeout(1500, () => request.destroy(new Error('Bridge request timed out')));
        request.on('error', reject);
        if (body !== undefined) request.write(body);
        request.end();
    });
}

async function probeBridge(): Promise<BridgeHealth | undefined> {
    try {
        const response = await requestHttp('GET', '/health');
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`Port ${bridgePort()} is occupied by a non-VSExecutor service`);
        }
        const health = JSON.parse(response.body) as BridgeHealth;
        if (health.Service !== 'VSExecutor') {
            throw new Error(`Port ${bridgePort()} is occupied by another service`);
        }
        return health;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || String(error).includes('timed out')) return undefined;
        throw error;
    }
}

function runCommand(command: string, args: string[]) {
    return new Promise<string>((resolve, reject) => {
        execFile(command, args, { windowsHide: true }, (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout);
        });
    });
}

async function findListeningBridgePid() {
    if (process.platform !== 'win32') return undefined;
    const output = await runCommand('powershell.exe', [
        '-NoProfile',
        '-Command',
        `(Get-NetTCPConnection -LocalPort ${bridgePort()} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`,
    ]);
    const pid = Number(output.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

async function processCommandLine(pid: number) {
    if (process.platform !== 'win32') return '';
    return runCommand('powershell.exe', [
        '-NoProfile',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
    ]);
}

async function replaceStaleBridge(health: BridgeHealth) {
    const pid = health.Pid || await findListeningBridgePid();
    if (!pid || pid === process.pid) {
        throw new Error('An outdated VSExecutor bridge is running. Close the old bridge and reload VS Code.');
    }
    const commandLine = await processCommandLine(pid);
    if (!/server\.js/i.test(commandLine) || !/vsexecutor/i.test(commandLine)) {
        throw new Error('The existing bridge is outdated but was not safe to replace automatically.');
    }

    if (process.platform === 'win32') {
        await runCommand('taskkill.exe', ['/PID', String(pid), '/T', '/F']);
    } else {
        process.kill(pid);
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
            if (!(await probeBridge())) return;
        } catch (_) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

async function ensureBridge(context: vscode.ExtensionContext) {
    const existing = await probeBridge();
    if (existing && (existing.MaxScriptBytes || 0) >= MAX_SCRIPT_BYTES) {
        log('Bridge', `Reusing bridge ${existing.Version}`, 'INFO');
        return;
    }
    if (existing) await replaceStaleBridge(existing);

    const serverPath = path.join(context.extensionPath, 'server.js');
    const child = spawn(process.execPath, [serverPath, `--port=${bridgePort()}`, '--host=0.0.0.0'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.unref();

    let lastError: unknown;
    for (let attempt = 0; attempt < 12; attempt += 1) {
        try {
            const health = await probeBridge();
            if (health) return;
        } catch (error) {
            lastError = error;
            break;
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(100 * (attempt + 1), 500)));
    }
    throw lastError || new Error(`VSExecutor bridge did not start on port ${bridgePort()}`);
}

function visibleLineCount(editor: vscode.TextEditor) {
    return editor.visibleRanges.reduce((total, range) => total + range.end.line - range.start.line + 1, 0);
}

function isOutputLikeDocument(editor: vscode.TextEditor) {
    const language = editor.document.languageId.toLowerCase();
    if (language === 'log' || language === 'output') return true;
    const lineCount = Math.min(editor.document.lineCount, 8);
    for (let index = 0; index < lineCount; index += 1) {
        const line = editor.document.lineAt(index).text;
        if (/^\s*\d{1,2}:\d{2}:\d{2}\s+(INFO|SUCCESS|WARNING|ERROR|DEBUG)\s+\[/.test(line)) return true;
    }
    return false;
}

function getMainEditor(): vscode.TextEditor | undefined {
    const editors = vscode.window.visibleTextEditors.filter(editor => !editor.document.isClosed && !isOutputLikeDocument(editor));
    if (!editors.length) {
        return lastMainEditor && !lastMainEditor.document.isClosed && !isOutputLikeDocument(lastMainEditor)
            ? lastMainEditor
            : undefined;
    }
    const ranked = [...editors].sort((a, b) => {
        const area = visibleLineCount(b) - visibleLineCount(a);
        if (area) return area;
        return (a.viewColumn || Number.MAX_SAFE_INTEGER) - (b.viewColumn || Number.MAX_SAFE_INTEGER);
    });
    lastMainEditor = ranked[0];
    return lastMainEditor;
}

function updateButtonText() {
    if (!executeButton) return;
    const clients = Array.from(connectedClients.values());
    if (!clients.length) {
        executeButton.text = '$(circle-slash) No Clients';
        executeButton.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (clients.length === 1) {
        const client = clients[0];
        executeButton.text = `$(rocket) Execute → ${client.gameName}`;
        executeButton.backgroundColor = undefined;
    } else {
        executeButton.text = `$(rocket) Execute (${clients.length} clients)`;
        executeButton.backgroundColor = undefined;
    }
}

function updateButtonVisibility() {
    if (!executeButton) return;
    if (getMainEditor()) {
        executeButton.show();
        updateButtonText();
    } else {
        executeButton.hide();
    }
}

async function sendScript(script: string, client?: ClientInfo, broadcast = false) {
    if (Buffer.byteLength(script, 'utf8') > MAX_SCRIPT_BYTES) {
        const message = 'Script is larger than the 8 MiB bridge limit.';
        log('Execute', message, 'ERROR');
        vscode.window.showErrorMessage(message);
        return;
    }
    if (!sendControl({
        Type: 'execute_script',
        Script: script,
        SessionId: client?.sessionId,
        ClientId: client?.clientId,
        Broadcast: broadcast,
        RequestId: newId(),
    })) {
        vscode.window.showErrorMessage('VSExecutor is not connected to the bridge.');
        return;
    }
    if (broadcast) {
        vscode.window.showInformationMessage('Script queued for connected clients.');
    } else if (client) {
        vscode.window.showInformationMessage(`Script queued for ${client.gameName}.`);
    } else {
        vscode.window.showInformationMessage('Script queued for the legacy loader.');
    }
}

async function executeMainEditor() {
    const editor = getMainEditor();
    if (!editor) {
        vscode.window.showWarningMessage('Open a text editor before executing a script.');
        return;
    }
    const script = editor.document.getText();
    if (!script.trim()) {
        vscode.window.showWarningMessage('The main editor is empty.');
        return;
    }

    const clients = Array.from(connectedClients.values());
    if (clients.length === 0) {
        await sendScript(script);
        return;
    }
    if (clients.length === 1) {
        await sendScript(script, clients[0]);
        return;
    }

    const items: QuickPickClient[] = clients.map(client => ({
        label: client.gameName,
        description: `${client.protocol} | Job ID: ${client.jobId} | Player: ${client.playerName}`,
        detail: `Place ID: ${client.placeId}`,
        sessionId: client.sessionId,
    }));
    items.push({
        label: `$(broadcast) Execute All (${clients.length} clients)`,
        description: 'Send to every connected WebSocket and loadstring client',
        sessionId: 'ALL_CLIENTS',
        broadcast: true,
    });
    const selected = await vscode.window.showQuickPick(items, {
        title: 'Execute Script',
        placeHolder: 'Select a Roblox session',
    });
    if (!selected) return;
    await sendScript(script, selected.broadcast ? undefined : connectedClients.get(selected.sessionId), Boolean(selected.broadcast));
}

function ipv4Addresses() {
    const addresses: Array<{ address: string; name: string }> = [];
    for (const [name, infos] of Object.entries(os.networkInterfaces())) {
        for (const info of infos || []) {
            const family = String(info.family);
            if ((family === 'IPv4' || family === '4') && !info.internal) {
                addresses.push({ address: info.address, name });
            }
        }
    }
    return addresses;
}

async function copyIPv4() {
    const addresses = ipv4Addresses();
    if (!addresses.length) {
        vscode.window.showWarningMessage('No non-internal IPv4 address was found.');
        return;
    }
    let selected = addresses[0];
    if (addresses.length > 1) {
        const pick = await vscode.window.showQuickPick(addresses.map(value => ({
            label: value.address,
            description: value.name,
            value,
        })), { placeHolder: 'Select an IPv4 address to copy' });
        if (!pick) return;
        selected = pick.value;
    }
    await vscode.env.clipboard.writeText(selected.address);
    vscode.window.showInformationMessage(`Copied ${selected.address} (${selected.name}).`);
}

async function copyAutoexec() {
    const defaultMode = config().get<LoaderMode>('defaultLoaderMode', 'websocket');
    const selected = await vscode.window.showQuickPick([
        { label: 'WebSocket', description: 'Recommended current transport', mode: 'websocket' as LoaderMode },
        { label: 'Loadstring / HTTP', description: 'Legacy v0.0.2-compatible polling transport', mode: 'loadstring' as LoaderMode },
    ], {
        placeHolder: `Select loader mode (default: ${defaultMode})`,
    });
    if (!selected) return;

    await config().update('defaultLoaderMode', selected.mode, vscode.ConfigurationTarget.Global);
    const snippet = [
        'local Params = {',
        '    RepoURL = "https://raw.githubusercontent.com/egoDtheTurtle/vsexecutor/main/",',
        '    SSI = "src/vsexecutor",',
        '}',
        '',
        'loadstring(game:HttpGet(Params.RepoURL .. Params.SSI .. ".lua", true), Params.SSI)()({',
        '    ["Log Game Output"] = false,',
        '    ["Ethernet IPv4"] = "",',
        `    ["Loader Mode"] = "${selected.mode}",`,
        '})',
    ].join('\n');
    await vscode.env.clipboard.writeText(snippet);
    vscode.window.showInformationMessage(`Copied ${selected.label} autoexec loader.`);
}

async function refreshClients() {
    sendControl({ Type: 'get_client_list' });
    try {
        const response = await requestHttp('GET', '/clients');
        if (response.status >= 200 && response.status < 300) applyClientList(JSON.parse(response.body));
    } catch (error) {
        log('Bridge', `Client refresh failed: ${String(error)}`, 'WARNING');
    }
}

export async function activate(context: vscode.ExtensionContext) {
    shuttingDown = false;
    outputChannel = vscode.window.createOutputChannel('VSExecutor', 'log');
    outputView = new OutputView(context);
    outputChannel.show(true);

    try {
        await ensureBridge(context);
    } catch (error) {
        log('Bridge', String(error), 'ERROR');
        vscode.window.showErrorMessage(`VSExecutor bridge unavailable: ${String(error)}`);
    }

    executeButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    executeButton.command = 'extension.executeFile';
    executeButton.tooltip = 'Execute the main visible text editor';
    updateButtonVisibility();

    context.subscriptions.push(
        executeButton,
        outputView,
        vscode.window.onDidChangeActiveTextEditor(updateButtonVisibility),
        vscode.window.onDidChangeVisibleTextEditors(updateButtonVisibility),
        vscode.commands.registerCommand('extension.executeFile', executeMainEditor),
        vscode.commands.registerCommand('extension.copyIPv4', copyIPv4),
        vscode.commands.registerCommand('extension.copyAutoexec', copyAutoexec),
        vscode.commands.registerCommand('extension.refreshClients', refreshClients),
        vscode.commands.registerCommand('extension.openOutputViewer', () => outputView.show()),
        new vscode.Disposable(() => {
            if (reconnectTimer) clearTimeout(reconnectTimer);
            ws?.close();
        }),
    );

    connectControl();
}

export function deactivate() {
    shuttingDown = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    ws?.close();
    ws = undefined;
    outputView?.dispose();
}
