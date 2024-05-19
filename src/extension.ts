import * as vscode from 'vscode';
import * as http from 'http';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {

    // Start the server when the extension is activated
    const serverScriptPath = path.join(__dirname, 'server.js'); // Path to your server script
    const serverScript = require(serverScriptPath);
    http.createServer(serverScript);
    
    // Create the Execute button
    let executeButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    executeButton.text = "$(rocket) Execute";
    executeButton.command = "extension.executeFile";
    executeButton.show();

    // Register the command to execute a file
    let disposable = vscode.commands.registerCommand('extension.executeFile', () => {
        let editor = vscode.window.activeTextEditor;
        if (editor) {
            let content = editor.document.getText();
            let options = {
                hostname: 'localhost',
                port: 1306,
                path: '/execute',
                method: 'POST',
                headers: {
                    'Content-Type': 'text/plain',
                    'Content-Length': Buffer.byteLength(content)
                }
            };

            let req = http.request(options, (res) => {
                let responseBody = '';
                res.on('data', (chunk) => {
                    responseBody += chunk.toString();
                });
                res.on('end', () => {
                    vscode.window.showInformationMessage('Server response: ' + responseBody);
                });
            });

            req.on('error', (e) => {
                vscode.window.showErrorMessage('Problem with request: ' + e.message);
            });

            req.write(content);
            req.end();
        }
    });

    // Subscribe to the command and button
    context.subscriptions.push(executeButton);
    context.subscriptions.push(disposable);

}

export function deactivate() {}