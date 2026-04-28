const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 5678; // Changed port to avoid any conflicts
const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
    // Log incoming requests for debugging
    console.log(`[SERVER] Request: ${req.url}`);
    
    // Resolve file path
    let urlPath = req.url.split('?')[0];
    if (urlPath === '/') urlPath = '/index.html';
    
    const filePath = path.join(__dirname, urlPath);
    const extname = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[extname] || 'application/octet-stream';

    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code === 'ENOENT') {
                console.error(`[SERVER] 404 Not Found: ${filePath}`);
                res.writeHead(404);
                res.end(`File not found: ${urlPath}`);
            } else {
                console.error(`[SERVER] 500 Error: ${error.code}`);
                res.writeHead(500);
                res.end(`Internal Server Error: ${error.code}`);
            }
        } else {
            res.writeHead(200, { 
                'Content-Type': contentType,
                'Cache-Control': 'no-cache',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(content, 'utf-8');
        }
    });
});

server.on('error', (e) => {
    console.error(`[SERVER] Startup Error: ${e.message}`);
    process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('========================================');
    console.log(`  DASHBOARD SERVER IS ACTIVE`);
    console.log(`  URL: http://localhost:${PORT}`);
    console.log(`  Path: ${__dirname}`);
    console.log('========================================');
});
