const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8080; // Standard safe port
const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
};

const server = http.createServer((req, res) => {
    let urlPath = req.url.split('?')[0];
    if (urlPath === '/') urlPath = '/index.html';
    
    // Force absolute path resolution
    const filePath = path.resolve(__dirname, urlPath.startsWith('/') ? urlPath.slice(1) : urlPath);
    
    console.log(`[DASHBOARD] Serving: ${filePath}`);

    fs.readFile(filePath, (error, content) => {
        if (error) {
            res.writeHead(404);
            res.end('Not Found');
        } else {
            const ext = path.extname(filePath).toLowerCase();
            res.writeHead(200, { 
                'Content-Type': MIME_TYPES[ext] || 'text/plain',
                'Cache-Control': 'no-cache'
            });
            res.end(content);
        }
    });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`SERVER READY AT http://127.0.0.1:${PORT}`);
});
