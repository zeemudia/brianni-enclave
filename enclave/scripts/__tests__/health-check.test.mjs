import { spawn } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const HEADER_SIZE = 5;
const MSG_HEALTH_PONG = 0x0a;

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(here, '../health-check.mjs');
const servers = new Set();

function encodePong(body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const frame = Buffer.allocUnsafe(HEADER_SIZE + payload.length);
  frame[0] = MSG_HEALTH_PONG;
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, HEADER_SIZE);
  return frame;
}

async function withFakeHealthServer(body, fn) {
  const server = net.createServer((socket) => {
    socket.once('data', () => {
      socket.end(encodePong(body));
    });
  });
  servers.add(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  try {
    return await fn(port);
  } finally {
    servers.delete(server);
    server.close();
    await once(server, 'close');
  }
}

function runHealthCheck(port, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        USE_VSOCK: 'false',
        ENCLAVE_PORT: String(port),
        HEALTH_TIMEOUT_MS: '1000',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  servers.clear();
});

describe('health-check.mjs connector registry readiness', () => {
  it('fails when connector registry readiness is required but the enclave reports it unloaded', async () => {
    await withFakeHealthServer(
      { status: 'ok', uptime: 1, connectorRegistryLoaded: false, connectorCatalogVersion: null },
      async (port) => {
        const result = await runHealthCheck(port, { REQUIRE_CONNECTOR_REGISTRY: 'true' });

        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/connector registry.*not loaded/i);
      },
    );
  });

  it('passes when connector registry readiness is required and the enclave reports it loaded', async () => {
    await withFakeHealthServer(
      { status: 'ok', uptime: 1, connectorRegistryLoaded: true, connectorCatalogVersion: 1 },
      async (port) => {
        const result = await runHealthCheck(port, { REQUIRE_CONNECTOR_REGISTRY: 'true' });

        expect(result.code).toBe(0);
        expect(result.stdout).toContain('"connectorRegistryLoaded":true');
      },
    );
  });
});
