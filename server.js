const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

// Store connected clients with their information
const clients = new Map(); // clientId -> { ws, playerName, type }

// Set up WebSocket server
const wss = new WebSocket.Server({ port: 1306 }, () => {
    console.log('Server started on port 1306');
    process.stdout.write('Server started\n');  // Write the confirmation message to stdout
});

wss.on('error', (error) => {
    console.error('WebSocket server error:', error);
    if (error.code === 'EADDRINUSE') {
        console.log('Port 1306 is already in use. Please use a different port.');
        process.stdout.write('Port 1306 is already in use\n');  // Write error message to stdout
    }
});

// Function to send message to VS Code extension
function sendToExtension(message) {
    clients.forEach((client, clientId) => {
        if (client.type === 'extension' && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(message));
        }
    });
}

// Function to get client list for extension
function getClientList() {
    const gameClients = [];
    clients.forEach((client, clientId) => {
        if (client.type === 'game' && client.playerName) {
            gameClients.push({
                ClientId: clientId,
                PlayerName: client.playerName
            });
        }
    });
    return gameClients;
}

// Function to send client list to extension
function broadcastClientList() {
    sendToExtension({
        Type: 'client_list',
        Clients: getClientList()
    });
}

wss.on('connection', (ws) => {
    const clientId = uuidv4();
    console.log(`Client connected: ${clientId}`);
    
    // Initially set as unknown type
    clients.set(clientId, { ws, type: 'unknown', playerName: null });

    ws.on('message', (data) => {
        console.log(`Received message from ${clientId}:`, data.toString());
        
        try {
            const message = JSON.parse(data.toString());
            const client = clients.get(clientId);
            
            console.log(`Parsed message type: ${message.Type}`);

            // Handle different message types
            switch (message.Type) {
                case 'register_extension':
                    // VS Code extension registration
                    client.type = 'extension';
                    console.log('VS Code extension registered');
                    // Send current client list
                    broadcastClientList();
                    break;

                case 'register_game':
                    // Game client registration
                    client.type = 'game';
                    client.playerName = message.PlayerName;
                    console.log(`Game client registered: ${message.PlayerName}`);
                    
                    // Notify extension about new client
                    sendToExtension({
                        Type: 'client_connected',
                        ClientId: clientId,
                        PlayerName: message.PlayerName
                    });
                    break;

                case 'get_client_list':
                    // Extension requesting client list
                    if (client.type === 'extension') {
                        broadcastClientList();
                    }
                    break;

                case 'execute_script':
                    // Extension sending script to specific client
                    if (client.type === 'extension') {
                        const targetClient = clients.get(message.ClientId);
                        if (targetClient && targetClient.type === 'game' && targetClient.ws.readyState === WebSocket.OPEN) {
                            targetClient.ws.send(JSON.stringify({
                                Type: 'execute_script',
                                Script: message.Script
                            }));
                            console.log(`Script sent to ${targetClient.playerName}`);
                        } else {
                            // Send error back to extension
                            ws.send(JSON.stringify({
                                Type: 'error',
                                Tag: 'Execute',
                                Message: 'Target client not found or disconnected'
                            }));
                        }
                    }
                    break;

                default:
                    // Handle regular messages (for backward compatibility)
                    if (client.type === 'game') {
                        // Forward game messages to extension
                        sendToExtension({
                            Type: 'game_message',
                            Tag: message.Tag || 'Output',
                            Message: message.Message || data.toString(),
                            ClientId: clientId,
                            PlayerName: client.playerName
                        });
                    }
                    break;
            }
        } catch (error) {
            // Handle non-JSON messages (backward compatibility)
            const client = clients.get(clientId);
            if (client && client.type === 'game') {
                sendToExtension({
                    Type: 'game_message',
                    Tag: 'Output',
                    Message: data.toString(),
                    ClientId: clientId,
                    PlayerName: client.playerName || 'Unknown'
                });
            }
        }
    });

    ws.on('close', () => {
        const client = clients.get(clientId);
        console.log(`Client disconnected: ${clientId}`);
        
        if (client && client.type === 'game' && client.playerName) {
            // Notify extension about client disconnection
            sendToExtension({
                Type: 'client_disconnected',
                ClientId: clientId,
                PlayerName: client.playerName
            });
        }
        
        clients.delete(clientId);
    });

    ws.on('error', (error) => {
        console.error(`WebSocket error for client ${clientId}:`, error);
        clients.delete(clientId);
    });
});

console.log('WebSocket server running on ws://localhost:1306');
