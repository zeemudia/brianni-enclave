/**
 * vsock-to-TCP bridge for outbound HTTPS traffic from within Nitro Enclaves.
 *
 * Architecture:
 *   fetch('https://api.anthropic.com/...')
 *     → dns.lookup('api.anthropic.com') → 127.0.0.1   (DNS override)
 *     → TCP connect to 127.0.0.1:443                   (SNI bridge listens here)
 *     → parse TLS ClientHello → SNI='api.anthropic.com' (bridge extracts SNI)
 *     → vsock connect CID=3 port=8444                   (bridge routes by SNI)
 *     → parent vsock-proxy → api.anthropic.com:443      (provider)
 *
 * Design: a single TCP server on 127.0.0.1:443 peeks at the incoming TLS
 * ClientHello, extracts the SNI hostname, and routes to the correct vsock
 * port. 127.0.0.1 is always available on the loopback from the very first
 * millisecond of kernel boot — unlike 127.0.0.2/3/4 aliases which race
 * against Nitro's loopback initialization in production (non-debug) mode.
 *
 * The dns.lookup override is still needed:
 *   - It redirects provider hostnames → 127.0.0.1 so fetch connects here
 *   - TLS SNI is set by the Node.js TLS stack to the ORIGINAL hostname
 *   - The bridge reads the SNI from the raw ClientHello bytes and routes
 *
 * TLS terminates inside the enclave. The bridge forwards raw bytes through
 * vsock unchanged. The parent vsock-proxy forwards to the real provider.
 * The parent never sees plaintext.
 *
 * Parent host setup:
 *   vsock-proxy 8443 api.openai.com 443
 *   vsock-proxy 8444 api.anthropic.com 443
 *   vsock-proxy 8445 generativelanguage.googleapis.com 443
 */
import { createServer, type Socket, type Server } from 'node:net';
import { existsSync, appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

// Test-only export type — lets unit tests inject a fake vsock module.
export type VsockModuleForTest = { connect: (port: number, cid: number) => Socket };

// createRequire gives us mutable module objects so installDnsOverride() can
// swap dns.lookup at runtime. dns.lookup is called per-request (not cached),
// so patching it works correctly even after other modules have loaded.
const nodeRequire = createRequire(import.meta.url);

const VSOCK_CID_PARENT = 3;
const BRIDGE_LISTEN_HOST = '127.0.0.1';
const BRIDGE_LISTEN_PORT = 443;
const isNitroEnclave = existsSync('/dev/nsm');
console.log(`[enclave] vsock-proxy-bridge module evaluated. /dev/nsm exists: ${existsSync('/dev/nsm')}, isNitroEnclave: ${isNitroEnclave}`);

interface BridgeConfig {
  /** vsock port on the parent where vsock-proxy listens */
  vsockPort: number;
  /** Provider hostname — key for dns.lookup redirect and SNI routing */
  targetHost: string;
  /** Label for logging */
  label: string;
}

const DEFAULT_BRIDGES: BridgeConfig[] = [
  { vsockPort: 8443, targetHost: 'api.openai.com', label: 'OpenAI' },
  { vsockPort: 8444, targetHost: 'api.anthropic.com', label: 'Anthropic' },
  { vsockPort: 8445, targetHost: 'generativelanguage.googleapis.com', label: 'Google' },
];

// Map: provider hostname → vsock port (populated at startup)
const hostToVsockPort = new Map<string, number>();

/**
 * Start the SNI-routing bridge and install the dns.lookup override.
 * Returns a cleanup function.
 */
export async function startOutboundBridges(): Promise<() => void> {
  console.log(`[enclave] startOutboundBridges() called. isNitroEnclave=${isNitroEnclave}`);
  if (!isNitroEnclave) {
    console.log('[enclave] Not inside Nitro Enclave. Exiting startOutboundBridges early.');
    return () => {};
  }

  // Load vsock-native once — shared by the SNI bridge and the tls.connect patch.
  type VsockModuleType = { connect: (port: number, cid: number) => Socket };
  let vsockModule: VsockModuleType | null = null;
  try {
    const imported = (await import('@calypso/vsock-native')) as unknown as VsockModuleType | { default: VsockModuleType };
    vsockModule = 'default' in imported ? imported.default : imported;
    console.log('[enclave] vsock-native loaded successfully');
  } catch (err) {
    console.error('[enclave] Failed to load vsock-native:', err);
  }

  // Attempt to bring up the loopback interface for the SNI bridge (defense-in-depth).
  // The ip command may not be present in the slim image — this is non-fatal because
  // the primary provider redirect path is the tls.connect direct-vsock patch below.
  try {
    execSync('ip link set lo up');
    try { execSync('ip addr add 127.0.0.1/8 dev lo'); } catch { /* already assigned */ }
    console.log('[enclave] Loopback interface configured');
  } catch {
    console.warn('[enclave] Could not configure loopback via ip (non-fatal: tls.connect patch provides primary redirect)');
  }

  const bridges = parseBridgeConfig();
  console.log(`[enclave] Parsed ${bridges.length} bridges:`, JSON.stringify(bridges));
  for (const b of bridges) {
    hostToVsockPort.set(b.targetHost, b.vsockPort);
    console.log(`[enclave] Mapping host: ${b.targetHost} -> vsock port: ${b.vsockPort}`);
  }

  let server: Server;
  try {
    console.log('[enclave] Starting SNI bridge server...');
    server = await startSniBridge(bridges, vsockModule);
    console.log('[enclave] SNI bridge server started successfully.');
  } catch (err) {
    console.error('[enclave] SNI bridge server startup failed:', err);
    throw err;
  }

  // Write /etc/hosts entries (defense-in-depth for resolvers that read them).
  writeHostsEntries(bridges);

  // Primary provider redirect: patch tls.connect to create a direct AF_VSOCK
  // connection to the parent's vsock-proxy for each provider hostname. This
  // intercepts ALL code paths (Undici connector factory, internal/dns/utils,
  // any SDK that calls tls.connect) BEFORE any DNS lookup or TCP connect syscall,
  // and bypasses loopback routing entirely.
  installTlsConnectPatch(bridges, vsockModule);

  console.log('[enclave] Installing DNS overrides (defense-in-depth)...');
  installDnsOverride();
  console.log('[enclave] DNS overrides installed.');

  console.log(`[enclave] SNI bridge started on ${BRIDGE_LISTEN_HOST}:${BRIDGE_LISTEN_PORT} (${bridges.length} providers)`);

  return () => {
    console.log('[enclave] Cleaning up outbound bridges...');
    server.close();
  };
}

/** @deprecated returns 443 for any known provider hostname — SNI bridge listens on that port. */
export function getBridgePort(hostname: string): number | null {
  return hostToVsockPort.has(hostname) ? BRIDGE_LISTEN_PORT : null;
}

/** @deprecated use hostToVsockPort.get(). */
export function getLoopbackIp(_hostname: string): string | null {
  return null;
}

export function isInsideNitro(): boolean {
  return isNitroEnclave;
}

export interface BridgeConnectOptions {
  host?: string;
  hostname?: string;
  servername?: string;
  port?: number | string;
}

/** @deprecated No-op. Port rewriting replaced by SNI routing. */
export function rewriteBridgeConnectOptions<T extends BridgeConnectOptions>(
  _bridgePorts: ReadonlyMap<string, number>,
  options: T,
): T {
  return options;
}

type BridgeLookupResponse =
  | { all: false; address: string; family: 4 }
  | { all: true; addresses: Array<{ address: string; family: 4 }> };

function lookupWantsAll(options: unknown): boolean {
  return (
    typeof options === 'object' &&
    options !== null &&
    (options as { all?: unknown }).all === true
  );
}

/**
 * Format the dns.lookup callback payload for the caller's requested shape.
 * Undici/Node may call dns.lookup(host, { all: true }, cb); in that form the
 * callback must receive an array of address records, not (address, family).
 */
export function bridgeLookupResponseForOptions(options: unknown): BridgeLookupResponse {
  if (lookupWantsAll(options)) {
    return {
      all: true,
      addresses: [{ address: BRIDGE_LISTEN_HOST, family: 4 }],
    };
  }
  return { all: false, address: BRIDGE_LISTEN_HOST, family: 4 };
}

// ---------------------------------------------------------------------------
// /etc/hosts writer — OS-level redirect, intercepts all DNS resolution paths
// ---------------------------------------------------------------------------

function writeHostsEntries(bridges: BridgeConfig[], hostsPath = '/etc/hosts'): void {
  console.log(`[enclave] writeHostsEntries(): writing ${bridges.length} entries to ${hostsPath}`);
  const entries = bridges.map((b) => `127.0.0.1 ${b.targetHost}`).join('\n');
  const block = `\n# calypso provider bridge — redirected to local SNI bridge on 127.0.0.1:443\n${entries}\n`;
  appendFileSync(hostsPath, block);
  console.log(`[enclave] writeHostsEntries(): done. Entries written:\n${entries}`);
}

/** Test seam — allows tests to supply a temp hosts path instead of /etc/hosts. */
export function _writeHostsEntriesForTests(
  bridges: BridgeConfig[],
  hostsPath: string,
): void {
  writeHostsEntries(bridges, hostsPath);
}

// ---------------------------------------------------------------------------
// tls.connect patch — redirect outbound TLS to known provider hostnames
// through the local SNI bridge BEFORE any DNS lookup or TCP connect syscall.
// This is the primary intercept for Node.js 22 + Undici, which resolves DNS
// through require('internal/dns/utils') — a module separate from the
// require('node:dns') object that installDnsOverride() patches.
// ---------------------------------------------------------------------------

type TlsConnectOptions = {
  host?: string;
  hostname?: string;
  servername?: string;
  port?: number | string;
  socket?: Socket;
  [key: string]: unknown;
};

type VsockModuleRef = { connect: (port: number, cid: number) => Socket } | null;

function installTlsConnectPatch(bridges: BridgeConfig[], vsockModule: VsockModuleRef): void {
  if (!vsockModule) {
    console.warn('[enclave] installTlsConnectPatch(): vsock-native not available — skipping tls.connect patch');
    return;
  }

  // Build a direct hostname → vsock port map for O(1) lookup per connection.
  const hostToPort = new Map(bridges.map((b) => [b.targetHost, b.vsockPort]));
  const labelMap = new Map(bridges.map((b) => [b.targetHost, b.label]));
  console.log(`[enclave] installTlsConnectPatch(): patching tls.connect for: ${[...hostToPort.keys()].join(', ')}`);

  const tls = nodeRequire('node:tls') as {
    connect: (...args: unknown[]) => unknown;
  };
  const originalConnect = tls.connect;
  const vsock = vsockModule;

  tls.connect = function tlsConnectDirect(...args: unknown[]): unknown {
    // Normalise both tls.connect call signatures to an options object.
    let options: TlsConnectOptions;
    let isOptionsFirst = false;

    if (args.length > 0 && typeof args[0] === 'object' && args[0] !== null) {
      isOptionsFirst = true;
      options = args[0] as TlsConnectOptions;
    } else {
      options = (typeof args[2] === 'object' && args[2] !== null ? args[2] : {}) as TlsConnectOptions;
    }

    // If a pre-connected socket is already supplied, don't intercept — this
    // path is used by the SNI bridge itself when it pipes through vsock.
    if (options.socket) {
      return (originalConnect as (...a: unknown[]) => unknown).apply(tls, args);
    }

    const targetHost = (options.servername ?? options.hostname ?? options.host ?? '') as string;
    const vsockPort = hostToPort.get(targetHost);

    console.log(`[enclave] tls.connect intercepted: host="${targetHost}" vsockPort=${vsockPort ?? 'none'}`);

    if (!vsockPort) {
      return (originalConnect as (...a: unknown[]) => unknown).apply(tls, args);
    }

    // Direct vsock connection to the parent's vsock-proxy for this provider.
    // Bypasses loopback routing entirely — no 127.0.0.1 involved.
    const label = labelMap.get(targetHost) ?? targetHost;
    let vsockSocket: Socket;
    try {
      console.log(`[enclave] tls.connect → vsock.connect(${vsockPort}, CID=${VSOCK_CID_PARENT}) for ${label}`);
      vsockSocket = vsock.connect(vsockPort, VSOCK_CID_PARENT);
      console.log(`[enclave] vsock.connect returned (${label})`);
    } catch (err) {
      console.error(`[enclave] vsock.connect failed for ${label}:`, (err as Error).message);
      // Fall through to the original tls.connect (will fail in Nitro, but surfaces
      // the right error rather than a cryptic ENETUNREACH).
      return (originalConnect as (...a: unknown[]) => unknown).apply(tls, args);
    }

    // Hand the vsock socket to tls.connect as a pre-connected socket.
    // The TLS stack will perform the handshake over it and the SNI servername
    // is passed through so the remote provider sees the correct hostname.
    const redirected: TlsConnectOptions = {
      ...options,
      socket: vsockSocket,
      servername: targetHost,
      // Remove host/port/hostname — they trigger a new TCP connect when present
      // alongside `socket`, which we don't want.
      host: undefined,
      port: undefined,
      hostname: undefined,
    };

    console.log(`[enclave] tls.connect with vsock socket for "${targetHost}" via parent CID ${VSOCK_CID_PARENT} port ${vsockPort}`);

    const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : undefined;
    if (isOptionsFirst) {
      const newArgs = callback ? [redirected, callback] : [redirected];
      return (originalConnect as (...a: unknown[]) => unknown).apply(tls, newArgs);
    }
    const newArgs = callback ? [redirected, callback] : [redirected];
    return (originalConnect as (...a: unknown[]) => unknown).apply(tls, newArgs);
  };

  console.log('[enclave] installTlsConnectPatch(): tls.connect patched (direct vsock mode).');
}

// ---------------------------------------------------------------------------
// DNS override — redirect all provider hostnames to the bridge address
// (defense-in-depth alongside tls.connect patch and /etc/hosts above)
// ---------------------------------------------------------------------------

function installDnsOverride(): void {
  console.log(`[enclave] installDnsOverride() executing. isNitroEnclave=${isNitroEnclave}`);
  if (!isNitroEnclave) return;

  const dns = nodeRequire('node:dns') as { lookup: unknown };
  const originalLookup = dns.lookup as (
    hostname: string,
    options: unknown,
    callback: (...a: unknown[]) => void,
  ) => void;

  const knownHosts = new Set(hostToVsockPort.keys());
  console.log('[enclave] DNS override known hosts:', Array.from(knownHosts));

  dns.lookup = function (hostname: string, options: unknown, callback: (...a: unknown[]) => void) {
    if (typeof options === 'function') {
      callback = options as typeof callback;
      options = {};
    }

    console.log(`[enclave] dns.lookup intercept: hostname="${hostname}", options=${JSON.stringify(options)}`);

    if (knownHosts.has(hostname)) {
      const response = bridgeLookupResponseForOptions(options);
      console.log(`[enclave] dns.lookup REDIRECTING "${hostname}" to loopback: ${BRIDGE_LISTEN_HOST}, response=${JSON.stringify(response)}`);
      if (response.all) {
        callback(null, response.addresses);
      } else {
        callback(null, response.address, response.family);
      }
      return;
    }

    console.log(`[enclave] dns.lookup PASS-THROUGH "${hostname}" to original dns.lookup`);
    return originalLookup.call(dns, hostname, options, callback);
  };
}

// ---------------------------------------------------------------------------
// SNI bridge — single TCP listener on 127.0.0.1:443 with TLS ClientHello peek
// ---------------------------------------------------------------------------

/**
 * Returns a TCP connection handler that peeks at the TLS ClientHello, extracts
 * the SNI hostname, and proxies the connection over vsock.
 *
 * Exported for unit testing only — production code calls startSniBridge()
 * which closes over the real vsock module and the module-level hostToVsockPort
 * map.
 *
 * NOTE on VsockSocket lifecycle: vsock.connect() performs a synchronous native
 * AF_VSOCK syscall and wraps the resulting fd in a Duplex. The socket is
 * already connected when connect() returns — it never emits a 'connect' event.
 * Write and pipe immediately after vsock.connect() returns.
 */
export function _createConnectionHandlerForTests(
  vsockModule: VsockModuleForTest,
  routeMap: Map<string, number>,
): (clientSocket: Socket) => void {
  return (clientSocket: Socket) => {
    const chunks: Buffer[] = [];
    let bytesBuffered = 0;
    const MAX_BUFFER = 16_384; // 16 KB — more than enough for any ClientHello

    function onData(chunk: Buffer): void {
      chunks.push(chunk);
      bytesBuffered += chunk.length;

      const combined = Buffer.concat(chunks);
      const sni = extractSniFromClientHello(combined);

      if (sni === null) {
        // Need more data — but guard against pathologically large inputs
        if (bytesBuffered > MAX_BUFFER) {
          clientSocket.destroy(new Error('TLS ClientHello exceeds max buffer size'));
        }
        return;
      }

      // We have a definitive result — stop buffering
      clientSocket.removeListener('data', onData);

      if (sni === false) {
        clientSocket.destroy(new Error('Could not extract SNI from TLS ClientHello'));
        return;
      }

      const vsockPort = routeMap.get(sni);
      if (vsockPort == null) {
        clientSocket.destroy(new Error(`No vsock route for SNI: ${sni}`));
        return;
      }

      let vsockSocket: Socket;
      try {
        vsockSocket = vsockModule.connect(vsockPort, VSOCK_CID_PARENT);
      } catch (err) {
        clientSocket.destroy(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      // Register error/close handlers before write/pipe so any synchronous fd
      // error on the freshly-connected vsock socket is caught immediately.
      vsockSocket.on('error', () => {
        clientSocket.destroy();
      });
      clientSocket.on('error', () => {
        vsockSocket.destroy();
      });
      vsockSocket.on('close', () => {
        clientSocket.destroy();
      });
      clientSocket.on('close', () => {
        vsockSocket.destroy();
      });

      // VsockSocket is already connected — vsock.connect() uses a synchronous
      // native AF_VSOCK syscall and wraps the fd in a Duplex. No 'connect' event fires.
      vsockSocket.write(combined);
      clientSocket.pipe(vsockSocket);
      vsockSocket.pipe(clientSocket);
    }

    clientSocket.on('data', onData);
  };
}

async function startSniBridge(bridges: BridgeConfig[], vsockModule: VsockModuleRef): Promise<Server> {
  // Build label map for logging
  const portToLabel = new Map(bridges.map((b) => [b.vsockPort, b.label]));

  return new Promise<Server>((resolve, reject) => {
    const server = createServer((clientSocket: Socket) => {
      console.log(`[enclave] SNI bridge: accepted TCP connection from client`);
      if (!vsockModule) {
        console.error('[enclave] SNI bridge: vsock-native not available, destroying client socket');
        clientSocket.destroy(new Error('vsock-native not available'));
        return;
      }

      const vsock = vsockModule;
      const chunks: Buffer[] = [];
      let bytesBuffered = 0;
      const MAX_BUFFER = 16_384; // 16 KB — more than enough for any ClientHello

      function onData(chunk: Buffer): void {
        chunks.push(chunk);
        bytesBuffered += chunk.length;

        const combined = Buffer.concat(chunks);
        const sni = extractSniFromClientHello(combined);

        if (sni === null) {
          // Need more data — but guard against pathologically large inputs
          console.log(`[enclave] SNI bridge: incomplete TLS ClientHello. Buffered ${bytesBuffered} bytes. Waiting for more data...`);
          if (bytesBuffered > MAX_BUFFER) {
            console.error(`[enclave] SNI bridge: ClientHello exceeds max buffer size of ${MAX_BUFFER} bytes. Destroying client socket.`);
            clientSocket.destroy(new Error('TLS ClientHello exceeds max buffer size'));
          }
          return;
        }

        // We have a definitive result — stop buffering
        clientSocket.removeListener('data', onData);

        if (sni === false) {
          console.error('[enclave] SNI bridge: could not extract SNI from TLS ClientHello (or not a ClientHello/TLS handshake)');
          clientSocket.destroy(new Error('Could not extract SNI from TLS ClientHello'));
          return;
        }

        console.log(`[enclave] SNI bridge: successfully extracted SNI="${sni}"`);

        const vsockPort = hostToVsockPort.get(sni);
        if (vsockPort == null) {
          console.error(`[enclave] SNI bridge: no vsock route registered for SNI="${sni}". Destroying client socket.`);
          clientSocket.destroy(new Error(`No vsock route for SNI: ${sni}`));
          return;
        }

        const label = portToLabel.get(vsockPort) ?? String(vsockPort);
        console.log(`[enclave] SNI bridge: SNI="${sni}" matches vsock port ${vsockPort} (${label})`);
        
        let vsockSocket: Socket;
        try {
          console.log(`[enclave] SNI bridge: initiating vsock connect to parent CID ${VSOCK_CID_PARENT} on port ${vsockPort} (${label})`);
          vsockSocket = vsock.connect(vsockPort, VSOCK_CID_PARENT);
          console.log(`[enclave] SNI bridge: vsock.connect returned successfully (fd wrapped in Duplex) for ${label}`);
        } catch (err) {
          console.error(`[enclave] [${label}] vsock.connect synchronous error:`, err);
          clientSocket.destroy(err instanceof Error ? err : new Error(String(err)));
          return;
        }

        // Register error/close handlers before write/pipe so any synchronous fd
        // error on the freshly-connected vsock socket is caught immediately.
        vsockSocket.on('error', (err) => {
          console.error(`[enclave] [${label}] vsockSocket error:`, err.message);
          clientSocket.destroy();
        });
        clientSocket.on('error', (err) => {
          console.error(`[enclave] [${label}] clientSocket error:`, err.message);
          vsockSocket.destroy();
        });
        vsockSocket.on('close', () => {
          console.log(`[enclave] [${label}] vsockSocket closed`);
          clientSocket.destroy();
        });
        clientSocket.on('close', () => {
          console.log(`[enclave] [${label}] clientSocket closed`);
          vsockSocket.destroy();
        });

        // VsockSocket is already connected — vsock.connect() uses a synchronous
        // native AF_VSOCK syscall and wraps the fd in a Duplex. No 'connect' event fires.
        console.log(`[enclave] [${label}] writing peeked ClientHello (${combined.length} bytes) to vsock socket and piping traffic`);
        vsockSocket.write(combined);
        clientSocket.pipe(vsockSocket);
        vsockSocket.pipe(clientSocket);
      }

      clientSocket.on('data', onData);
    });

    server.on('error', (err) => {
      console.error('[enclave] SNI bridge server error:', err);
      reject(err);
    });
    server.listen(BRIDGE_LISTEN_PORT, BRIDGE_LISTEN_HOST, () => {
      console.log(
        `[enclave] SNI bridge: ${BRIDGE_LISTEN_HOST}:${BRIDGE_LISTEN_PORT} → vsock CID ${VSOCK_CID_PARENT} (routes by TLS SNI)`,
      );
      resolve(server);
    });
  });
}

/**
 * Extract the SNI hostname from a TLS ClientHello record.
 *
 * Returns:
 *   string   — the SNI hostname (route this to the matching vsock port)
 *   null     — incomplete data, caller should buffer more bytes and retry
 *   false    — parse error or no SNI extension present
 */
function extractSniFromClientHello(data: Buffer): string | null | false {
  // Minimum TLS record header is 5 bytes.
  if (data.length < 5) return null;

  // TLS record layer.
  const contentType = data[0];
  if (contentType !== 0x16) return false; // Not a Handshake record.

  const recordLength = data.readUInt16BE(3);
  if (data.length < 5 + recordLength) return null; // Incomplete record.

  // Handshake message begins at byte 5.
  let offset = 5;
  if (data.length <= offset) return false;

  const handshakeType = data[offset];
  if (handshakeType !== 0x01) return false; // Not ClientHello.

  // Skip: HandshakeType (1) + Length (3) + ClientVersion (2) + Random (32).
  offset += 1 + 3 + 2 + 32;

  if (offset >= data.length) return null;

  // Session ID.
  const sessionIdLen = data[offset++];
  offset += sessionIdLen;
  if (offset + 2 > data.length) return null;

  // Cipher suites.
  const cipherSuitesLen = data.readUInt16BE(offset);
  offset += 2 + cipherSuitesLen;
  if (offset + 1 > data.length) return null;

  // Compression methods.
  const compressionLen = data[offset++];
  offset += compressionLen;
  if (offset + 2 > data.length) return null;

  // Extensions.
  const extensionsLen = data.readUInt16BE(offset);
  offset += 2;

  const extensionsEnd = offset + extensionsLen;

  while (offset + 4 <= Math.min(extensionsEnd, data.length)) {
    const extType = data.readUInt16BE(offset);
    offset += 2;
    const extLen = data.readUInt16BE(offset);
    offset += 2;

    if (extType === 0x0000) {
      // SNI extension (RFC 6066 §3).
      if (offset + 2 > data.length) return null;
      // ServerNameList length (skip it — we just read the first entry).
      offset += 2;
      if (offset >= data.length) return null;
      const nameType = data[offset++];
      if (nameType !== 0x00) return false; // Only host_name (0x00) supported.
      if (offset + 2 > data.length) return null;
      const nameLen = data.readUInt16BE(offset);
      offset += 2;
      if (offset + nameLen > data.length) return null;
      return data.toString('utf8', offset, offset + nameLen);
    }

    offset += extLen;
  }

  // Extensions present but no SNI found — not a provider request.
  return false;
}

function parseBridgeConfig(): BridgeConfig[] {
  const envConfig = process.env.ENCLAVE_BRIDGES;
  if (!envConfig) return DEFAULT_BRIDGES;
  try {
    return JSON.parse(envConfig) as BridgeConfig[];
  } catch {
    console.warn('[enclave] Invalid ENCLAVE_BRIDGES env, using defaults');
    return DEFAULT_BRIDGES;
  }
}
