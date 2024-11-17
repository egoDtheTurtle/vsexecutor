const WebSocket = require('ws');

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

// Function to send logs to all connected clients except the sender
function broadcastToOtherClients(sender, message) {
    wss.clients.forEach(client => {
        // Ensure the client is not the sender and is in the OPEN state
        if (client !== sender && client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

wss.on('connection', (ws) => {
    console.log('Client connected');
    broadcastToOtherClients(ws, 'Client connected');

    ws.on('message', (message) => {
        console.log('Received message:', message);
        broadcastToOtherClients(ws, message);
    });

    ws.on('close', () => {
        console.log('Client disconnected');
        broadcastToOtherClients(ws, 'Client disconnected');
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

console.log('WebSocket server running on ws://localhost:1306');
