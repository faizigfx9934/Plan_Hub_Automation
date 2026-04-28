import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve the built React dashboard
const DIST_DIR = path.join(__dirname, '..', 'dashboard', 'dist');
const PORT = 9090;

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

    const filePath = path.join(DIST_DIR, urlPath);
    console.log(`[DASHBOARD] ${req.method} ${urlPath}`);

    fs.readFile(filePath, (err, content) => {
        if (err) {
            // For SPA: serve index.html for any missing route
            fs.readFile(path.join(DIST_DIR, 'index.html'), (err2, fallback) => {
                if (err2) {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end('Not Found');
                } else {
                    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
                    res.end(fallback);
                }
            });
        } else {
            const ext = path.extname(filePath).toLowerCase();
            res.writeHead(200, {
                'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
                'Cache-Control': ext === '.html' ? 'no-cache' : 'max-age=31536000',
            });
            res.end(content);
        }
    });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log('========================================');
    console.log('  PLANHUB PRO DASHBOARD IS LIVE');
    console.log(`  http://127.0.0.1:${PORT}`);
    console.log(`  Serving from: ${DIST_DIR}`);
    console.log('========================================');
});
