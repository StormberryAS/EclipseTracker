// tests/serve.py, the local stand-in for the live site: a client that hangs up mid-request
// (a connection reset) leaves no traceback on its error output (verifier item K-3, 2026-10-16),
// and the server still answers the next request.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';

const SERVE = fileURLToPath(new URL('./serve.py', import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('a connection reset by the client prints no traceback, and the server keeps serving', async () => {
  const server = spawn('python3', ['-I', SERVE, '--quiet'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  server.stderr.on('data', (d) => { stderr += d; });
  try {
    const base = await new Promise<URL>((res, rej) => {
      const t = setTimeout(() => rej(new Error('serve.py did not start')), 15000);
      server.stdout.on('data', (d) => {
        const m = /READY (\S+)/.exec(String(d));
        if (m && m[1]) { clearTimeout(t); res(new URL(m[1])); }
      });
    });
    for (let i = 0; i < 5; i++) {
      // Half a request line, then a reset (RST, not FIN): the server is reading when the peer goes.
      await new Promise<void>((res) => {
        const s = connect(Number(base.port), '127.0.0.1', () => {
          s.write('GET /index.html HT');
          setTimeout(() => { s.resetAndDestroy(); res(); }, 50);
        });
      });
    }
    // A request whose answer the client does not wait for.
    await new Promise<void>((res) => {
      const s = connect(Number(base.port), '127.0.0.1', () => {
        s.write('GET /data/eclipses.json HTTP/1.1\r\nHost: x\r\n\r\n');
        s.once('data', () => { s.resetAndDestroy(); res(); });
      });
    });
    await sleep(300);
    const r = await fetch(new URL('/index.html', base));
    assert.equal(r.status, 200);
    assert.doesNotMatch(stderr, /Traceback|ConnectionResetError|BrokenPipeError/);
  } finally {
    server.kill();
  }
});
