#!/usr/bin/env node
// Zero-dependency static server for the Claude Code transcript viewer.
//
// Usage:
//   node server.js [--file <path-to.jsonl>] [--port <n>] [--open]
//   node server.js <path-to.jsonl>            (positional shorthand)
//
// If a JSONL file is supplied, the frontend auto-loads it from /api/transcript.
// Otherwise the user can drag-and-drop / pick a file in the browser.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

function parseArgs(argv) {
  const opts = {
    file: null,
    port: Number(process.env.PORT) || 5757,
    host: process.env.HOST || '127.0.0.1', // bind localhost by default; use --host 0.0.0.0 to expose
    open: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file' || a === '-f') opts.file = argv[++i];
    else if (a === '--port' || a === '-p') opts.port = Number(argv[++i]);
    else if (a === '--host' || a === '-H') opts.host = argv[++i];
    else if (a === '--open' || a === '-o') opts.open = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else if (!a.startsWith('-') && !opts.file) opts.file = a; // positional shorthand
  }
  if (opts.file) opts.file = path.resolve(opts.file);
  return opts;
}

function printHelp() {
  process.stdout.write(
    'Claude Code transcript viewer\n\n' +
    'Usage: node server.js [--file <path.jsonl>] [--port <n>] [--host <addr>]\n\n' +
    '  -f, --file <path>  JSONL transcript to load on startup\n' +
    '  -p, --port <n>     Port to listen on (default 5757)\n' +
    '  -H, --host <addr>  Address to bind (default 127.0.0.1; use 0.0.0.0 for all interfaces)\n' +
    '  -h, --help         Show this help\n'
  );
}

const opts = parseArgs(process.argv.slice(2));

if (opts.file && !fs.existsSync(opts.file)) {
  process.stderr.write(`error: file not found: ${opts.file}\n`);
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-cache', ...headers });
  res.end(body);
}

function serveStatic(req, res, urlPath) {
  // Map "/" -> index.html, prevent path traversal.
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath.replace(/^\/+/, ''));
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'Not Found');
    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, data, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // Metadata about the startup file (or null) so the UI knows whether to auto-load.
  if (url.pathname === '/api/info') {
    const info = opts.file
      ? { hasFile: true, name: path.basename(opts.file), path: opts.file, size: fs.statSync(opts.file).size }
      : { hasFile: false };
    return send(res, 200, JSON.stringify(info), { 'Content-Type': MIME['.json'] });
  }

  // Raw JSONL bytes of the startup file.
  if (url.pathname === '/api/transcript') {
    if (!opts.file) return send(res, 404, JSON.stringify({ error: 'no file supplied' }), { 'Content-Type': MIME['.json'] });
    const stream = fs.createReadStream(opts.file);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' });
    stream.on('error', () => send(res, 500, 'read error'));
    return stream.pipe(res);
  }

  return serveStatic(req, res, url.pathname);
});

server.listen(opts.port, opts.host, () => {
  process.stdout.write(`\n  Claude Code transcript viewer (bound ${opts.host}:${opts.port})\n`);
  process.stdout.write(`    Local:   http://localhost:${opts.port}\n`);
  // List reachable LAN addresses when bound to all interfaces.
  if (opts.host === '0.0.0.0' || opts.host === '::') {
    for (const ifaces of Object.values(os.networkInterfaces())) {
      for (const ni of ifaces || []) {
        if (ni.family === 'IPv4' && !ni.internal) {
          process.stdout.write(`    Network: http://${ni.address}:${opts.port}\n`);
        }
      }
    }
  }
  if (opts.file) process.stdout.write(`  Loaded: ${opts.file}\n`);
  else process.stdout.write(`  No --file given; open the page and drop a .jsonl in.\n`);
  process.stdout.write('\n');
});
