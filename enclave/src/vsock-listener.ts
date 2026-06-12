/**
 * AF_VSOCK / TCP listener abstraction for the enclave.
 *
 * Inside a Nitro Enclave: listens on AF_VSOCK (the ONLY I/O channel).
 * Outside (local dev/test): listens on TCP for development convenience.
 *
 * Detection: if /dev/nsm exists, we're inside a Nitro Enclave.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { existsSync } from 'node:fs';

const isNitroEnclave = existsSync('/dev/nsm');

/**
 * L3 (error-handling audit): the startup promise's `reject` listener is
 * dead once listen succeeds, so post-startup listener errors were silently
 * swallowed. Replace it with a persistent logger. Redacted to the errno
 * code only — enclave stderr is host-visible.
 */
function swapToPersistentErrorLogger(
  server: Server,
  mode: string,
  reject: (err: Error) => void,
): void {
  server.removeListener('error', reject);
  server.on('error', (err) => {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
    console.error(
      `[enclave] ${mode} listener error after startup: code=${code}`,
    );
  });
}

/**
 * Create a server that listens on vsock (Nitro) or TCP (local dev).
 *
 * @param connectionHandler - Called for each new connection
 * @param port - vsock port (Nitro) or TCP port (local dev)
 * @returns The listening server
 */
export async function createEnclaveListener(
  connectionHandler: (socket: Socket) => void,
  port: number,
): Promise<Server> {
  if (isNitroEnclave) {
    return listenVsock(connectionHandler, port);
  }
  return listenTcp(connectionHandler, port);
}

// ---------------------------------------------------------------------------
// AF_VSOCK path (inside Nitro Enclave)
// ---------------------------------------------------------------------------

async function listenVsock(
  connectionHandler: (socket: Socket) => void,
  port: number,
): Promise<Server> {
  let vsockModule: any;
  try {
    vsockModule = await import('@calypso/vsock-native' as string);
  } catch {
    throw new Error(
      '/dev/nsm detected (Nitro Enclave) but @calypso/vsock-native is not installed. ' +
        'The enclave Docker image must include this N-API addon for AF_VSOCK.',
    );
  }

  return new Promise<Server>((resolve, reject) => {
    // AF_VSOCK server: listens on CID_ANY (0xFFFFFFFF) at the specified port.
    // The parent EC2 instance connects via the enclave's assigned CID.
    const server: Server = vsockModule.createServer(connectionHandler);
    server.on('error', reject);
    server.listen(port, () => {
      console.log(`[enclave] Listening on vsock port ${port} (Nitro Enclave mode)`);
      swapToPersistentErrorLogger(server, 'vsock', reject);
      resolve(server);
    });
  });
}

// ---------------------------------------------------------------------------
// TCP fallback (local development)
// ---------------------------------------------------------------------------

function listenTcp(
  connectionHandler: (socket: Socket) => void,
  port: number,
): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const host = process.env.ENCLAVE_HOST ?? '0.0.0.0';
    const server = createServer(connectionHandler);
    server.on('error', reject);
    server.listen(port, host, () => {
      console.log(`[enclave] Listening on TCP ${host}:${port} (development mode)`);
      swapToPersistentErrorLogger(server, 'tcp', reject);
      resolve(server);
    });
  });
}
