#!/usr/bin/env node
// Throwaway HTTP echo server for the week-1 demo. clavenar-lite
// forwards allowed requests to whatever --upstream URL it's given;
// the demo points it here so an allowed tool_use yields a clean
// 200 rather than a 502 against a dead port.
//
// Listens on 127.0.0.1:${UPSTREAM_PORT:-9001} and responds 200
// with a one-line JSON ack to every POST.
import { createServer } from 'node:http';

const port = Number(process.env['UPSTREAM_PORT'] ?? 9001);

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, method: req.method, path: req.url }));
  });
}).listen(port, '127.0.0.1', () => {
  console.error(`[upstream-stub] listening on http://127.0.0.1:${port}`);
});
