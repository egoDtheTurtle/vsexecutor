const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 1306;
const FILE_PATH = path.join(__dirname, 'received_script.lua');

const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/execute') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            // Only accept Lua files
            if (req.headers['content-type'] === 'text/plain') {
                fs.writeFileSync(FILE_PATH, body);
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('Script executed.');
            } else {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end('Only Lua files are accepted.');
            }
        });
    } else if (req.method === 'GET' && req.url === '/received_script.lua') {
        // Clear the content of the received_script.lua file
        const fileContent = fs.readFileSync(FILE_PATH, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(fileContent);
        fs.writeFileSync(FILE_PATH, '');
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
});
