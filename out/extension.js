"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const net = __importStar(require("net"));
const process = __importStar(require("process"));
const ws_1 = __importDefault(require("ws"));
const child_process_1 = require("child_process");
const child_process_2 = require("child_process");
let ws;
let outputChannel;
function activate(context) {
    return __awaiter(this, void 0, void 0, function* () {
        console.log('Extension activated!');
        // Start the server and wait for WebSocket to be ready
        try {
            yield startServer();
            // Wait for a bit to ensure the WebSocket server is fully initialized
            yield new Promise(resolve => setTimeout(resolve, 1000)); // Adjust delay as needed
        }
        catch (err) {
            console.error('Error while starting the server:', err);
            vscode.window.showErrorMessage('Failed to start the WebSocket server.');
            return;
        }
        // Create an output channel
        outputChannel = vscode.window.createOutputChannel('VSExecutor');
        outputChannel.show(); // Show the output channel
        // Create a button in the status bar
        let executeButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
        executeButton.text = "$(rocket) Execute";
        executeButton.command = "extension.executeFile";
        executeButton.show();
        // WebSocket connection setup
        ws = new ws_1.default('ws://localhost:1306');
        ws.on('open', () => {
            logToOutput('WebSocket connection established');
        });
        ws.on('message', (data) => {
            let message;
            if (typeof data === 'string') {
                message = data;
            }
            else if (data instanceof Buffer || data instanceof ArrayBuffer) {
                message = Buffer.isBuffer(data) ? data.toString() : new TextDecoder().decode(data);
            }
            else {
                message = String(data);
            }
            let logtag;
            let logmessage;
            try {
                const parsedData = JSON.parse(message);
                logtag = parsedData.Tag || "Output";
                let templogmessage = JSON.stringify(parsedData.Message);
                if (templogmessage.startsWith('[') && templogmessage.endsWith(']')) {
                    templogmessage = templogmessage.slice(1, -1);
                    templogmessage = templogmessage.replace(/(?<!\\)"/g, '');
                    templogmessage = templogmessage.replace(/\\"/g, '"');
                }
                logmessage = templogmessage;
            }
            catch (err) {
                logtag = "WebSocket";
                logmessage = message;
            }
            const formattedMessage = formatLogMessage(logtag, logmessage);
            logToOutput(formattedMessage);
        });
        ws.on('error', (error) => {
            const formattedMessage = formatLogMessage('WebSocket error', `Error: ${error}`);
            logToOutput(formattedMessage);
        });
        ws.on('close', () => {
            const formattedMessage = formatLogMessage('WebSocket closed', 'Connection closed');
            logToOutput(formattedMessage);
        });
        let disposable = vscode.commands.registerCommand('extension.executeFile', () => {
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor && activeEditor.document.languageId !== 'Log') {
                const text = activeEditor.document.getText().trim(); // Trim whitespace from the text
                // Check if text has content
                if (text) {
                    // Check if WebSocket is open
                    if (ws.readyState === ws_1.default.OPEN) {
                        // Send the text to the WebSocket server
                        ws.send(text);
                        // Show success message
                        vscode.window.showInformationMessage('File sent successfully to the WebSocket server.');
                    }
                    else {
                        // Show error message if WebSocket is not open
                        vscode.window.showInformationMessage('WebSocket connection is not open. Please check the connection.');
                    }
                }
                else {
                    // Show error message if text is empty
                    vscode.window.showInformationMessage('The file is empty. Nothing to send.');
                }
            }
            else {
                // Show error message if there is no active editor
                vscode.window.showInformationMessage('No active editor found. Please open a file to execute.');
            }
        });
        context.subscriptions.push(disposable);
    });
}
exports.activate = activate;
// Function to check if port is in use
function isPortInUse(port) {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', (error) => {
            if (error.code === 'EADDRINUSE') {
                resolve(true); // Port is in use
            }
            else {
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
function killProcessUsingPort(port) {
    return new Promise((resolve, reject) => {
        if (process.platform === 'win32') {
            (0, child_process_1.exec)(`netstat -ano | findstr :${port}`, (err, stdout, stderr) => {
                if (err || stderr) {
                    if (err) {
                        console.log(`Error finding process using port ${port}: ${stderr || err.message}`);
                    }
                    resolve(); // Proceed if no process using port
                    return;
                }
                const lines = stdout.split('\n');
                const pidLine = lines.find(line => line.includes(`:${port}`));
                if (pidLine) {
                    const pid = pidLine.trim().split(/\s+/).pop(); // Extract PID from the line
                    if (pid) {
                        (0, child_process_1.exec)(`taskkill /PID ${pid} /F`, (killErr, killStdout, killStderr) => {
                            if (killErr) {
                                console.log(`Error killing process: ${killErr.message}`);
                            }
                            else {
                                console.log(`Killed process using port ${port}`);
                            }
                            resolve(); // Continue after killing the process
                        });
                    }
                    else {
                        resolve(); // No PID found, proceed
                    }
                }
                else {
                    resolve(); // No process found using the port, proceed
                }
            });
        }
        else {
            (0, child_process_1.exec)(`lsof -t -i:${port}`, (err, stdout, stderr) => {
                if (err || stderr) {
                    if (err) {
                        console.log(`Error finding process using port ${port}: ${stderr || err.message}`);
                    }
                    resolve(); // Proceed if no process using port
                    return;
                }
                const pid = stdout.trim();
                if (pid) {
                    (0, child_process_1.exec)(`kill -9 ${pid}`, (killErr, killStdout, killStderr) => {
                        if (killErr) {
                            console.log(`Error killing process: ${killErr.message}`);
                        }
                        else {
                            console.log(`Killed process using port ${port}`);
                        }
                        resolve(); // Continue after killing the process
                    });
                }
                else {
                    resolve(); // No process found, proceed
                }
            });
        }
    });
}
// Function to start the server
function startServer() {
    return __awaiter(this, void 0, void 0, function* () {
        const port = 1306;
        // Check if port is in use
        const inUse = yield isPortInUse(port);
        if (inUse) {
            console.log(`Port ${port} is in use. Attempting to kill the process using it...`);
            yield killProcessUsingPort(port);
        }
        // After killing the process (if needed), start the WebSocket server
        yield startWebSocketServer();
    });
}
// Function to actually start the WebSocket server
function startWebSocketServer() {
    return new Promise((resolve, reject) => {
        var _a;
        // Get the extension's root path dynamically from the `extensionContext`
        const extensionRootPath = (_a = vscode.extensions.getExtension('egodtheturtle.vsexecutor')) === null || _a === void 0 ? void 0 : _a.extensionPath;
        if (!extensionRootPath) {
            reject(new Error('Unable to find the extension root path.'));
            return;
        }
        // Resolve the path to the server.js file relative to the extension root directory
        const serverPath = path.join(extensionRootPath, 'server.js'); // Adjust this based on the actual location of server.js
        console.log('Starting server with path:', serverPath); // Debugging the path
        // Spawn the WebSocket server in the background
        const startServerCommand = (0, child_process_2.spawn)('node', [serverPath]);
        // Capture stdout and stderr to log them
        startServerCommand.stdout.on('data', (data) => {
            // console.log(data);
            // Check for specific logs indicating that the server has started
            if (data.toString().includes('Server started')) {
                console.log("Server started");
                resolve(); // Resolve when the server confirms it's started
            }
        });
        startServerCommand.stderr.on('data', (data) => {
            console.error(`stderr: ${data}`);
        });
        startServerCommand.on('error', (err) => {
            console.error(`Failed to start server: ${err.message}`);
            reject(err);
        });
        startServerCommand.on('close', (code) => {
            console.log(`Server process closed with code ${code}`);
            // Optionally handle server exit logic here
        });
    });
}
// Utility function to log messages to the output channel
function logToOutput(message) {
    outputChannel.appendLine(message);
}
// Utility function to format log messages
function formatLogMessage(tag, message) {
    const now = new Date();
    const timestamp = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
    return `${timestamp} [${tag}]: ${message}`;
}
function deactivate() {
    if (ws) {
        ws.close();
    }
}
exports.deactivate = deactivate;
