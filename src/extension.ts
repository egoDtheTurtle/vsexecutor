import * as vscode from 'vscode';
import * as path from 'path';
import * as net from 'net';
import * as process from 'process';

import WebSocket from 'ws';

import { exec } from 'child_process';
import { spawn } from 'child_process';

let ws: WebSocket;
let outputChannel: vscode.OutputChannel;
let executeButton: vscode.StatusBarItem;
let connectedClients: Map<string, string> = new Map(); // clientId -> playerName

export async function activate(context: vscode.ExtensionContext) {
    console.log('Extension activated!');
    
    // Start the server and wait for WebSocket to be ready
    try {
        await startServer();
        // Wait for a bit to ensure the WebSocket server is fully initialized
        await new Promise(resolve => setTimeout(resolve, 1000)); // Adjust delay as needed
    } catch (err) {
        console.error('Error while starting the server:', err);
        vscode.window.showErrorMessage('Failed to start the WebSocket server.');
        return;
    }

    // Create an output channel with language support for better formatting
    outputChannel = vscode.window.createOutputChannel('VSExecutor', 'log');
    outputChannel.show(); // Show the output channel

    // Create a button in the status bar
    executeButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    executeButton.text = "$(rocket) Execute Lua";
    executeButton.command = "extension.executeFile";
    executeButton.tooltip = "Execute current Lua file";
    executeButton.show();

    // Update button visibility based on active editor
    updateButtonVisibility();

    // Listen for active editor changes to show/hide the button
    vscode.window.onDidChangeActiveTextEditor(() => {
        updateButtonVisibility();
    });

    // WebSocket connection setup
    ws = new WebSocket('ws://localhost:1306');

    ws.on('open', () => {
        logToOutput(formatLogMessage('WebSocket', 'Connection established successfully', LogLevel.SUCCESS));
        
        // Register as VS Code extension
        ws.send(JSON.stringify({ Type: 'register_extension' }));
        
        // Request current client list after a short delay
        setTimeout(() => {
            ws.send(JSON.stringify({ Type: 'get_client_list' }));
        }, 100);
    });

    ws.on('message', (data) => {
        let message: string;

        if (typeof data === 'string') {
            message = data;
        } else if (data instanceof Buffer || data instanceof ArrayBuffer) {
            message = Buffer.isBuffer(data) ? data.toString() : new TextDecoder().decode(data);
        } else {
            message = String(data);
        }

        let logtag: string;
        let logmessage: string;
        let logLevel: LogLevel = LogLevel.INFO;

        try {
            const parsedData = JSON.parse(message);
            
            logtag = parsedData.Tag || "Output";

            // Handle client connection messages
            if (parsedData.Type === 'client_connected') {
                const clientId = parsedData.ClientId;
                const playerName = parsedData.PlayerName;
                connectedClients.set(clientId, playerName);
                updateButtonText();
                return;
            }

            // Handle client disconnection messages
            if (parsedData.Type === 'client_disconnected') {
                const clientId = parsedData.ClientId;
                const playerName = connectedClients.get(clientId) || 'Unknown';
                connectedClients.delete(clientId);
                updateButtonText();
                return;
            }

            // Handle client list updates
            if (parsedData.Type === 'client_list') {
                connectedClients.clear();
                if (parsedData.Clients && Array.isArray(parsedData.Clients)) {
                    parsedData.Clients.forEach((client: any) => {
                        connectedClients.set(client.ClientId, client.PlayerName);
                    });
                }
                updateButtonText();
                return;
            }

            // Handle game messages
            if (parsedData.Type === 'game_message') {
                logtag = parsedData.Tag || "Output";
                logmessage = parsedData.Message;
                
                // Determine log level based on tag or content
                if (logtag.toLowerCase().includes('error')) {
                    logLevel = LogLevel.ERROR;
                } else if (logtag.toLowerCase().includes('warning')) {
                    logLevel = LogLevel.WARNING;
                } else if (logtag.toLowerCase().includes('success')) {
                    logLevel = LogLevel.SUCCESS;
                } else if (logtag.toLowerCase().includes('debug')) {
                    logLevel = LogLevel.DEBUG;
                }
                
                const formattedMessage = formatLogMessage(logtag, logmessage, logLevel);
                logToOutput(formattedMessage);
                return;
            }

            let templogmessage = JSON.stringify(parsedData.Message);

            if (templogmessage.startsWith('[') && templogmessage.endsWith(']')) {
                templogmessage = templogmessage.slice(1, -1);
                templogmessage = templogmessage.replace(/(?<!\\)"/g, '');
                templogmessage = templogmessage.replace(/\\"/g, '"');
            }

            logmessage = templogmessage;
            
            // Determine log level based on tag or content
            if (logtag.toLowerCase().includes('error')) {
                logLevel = LogLevel.ERROR;
            } else if (logtag.toLowerCase().includes('warning')) {
                logLevel = LogLevel.WARNING;
            } else if (logtag.toLowerCase().includes('success')) {
                logLevel = LogLevel.SUCCESS;
            } else if (logtag.toLowerCase().includes('debug')) {
                logLevel = LogLevel.DEBUG;
            }
            
        } catch (err) {
            logtag = "WebSocket";
            logmessage = message;
            logLevel = LogLevel.WEBSOCKET;
        }

        logToOutput(formatLogMessage(logtag, logmessage, logLevel));
    });

    ws.on('error', (error: Error) => {
        logToOutput(formatLogMessage('WebSocket Error', `Error: ${error}`, LogLevel.ERROR));
    });

    ws.on('close', () => {
        logToOutput(formatLogMessage('WebSocket', 'Connection closed', LogLevel.WARNING));
    });

    let disposable = vscode.commands.registerCommand('extension.executeFile', async () => {
        const activeEditor = vscode.window.activeTextEditor;
        
        if (activeEditor && activeEditor.document.languageId !== 'Log') {
            const fileName = activeEditor.document.fileName;
            const languageId = activeEditor.document.languageId;
            
            // Check if the file is a Lua file
            if (languageId !== 'lua') {
                logToOutput(formatLogMessage('Execute', `File type '${languageId}' is not supported. Only Lua files can be executed.`, LogLevel.ERROR));
                vscode.window.showErrorMessage(`Only Lua files can be executed. Current file type: ${languageId}`);
                return;
            }

            const text = activeEditor.document.getText().trim(); // Trim whitespace from the text

            // Check if text has content
            if (text) {                
                // Check if WebSocket is open
                if (ws.readyState === WebSocket.OPEN) {
                    // Check connected clients
                    if (connectedClients.size === 0) {
                        logToOutput(formatLogMessage('Execute', 'No clients connected to execute script', LogLevel.ERROR));
                        vscode.window.showErrorMessage('No clients connected. Please connect a client first.');
                        return;
                    } else if (connectedClients.size === 1) {
                        // Single client - send directly
                        const [clientId, playerName] = Array.from(connectedClients.entries())[0];
                        await sendScriptToClient(text, clientId, playerName, fileName);
                    } else {
                        // Multiple clients - show selection dropdown
                        const clientOptions = Array.from(connectedClients.entries()).map(([clientId, playerName]) => ({
                            label: playerName,
                            description: `Client ID: ${clientId}`,
                            clientId: clientId
                        }));

                        // Add "Execute All" option at the bottom
                        clientOptions.push({
                            label: `$(broadcast) Execute All (${connectedClients.size} clients)`,
                            description: 'Send script to all connected clients',
                            clientId: 'ALL_CLIENTS'
                        });

                        const selectedClient = await vscode.window.showQuickPick(clientOptions, {
                            placeHolder: 'Select a client to execute the script',
                            title: `Execute Lua Script - ${connectedClients.size} clients available`
                        });

                        if (selectedClient) {
                            if (selectedClient.clientId === 'ALL_CLIENTS') {
                                // Execute on all clients
                                await executeOnAllClients(text, fileName);
                            } else {
                                // Execute on selected client
                                await sendScriptToClient(text, selectedClient.clientId, selectedClient.label, fileName);
                            }
                        } else {
                            logToOutput(formatLogMessage('Execute', 'Script execution cancelled by user', LogLevel.WARNING));
                        }
                    }
                } else {
                    // Show error message if WebSocket is not open
                    logToOutput(formatLogMessage('Execute', 'WebSocket connection is not open', LogLevel.ERROR));
                    vscode.window.showInformationMessage('WebSocket connection is not open. Please check the connection.');
                }
            } else {
                // Show error message if text is empty
                logToOutput(formatLogMessage('Execute', `${fileName} file is empty - nothing to send`, LogLevel.WARNING));
                vscode.window.showInformationMessage(`${fileName} file is empty. Nothing to send.`);
            }
        } else {
            // Show error message if there is no active editor
            logToOutput(formatLogMessage('Execute', 'No active editor found or log file selected', LogLevel.WARNING));
            vscode.window.showInformationMessage('No active editor found. Please open a Lua file to execute.');
        }
    });

    context.subscriptions.push(disposable, executeButton);
}

// Function to send script to a specific client
async function sendScriptToClient(script: string, clientId: string, playerName: string, fileName: string) {
    const message = {
        Type: 'execute_script',
        ClientId: clientId,
        Script: script
    };

    try {
        ws.send(JSON.stringify(message));
        logToOutput(formatLogMessage('Execute', `Script sent to "${playerName}" (${clientId})`, LogLevel.SUCCESS));
        vscode.window.showInformationMessage(`Script sent to "${playerName}" successfully.`);
    } catch (error) {
        logToOutput(formatLogMessage('Execute', `Failed to send script to "${playerName}": ${error}`, LogLevel.ERROR));
        vscode.window.showErrorMessage(`Failed to send script to "${playerName}".`);
    }
}

// Function to execute script on all connected clients
async function executeOnAllClients(script: string, fileName: string) {
    const clientCount = connectedClients.size;
    let successCount = 0;
    let failureCount = 0;

    logToOutput(formatLogMessage('Execute', `Broadcasting script to ${clientCount} clients...`, LogLevel.SUCCESS));

    for (const [clientId, playerName] of connectedClients.entries()) {
        const message = {
            Type: 'execute_script',
            ClientId: clientId,
            Script: script
        };

        try {
            ws.send(JSON.stringify(message));
            logToOutput(formatLogMessage('Execute', `Script sent to "${playerName}" (${clientId})`, LogLevel.SUCCESS));
            successCount++;
        } catch (error) {
            logToOutput(formatLogMessage('Execute', `Failed to send script to "${playerName}": ${error}`, LogLevel.ERROR));
            failureCount++;
        }
    }

    // Show summary message
    if (failureCount === 0) {
        vscode.window.showInformationMessage(`Script successfully sent to all ${successCount} clients.`);
        logToOutput(formatLogMessage('Execute', `✅ Broadcast completed: ${successCount}/${clientCount} clients reached`, LogLevel.SUCCESS));
    } else {
        vscode.window.showWarningMessage(`Script sent to ${successCount}/${clientCount} clients. ${failureCount} failed.`);
        logToOutput(formatLogMessage('Execute', `⚠️ Broadcast completed with errors: ${successCount} succeeded, ${failureCount} failed`, LogLevel.WARNING));
    }
}

// Function to update button text based on connected clients
function updateButtonText() {
    const clientCount = connectedClients.size;
    if (clientCount === 0) {
        executeButton.text = "$(circle-slash) No Clients";
        executeButton.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (clientCount === 1) {
        const playerName = Array.from(connectedClients.values())[0];
        executeButton.text = `$(rocket) Execute → ${playerName}`;
        executeButton.backgroundColor = undefined;
    } else {
        executeButton.text = `$(rocket) Execute (${clientCount} clients)`;
        executeButton.backgroundColor = undefined;
    }
}

// Function to update button visibility based on active editor language
function updateButtonVisibility() {
    const activeEditor = vscode.window.activeTextEditor;
    
    if (activeEditor && activeEditor.document.languageId === 'lua') {
        executeButton.show();
        updateButtonText(); // Update text based on connected clients
    } else if (activeEditor && activeEditor.document.languageId !== 'Log') {
        executeButton.show();
        executeButton.text = "$(circle-slash) Lua Only";
        executeButton.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
        executeButton.hide();
    }
}

// Function to check if port is in use
function isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', (error: any) => {
            if (error.code === 'EADDRINUSE') {
                resolve(true); // Port is in use
            } else {
                resolve(false); // Other error, port is available
            }
        });
        server.once('listening', () => {
            server.close();
            resolve(false); // Port is available
        });
        server.listen(port);
    });
}

// Function to kill the process using the port
function killProcessUsingPort(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
        if (process.platform === 'win32') {
            exec(`netstat -ano | findstr :${port}`, (err: any, stdout: any, stderr: any) => {
                if (err || stderr) {
                    if (err) {
                        console.log(`Error finding process using port ${port}: ${stderr || err.message}`);
                    }
                    resolve(); // Proceed if no process using port
                    return;
                }

                const lines = stdout.split('\n');
                const pidLine = lines.find((line: any) => line.includes(`:${port}`));

                if (pidLine) {
                    const pid = pidLine.trim().split(/\s+/).pop(); // Extract PID from the line

                    if (pid) {
                        exec(`taskkill /PID ${pid} /F`, (killErr: any, killStdout: any, killStderr: any) => {
                            if (killErr) {
                                console.log(`Error killing process: ${killErr.message}`);
                            } else {
                                console.log(`Killed process using port ${port}`);
                            }
                            resolve(); // Continue after killing the process
                        });
                    } else {
                        resolve(); // No PID found, proceed
                    }
                } else {
                    resolve(); // No process found using the port, proceed
                }
            });
        } else {
            exec(`lsof -t -i:${port}`, (err: any, stdout: any, stderr: any) => {
                if (err || stderr) {
                    if (err) {
                        console.log(`Error finding process using port ${port}: ${stderr || err.message}`);
                    }
                    resolve(); // Proceed if no process using port
                    return;
                }

                const pid = stdout.trim();
                if (pid) {
                    exec(`kill -9 ${pid}`, (killErr: any, killStdout: any, killStderr: any) => {
                        if (killErr) {
                            console.log(`Error killing process: ${killErr.message}`);
                        } else {
                            console.log(`Killed process using port ${port}`);
                        }
                        resolve(); // Continue after killing the process
                    });
                } else {
                    resolve(); // No process found, proceed
                }
            });
        }
    });
}

// Function to start the server
async function startServer() {
    const port = 1306;

    // Check if port is in use
    const inUse = await isPortInUse(port);
    if (inUse) {
        console.log(`Port ${port} is in use. Attempting to kill the process using it...`);
        await killProcessUsingPort(port);
    }

    // After killing the process (if needed), start the WebSocket server
    await startWebSocketServer();
}

// Function to actually start the WebSocket server
function startWebSocketServer(): Promise<void> {
    return new Promise((resolve, reject) => {
        // Get the extension's root path dynamically from the `extensionContext`
        const extensionRootPath = vscode.extensions.getExtension('egodtheturtle.vsexecutor')?.extensionPath;
        if (!extensionRootPath) {
            reject(new Error('Unable to find the extension root path.'));
            return;
        }

        // Resolve the path to the server.js file relative to the extension root directory
        const serverPath = path.join(extensionRootPath, 'server.js');  // Adjust this based on the actual location of server.js

        console.log('Starting server with path:', serverPath); // Debugging the path

        // Spawn the WebSocket server in the background
        const startServerCommand = spawn(process.execPath, [serverPath]);

        // Capture stdout and stderr to log them
        startServerCommand.stdout?.on('data', (data: any) => {
            // console.log(data);
            // Check for specific logs indicating that the server has started
            if (data.toString().includes('Server started')) {
                console.log("Server started")
                resolve(); // Resolve when the server confirms it's started
            }
        });

        startServerCommand.stderr?.on('data', (data: any) => {
            console.error(`stderr: ${data}`);
        });

        startServerCommand.on('error', (err: any) => {
            console.error(`Failed to start server: ${err.message}`);
            reject(err);
        });

        startServerCommand.on('close', (code: any) => {
            console.log(`Server process closed with code ${code}`);
            // Optionally handle server exit logic here
        });
    });
}

// Log levels for better categorization
enum LogLevel {
    INFO = 'INFO',
    SUCCESS = 'SUCCESS',
    WARNING = 'WARNING',
    ERROR = 'ERROR',
    DEBUG = 'DEBUG',
    WEBSOCKET = 'WEBSOCKET'
}

// Utility function to log messages to the output channel with better formatting
function logToOutput(message: string) {
    outputChannel.appendLine(message);
}

// Utility function to format log messages with better visual separation
function formatLogMessage(tag: string, message: string, level: LogLevel = LogLevel.INFO): string {
    const now = new Date();
    const hours = now.getHours().toString();
    const minutes = now.getMinutes().toString();
    const seconds = now.getSeconds().toString();
    const timestamp = `${hours.length === 1 ? '0' + hours : hours}:${minutes.length === 1 ? '0' + minutes : minutes}:${seconds.length === 1 ? '0' + seconds : seconds}`;
    
    // Create visual indicators based on log level
    let indicator: string;
    let prefix: string;
    
    switch (level) {
        case LogLevel.ERROR:
            indicator = '❌';
            prefix = '🚨 ERROR';
            break;
        case LogLevel.WARNING:
            indicator = '⚠️';
            prefix = '⚠️ WARNING';
            break;
        case LogLevel.SUCCESS:
            indicator = '✅';
            prefix = '✅ SUCCESS';
            break;
        case LogLevel.DEBUG:
            indicator = '🔍';
            prefix = '🔍 DEBUG';
            break;
        case LogLevel.WEBSOCKET:
            indicator = '🌐';
            prefix = '🌐 WEBSOCKET';
            break;
        case LogLevel.INFO:
        default:
            indicator = 'ℹ️';
            prefix = 'ℹ️ INFO';
            break;
    }
    
    return `${timestamp} ${prefix} [${tag}]: ${message}`;
}

// Function to clear output and add a fresh start header
function clearOutputAndStart(title: string) {
    outputChannel.clear();
}

export function deactivate() {
    if (ws) {
        ws.close();
    }
}
