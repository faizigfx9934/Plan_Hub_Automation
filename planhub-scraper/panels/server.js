import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve the built React dashboard
const DIST_DIR = path.join(__dirname, '..', 'dashboard', 'dist');
const ROOT_DIR = path.join(__dirname, '..');
const PORT = 9090;

// Read LAPTOP_ID from .env file
function getLaptopId() {
    try {
        const envPath = path.join(ROOT_DIR, '.env');
        const envContent = fs.readFileSync(envPath, 'utf-8');
        const match = envContent.match(/LAPTOP_ID=(.+)/);
        return match ? match[1].trim() : 'Unknown';
    } catch {
        return 'Unknown';
    }
}

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

    // API endpoint: return this laptop's ID
    if (urlPath === '/api/local-id') {
        const laptopId = getLaptopId();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
        res.end(JSON.stringify({ laptop_id: laptopId }));
        return;
    }

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
            const isHtml = ext === '.html';
            res.writeHead(200, {
                'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
                'Cache-Control': isHtml ? 'no-store, no-cache, must-revalidate, proxy-revalidate' : 'max-age=31536000',
                'Pragma': isHtml ? 'no-cache' : '',
                'Expires': isHtml ? '0' : '',
            });
            res.end(content);
        }
    });
});

server.listen(PORT, '127.0.0.1', () => {
    const id = getLaptopId();
    console.log('========================================');
    console.log('  PLANHUB PRO DASHBOARD IS LIVE');
    console.log(`  Laptop: ${id}`);
    console.log(`  http://127.0.0.1:${PORT}`);
    console.log('========================================');
});
