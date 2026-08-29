import * as vscode from 'vscode';

export interface OutputValue {
    kind: string;
    value?: unknown;
    name?: string;
    className?: string;
    fullName?: string;
    entries?: Array<{ key: string; value: OutputValue }>;
    truncated?: boolean;
}

export interface OutputRecord {
    timestamp: string;
    level: string;
    tag: string;
    message: string;
    values?: OutputValue[];
    gameName?: string;
    jobId?: string;
}

export class OutputView implements vscode.Disposable {
    private panel?: vscode.WebviewPanel;
    private readonly records: OutputRecord[] = [];

    constructor(private readonly context: vscode.ExtensionContext) {}

    show() {
        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel(
                'vsexecutorOutput',
                'VSExecutor Output',
                vscode.ViewColumn.Beside,
                { enableScripts: true, retainContextWhenHidden: true },
            );
            this.panel.webview.html = this.html();
            this.panel.webview.onDidReceiveMessage(message => {
                if (message.type === 'ready') {
                    this.panel?.webview.postMessage({ type: 'replace', records: this.records });
                }
            }, null, this.context.subscriptions);
            this.panel.onDidDispose(() => {
                this.panel = undefined;
            }, null, this.context.subscriptions);
        } else {
            this.panel.reveal(vscode.ViewColumn.Beside);
        }

        this.panel.webview.postMessage({ type: 'replace', records: this.records });
    }

    append(record: OutputRecord) {
        this.records.push(record);
        if (this.records.length > 500) this.records.shift();
        this.panel?.webview.postMessage({ type: 'append', record });
    }

    clear() {
        this.records.length = 0;
        this.panel?.webview.postMessage({ type: 'replace', records: [] });
    }

    dispose() {
        this.panel?.dispose();
        this.panel = undefined;
    }

    private html() {
        return String.raw`<!doctype html>
<html>
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<style>
    :root { color-scheme: light dark; }
    body { margin: 0; padding: 12px 16px; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font: 13px var(--vscode-editor-font-family); }
    #log { display: flex; flex-direction: column; gap: 8px; }
    .entry { border: 1px solid var(--vscode-panel-border); border-radius: 5px; padding: 8px 10px; background: var(--vscode-textCodeBlock-background); }
    .meta { color: var(--vscode-descriptionForeground); font-size: 11px; margin-bottom: 4px; }
    .message { white-space: pre-wrap; overflow-wrap: anywhere; }
    .error { border-left: 3px solid var(--vscode-testing-iconFailed); }
    .warning { border-left: 3px solid var(--vscode-editorWarning-foreground); }
    .success { border-left: 3px solid var(--vscode-testing-iconPassed); }
    details { margin-top: 6px; }
    summary { cursor: pointer; color: var(--vscode-descriptionForeground); }
    .table { margin: 4px 0 0 12px; border-left: 1px solid var(--vscode-panel-border); padding-left: 10px; }
    .key { color: var(--vscode-symbolIcon-keywordForeground); }
    .object { color: var(--vscode-descriptionForeground); cursor: pointer; text-decoration: underline dotted; }
    .object-details { color: var(--vscode-descriptionForeground); margin-left: 6px; }
    .empty { color: var(--vscode-descriptionForeground); padding: 24px; text-align: center; }
</style>
</head>
<body>
<div id="log"><div class="empty">No output yet.</div></div>
<script>
const vscodeApi = acquireVsCodeApi();
const root = document.getElementById('log');
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const primitive = value => '<span>' + esc(value) + '</span>';
function renderValue(value) {
    if (!value) return primitive('nil');
    if (value.kind === 'table') {
        const entries = (value.entries || []).map(entry => '<div><span class="key">' + esc(entry.key) + '</span> = ' + renderValue(entry.value) + '</div>').join('');
        const suffix = value.truncated ? ' (safety limit reached)' : '';
        return '<details><summary>table' + esc(suffix) + '</summary><div class="table">' + (entries || primitive('{}')) + '</div></details>';
    }
    if (value.kind === 'instance') {
        const label = esc(value.name || 'Instance');
        const details = [value.className, value.fullName].filter(Boolean).join(' | ');
        return '<span class="object" tabindex="0" title="' + esc(details) + '" onclick="this.nextElementSibling.hidden = !this.nextElementSibling.hidden">' + label + '</span><span class="object-details" hidden>' + esc(details) + '</span>';
    }
    if (value.kind === 'nil') return primitive('nil');
    if (value.kind === 'userdata') return primitive(value.value || 'userdata');
    return primitive(value.value);
}
function render(record) {
    const entry = document.createElement('article');
    entry.className = 'entry ' + String(record.level || '').toLowerCase();
    const context = [record.gameName, record.jobId].filter(Boolean).join(' | ');
    const tag = String(record.tag || '');
    const level = String(record.level || 'INFO');
    const tagPart = tag.toLowerCase() === level.toLowerCase() ? '' : ' [' + tag + ']';
    const values = Array.isArray(record.values) && record.values.length
        ? record.values.map(renderValue).join(' ')
        : primitive(record.message);
    entry.innerHTML = '<div class="meta">' + esc(record.timestamp) + ' ' + esc(level) + esc(tagPart) + (context ? ' | ' + esc(context) : '') + '</div><div class="message">' + values + '</div>';
    root.appendChild(entry);
    while (root.children.length > 500) root.removeChild(root.firstChild);
    entry.scrollIntoView({ block: 'end' });
}
function replace(records) {
    root.innerHTML = '';
    if (!records.length) { root.innerHTML = '<div class="empty">No output yet.</div>'; return; }
    records.forEach(render);
}
window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'replace') replace(message.records || []);
    if (message.type === 'append') {
        if (root.querySelector('.empty')) root.innerHTML = '';
        render(message.record);
    }
});
vscodeApi.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
    }
}
