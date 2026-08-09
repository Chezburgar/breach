// BREACH — server entry point.
//
// Serves the client and hosts the authoritative game sessions over WebSocket.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

import { Hub } from './hub.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

const app = express();
app.disable('x-powered-by');

const staticOpts = { etag: true, maxAge: '0', index: false };
app.use('/', express.static(path.join(ROOT, 'public'), staticOpts));
app.use('/shared', express.static(path.join(ROOT, 'shared'), staticOpts));

// three.js is served straight out of node_modules; the client's import map
// points `three` and `three/addons/` at these paths.
app.use('/vendor/three', express.static(path.join(ROOT, 'node_modules', 'three', 'build'), staticOpts));
app.use('/vendor/three/addons', express.static(path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm'), staticOpts));

app.get('/health', (_req, res) => res.json({ ok: true, ...hub.stats() }));

// Authoring aid: the map preview page posts a rendered frame here so shots can
// be inspected on disk. Off unless BREACH_DEV is set, and the filename is
// reduced to a bare slug written into tools/shots.
if (process.env.BREACH_DEV === '1') {
  app.post('/dev/shot', express.json({ limit: '24mb' }), async (req, res) => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const slug = String(req.body?.name || 'shot').replace(/[^a-z0-9_-]/gi, '').slice(0, 48) || 'shot';
    const data = String(req.body?.png || '').replace(/^data:image\/png;base64,/, '');
    if (!data) return res.status(400).json({ ok: false });
    const dir = path.join(ROOT, 'tools', 'shots');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${slug}.png`);
    await writeFile(file, Buffer.from(data, 'base64'));
    res.json({ ok: true, file });
  });
}

app.get('/', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));
app.get('*', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1 << 16 });
const hub = new Hub(wss);

server.listen(PORT, () => {
  console.log(`\n  BREACH server listening on http://localhost:${PORT}\n`);
});

const shutdown = () => {
  console.log('\n  shutting down…');
  hub.dispose();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
