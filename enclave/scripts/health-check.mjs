#!/usr/bin/env node
// enclave/scripts/health-check.mjs — One-shot vsock health probe.
//
// Used by enclave/scripts/deploy.sh to confirm a freshly-launched enclave
// is answering on vsock before declaring a swap successful. Mirrors the
// framing used by server/src/lib/tee-client.ts (5-byte header: 1-byte MSG
// type + 4-byte BE payload length) and issues MSG.HEALTH_PING (0x09).
//
// Transport selection:
//   - USE_VSOCK=true → AF_VSOCK via @calypso/vsock-native (Linux/Nitro only).
//   - otherwise       → TCP to 127.0.0.1:<ENCLAVE_PORT> (local dev).
//
// This script is intentionally standalone (no TS compile step, no server
// imports) so it can run directly from `node` on a bare EC2 host after a
// fresh checkout without building the full workspace.

import net from 'node:net';
import process from 'node:process';

const HEADER_SIZE = 5;
const MSG_HEALTH_PING = 0x09; // keep in sync with packages/chat-types/src/index.ts
const MSG_HEALTH_PONG = 0x0a; // keep in sync with packages/chat-types/src/index.ts

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(
    [
      'health-check.mjs — one-shot vsock/TCP health probe for the Calypso enclave.',
      '',
      'Usage:',
      '  node enclave/scripts/health-check.mjs',
      '',
      'Environment:',
      '  USE_VSOCK=true        Use AF_VSOCK (Nitro). Otherwise TCP to 127.0.0.1.',
      '  ENCLAVE_CID=16        Enclave CID when USE_VSOCK=true (default 16).',
      '  ENCLAVE_PORT=5000     vsock/TCP port (default 5000).',
      '  HEALTH_TIMEOUT_MS=5000',
      '',
      'Exit codes:',
      '  0 — enclave answered HEALTH_PING within the timeout.',
      '  1 — probe failed (timeout, refused, protocol error).',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

const CID = Number(process.env.ENCLAVE_CID ?? 16);
const PORT = Number(process.env.ENCLAVE_PORT ?? 5000);
const TIMEOUT_MS = Number(process.env.HEALTH_TIMEOUT_MS ?? 5000);
const USE_VSOCK = process.env.USE_VSOCK === 'true';

async function connect() {
  if (USE_VSOCK) {
    // vsock-native is an optional, Linux-only workspace dep. On macOS dev
    // machines it won't load — surface a clear error instead of a cryptic
    // MODULE_NOT_FOUND so operators know they must run this on Nitro EC2.
    let mod;
    try {
      mod = await import('@calypso/vsock-native');
    } catch (err) {
      throw new Error(
        `USE_VSOCK=true but @calypso/vsock-native failed to load: ${err?.message ?? err}. ` +
          'This probe must run on the Nitro EC2 host where the addon is built.',
      );
    }
    return mod.default?.connect?.(PORT, CID) ?? mod.connect(PORT, CID);
  }
  return await new Promise((resolve, reject) => {
    const s = net.createConnection({ host: '127.0.0.1', port: PORT });
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}

function encodePing() {
  const frame = Buffer.allocUnsafe(HEADER_SIZE);
  frame[0] = MSG_HEALTH_PING;
  frame.writeUInt32BE(0, 1); // zero-length payload
  return frame;
}

async function probe() {
  const socket = await connect();

  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks = [];

    const settle = (fn) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* already gone */ }
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(
      () => settle(() => reject(new Error(`health probe timed out after ${TIMEOUT_MS}ms`))),
      TIMEOUT_MS,
    );

    socket.on('data', (data) => {
      chunks.push(data);
      const combined = Buffer.concat(chunks);
      if (combined.length < HEADER_SIZE) return;
      const declared = combined.readUInt32BE(1);
      if (combined.length < HEADER_SIZE + declared) return;
      const type = combined[0];
      const payload = combined.subarray(HEADER_SIZE, HEADER_SIZE + declared);
      settle(() => {
        // 1. Frame type MUST be HEALTH_PONG — anything else is a protocol
        //    violation (stale buffer, wrong handler wired up, or an
        //    attacker echoing bytes). Don't silently accept.
        if (type !== MSG_HEALTH_PONG) {
          reject(
            new Error(
              `expected HEALTH_PONG frame (0x${MSG_HEALTH_PONG.toString(16)}) ` +
                `but received type=0x${type.toString(16)}`,
            ),
          );
          return;
        }
        let body;
        try {
          body = JSON.parse(payload.toString('utf8'));
        } catch (err) {
          reject(new Error(`malformed HEALTH_PONG response: ${err.message}`));
          return;
        }
        // 2. Payload contract — see enclave/src/index.ts HEALTH_PING handler:
        //    { status: 'ok', uptime: number }. The enclave no longer runs a
        //    Presidio masking sidecar (de-identification is on-device only),
        //    so the old `presidio_ready` readiness field was removed from
        //    HEALTH_PONG; requiring it here would fail every probe against a
        //    post-removal enclave and hang deploy.sh's wait into a rollback.
        //    `status: 'ok'` is now the whole readiness contract; deploy.sh's
        //    3-consecutive rule rides out brief startup flaps.
        if (body?.status !== 'ok') {
          reject(new Error(`unhealthy payload: ${JSON.stringify(body)}`));
          return;
        }
        resolve({ type, body });
      });
    });

    socket.on('error', (err) => settle(() => reject(err)));
    socket.on('end', () => settle(() => reject(new Error('peer closed before response'))));
    socket.on('close', () => settle(() => reject(new Error('connection closed before response'))));

    socket.write(encodePing());
  });
}

probe()
  .then((result) => {
    process.stdout.write(`health ok (type=0x${result.type.toString(16)} body=${JSON.stringify(result.body)})\n`);
    process.exit(0);
  })
  .catch((err) => {
    process.stderr.write(`health fail: ${err?.message ?? err}\n`);
    process.exit(1);
  });
