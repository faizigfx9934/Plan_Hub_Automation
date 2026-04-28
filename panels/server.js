import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 8080;
const MIME_TYPES = {
    '.html': 'text/html',
    '.js':   'application/javascript',
    '.css':  'text/css',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
};

const server = http.createServer((req, res) => {
    let urlPath = req.url.split('?')[0];
    if (urlPath === '/') urlPath = '/index.html';

    const filePath = path.join(__dirname, urlPath);
    console.log(`[DASHBOARD] ${req.method} ${urlPath}`);

    fs.readFile(filePath, (err, content) => {
        if (err) {
            console.error(`[DASHBOARD] 404: ${filePath}`);
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
        } else {
            const ext = path.extname(filePath).toLowerCase();
            res.writeHead(200, {
                'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
                'Cache-Control': 'no-cache',
            });
            res.end(content);
        }
    });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log('========================================');
    console.log('  DASHBOARD SERVER IS LIVE');
    console.log(`  http://127.0.0.1:${PORT}`);
    console.log('========================================');
});
