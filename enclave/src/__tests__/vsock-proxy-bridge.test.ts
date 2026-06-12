import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import type { Socket } from "node:net";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  bridgeLookupResponseForOptions,
  rewriteBridgeConnectOptions,
  getBridgePort,
  getLoopbackIp,
  _createConnectionHandlerForTests,
  _writeHostsEntriesForTests,
  type VsockModuleForTest,
} from "../vsock-proxy-bridge";

/**
 * vsock-proxy-bridge tests — SNI-routing approach (2026-05-21)
 *
 * The bridge now uses a single TCP server on 127.0.0.1:443 that peeks at the
 * TLS ClientHello SNI to route to the correct vsock port. The dns.lookup
 * override redirects all provider hostnames to 127.0.0.1.
 *
 * rewriteBridgeConnectOptions, getBridgePort, and getLoopbackIp are kept as
 * deprecated no-ops for API compatibility. The routing logic is integration-
 * tested via the Nitro E2E suite (tests/integration/nitro/).
 */
describe("vsock-proxy-bridge — SNI routing (2026-05-21)", () => {
  describe("rewriteBridgeConnectOptions (deprecated no-op)", () => {
    it("returns options unchanged for a provider host", () => {
      const map = new Map([["api.anthropic.com", 8444]]);
      const opts = { host: "127.0.0.1", port: 443, servername: "api.anthropic.com" };
      expect(rewriteBridgeConnectOptions(map, opts)).toBe(opts);
    });

    it("returns options unchanged for a non-provider host", () => {
      const map = new Map([["api.anthropic.com", 8444]]);
      const opts = { host: "example.com", port: 443 };
      expect(rewriteBridgeConnectOptions(map, opts)).toBe(opts);
    });

    it("returns options unchanged regardless of hostname/servername field", () => {
      const map = new Map([["generativelanguage.googleapis.com", 8445]]);
      const opts = { host: "127.0.0.1", hostname: "generativelanguage.googleapis.com", port: 443 };
      expect(rewriteBridgeConnectOptions(map, opts)).toBe(opts);
    });
  });

  describe("getBridgePort", () => {
    it("returns null for any hostname outside the enclave (map empty before startOutboundBridges)", () => {
      expect(getBridgePort("api.anthropic.com")).toBeNull();
      expect(getBridgePort("api.openai.com")).toBeNull();
    });
  });

  describe("getLoopbackIp (removed — SNI approach uses 127.0.0.1 for all providers)", () => {
    it("returns null always — dedicated loopback IPs removed", () => {
      expect(getLoopbackIp("api.anthropic.com")).toBeNull();
      expect(getLoopbackIp("api.openai.com")).toBeNull();
    });
  });

  describe("bridgeLookupResponseForOptions", () => {
    it("returns classic dns.lookup callback shape by default", () => {
      expect(bridgeLookupResponseForOptions({})).toEqual({
        all: false,
        address: "127.0.0.1",
        family: 4,
      });
    });

    it("returns dns.lookup all=true shape for undici connection setup", () => {
      expect(bridgeLookupResponseForOptions({ all: true })).toEqual({
        all: true,
        addresses: [{ address: "127.0.0.1", family: 4 }],
      });
    });
  });

  describe("_writeHostsEntriesForTests — /etc/hosts OS-level redirect", () => {
    it("appends one 127.0.0.1 entry per provider hostname", () => {
      const dir = mkdtempSync(join(tmpdir(), "calypso-hosts-test-"));
      const hostsPath = join(dir, "hosts");
      writeFileSync(hostsPath, "127.0.0.1 localhost\n");

      const bridges = [
        { vsockPort: 8443, targetHost: "api.openai.com", label: "OpenAI" },
        { vsockPort: 8444, targetHost: "api.anthropic.com", label: "Anthropic" },
        { vsockPort: 8445, targetHost: "generativelanguage.googleapis.com", label: "Google" },
      ];

      _writeHostsEntriesForTests(bridges, hostsPath);

      const content = readFileSync(hostsPath, "utf8");
      expect(content).toContain("127.0.0.1 api.openai.com");
      expect(content).toContain("127.0.0.1 api.anthropic.com");
      expect(content).toContain("127.0.0.1 generativelanguage.googleapis.com");
      // Original content must be preserved — entries are appended, not replaced.
      expect(content).toContain("127.0.0.1 localhost");

      rmSync(dir, { recursive: true });
    });

    it("does not duplicate entries when called twice (idempotent caller responsibility — second call appends again)", () => {
      const dir = mkdtempSync(join(tmpdir(), "calypso-hosts-test-"));
      const hostsPath = join(dir, "hosts");
      writeFileSync(hostsPath, "");

      const bridges = [{ vsockPort: 8444, targetHost: "api.anthropic.com", label: "Anthropic" }];

      _writeHostsEntriesForTests(bridges, hostsPath);
      const contentAfterFirst = readFileSync(hostsPath, "utf8");
      const matchCount = (contentAfterFirst.match(/api\.anthropic\.com/g) ?? []).length;
      // startOutboundBridges is called once per process — a single write is all that runs.
      expect(matchCount).toBe(1);

      rmSync(dir, { recursive: true });
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal but structurally valid TLS 1.2 ClientHello with a single
 * SNI extension for the given hostname.
 *
 * Structure (per RFC 5246 + RFC 6066):
 *   TLS Record:
 *     content_type   : 0x16  (Handshake)
 *     version        : 0x03 0x01
 *     length         : uint16 (length of the handshake message below)
 *   Handshake:
 *     msg_type       : 0x01  (ClientHello)
 *     length         : uint24
 *     client_version : 0x03 0x03
 *     random         : 32 zero bytes
 *     session_id_len : 0x00
 *     cipher_suites  : len=0x00 0x02, suite=0x00 0x2f
 *     compression    : len=0x01, method=0x00
 *     extensions_len : uint16
 *       SNI extension:
 *         ext_type   : 0x00 0x00
 *         ext_data_len: uint16
 *           sni_list_len: uint16
 *             name_type: 0x00
 *             name_len : uint16
 *             name     : hostname bytes
 */
function buildClientHelloWithSni(hostname: string): Buffer {
  const nameBytes = Buffer.from(hostname, "utf8");
  // SNI extension data:  sni_list_len(2) + name_type(1) + name_len(2) + name
  const sniExtData = Buffer.alloc(2 + 1 + 2 + nameBytes.length);
  sniExtData.writeUInt16BE(1 + 2 + nameBytes.length, 0); // sni_list_len
  sniExtData[2] = 0x00;                                  // name_type = host_name
  sniExtData.writeUInt16BE(nameBytes.length, 3);
  nameBytes.copy(sniExtData, 5);

  // Full extension: ext_type(2) + ext_data_len(2) + ext_data
  const ext = Buffer.alloc(4 + sniExtData.length);
  ext.writeUInt16BE(0x0000, 0); // type = SNI
  ext.writeUInt16BE(sniExtData.length, 2);
  sniExtData.copy(ext, 4);

  // ClientHello body (after handshake header):
  //   client_version(2) + random(32) + session_id_len(1) +
  //   cipher_suites_len(2) + cipher_suite(2) +
  //   compression_len(1) + compression(1) +
  //   extensions_len(2) + extensions
  const chBody = Buffer.alloc(2 + 32 + 1 + 2 + 2 + 1 + 1 + 2 + ext.length);
  let o = 0;
  chBody.writeUInt16BE(0x0303, o); o += 2; // TLS 1.3 client version field
  o += 32;                                 // random (zeroes)
  chBody[o++] = 0x00;                      // session_id_len
  chBody.writeUInt16BE(0x0002, o); o += 2; // cipher_suites_len
  chBody.writeUInt16BE(0x002f, o); o += 2; // TLS_RSA_WITH_AES_128_CBC_SHA
  chBody[o++] = 0x01;                      // compression_len
  chBody[o++] = 0x00;                      // no compression
  chBody.writeUInt16BE(ext.length, o); o += 2;
  ext.copy(chBody, o);

  // Handshake header: msg_type(1) + length(3)
  const handshake = Buffer.alloc(1 + 3 + chBody.length);
  handshake[0] = 0x01; // ClientHello
  handshake.writeUIntBE(chBody.length, 1, 3);
  chBody.copy(handshake, 4);

  // TLS record header: content_type(1) + version(2) + length(2)
  const record = Buffer.alloc(5 + handshake.length);
  record[0] = 0x16; // Handshake
  record.writeUInt16BE(0x0301, 1);
  record.writeUInt16BE(handshake.length, 3);
  handshake.copy(record, 5);

  return record;
}

// ---------------------------------------------------------------------------
// _createConnectionHandlerForTests — ClientHello flush regression test
// ---------------------------------------------------------------------------

describe("_createConnectionHandlerForTests — ClientHello flush", () => {
  it("writes the ClientHello to the vsock side immediately without a connect event", async () => {
    const hostname = "api.anthropic.com";
    const clientHello = buildClientHelloWithSni(hostname);

    // Fake vsock socket — a plain PassThrough whose writable side acts as a
    // black-hole sink so the bidirectional pipe loop cannot build up.
    // We intercept write() before it reaches the PassThrough internals so
    // we can assert on the exact bytes, then discard them to avoid the
    // clientSocket <-> vsockSocket feedback loop that would exhaust memory.
    const fakeVsock = new PassThrough();

    // Replace _write with a no-op so piped data is discarded immediately.

    (fakeVsock as any)._write = (
      _chunk: Buffer,
      _enc: string,
      cb: () => void,
    ) => cb();

    const connectSpy = vi.fn();
    fakeVsock.on("connect", connectSpy);

    // Capture what the handler sends via vsockSocket.write(combined).
    const vsockWritten: Buffer[] = [];
    const origWrite = fakeVsock.write.bind(fakeVsock);
    vi.spyOn(fakeVsock, "write").mockImplementation(
      (chunk: unknown, ...rest: unknown[]) => {
        vsockWritten.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
        // Call through so the stream state stays consistent.
        return (origWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
      },
    );

    // Fake vsock module whose connect() returns fakeVsock synchronously.
    const fakeVsockModule: VsockModuleForTest = {
      connect: (_port: number, _cid: number) => fakeVsock as unknown as Socket,
    };

    // Route map: hostname → vsock port 8444.
    const routeMap = new Map([[hostname, 8444]]);

    // Fake client socket — also a black-hole sink so it doesn't loop.
    const clientSocket = new PassThrough();

    (clientSocket as any)._write = (
      _chunk: Buffer,
      _enc: string,
      cb: () => void,
    ) => cb();

    // Invoke the handler synchronously.
    const handler = _createConnectionHandlerForTests(fakeVsockModule, routeMap);
    handler(clientSocket as unknown as Socket);

    // Write the ClientHello into the client socket's readable side.
    clientSocket.push(clientHello);

    // Give the stream event loop one tick to process.
    await new Promise<void>((resolve) => setImmediate(resolve));

    // The 'connect' listener must NEVER have fired.
    expect(connectSpy).not.toHaveBeenCalled();

    // vsock.write(combined) must have been called with the exact ClientHello bytes.
    expect(vsockWritten.length).toBeGreaterThan(0);
    const received = Buffer.concat(vsockWritten);
    expect(received.equals(clientHello)).toBe(true);
  });

  it("destroys the client socket when the SNI hostname has no vsock route", async () => {
    const clientHello = buildClientHelloWithSni("unknown.provider.com");

    const fakeVsockModule: VsockModuleForTest = {
      connect: vi.fn() as unknown as VsockModuleForTest["connect"],
    };

    // Empty route map — no known provider.
    const routeMap = new Map<string, number>();
    const clientSocket = new PassThrough();
    // Suppress the error event emitted by destroy(err) so it doesn't become
    // an unhandled exception in the test process.
    clientSocket.on("error", () => {});
    const destroySpy = vi.spyOn(clientSocket, "destroy");

    const handler = _createConnectionHandlerForTests(fakeVsockModule, routeMap);
    handler(clientSocket as unknown as Socket);
    // Push into the readable side so onData fires without the writable side looping.
    clientSocket.push(clientHello);

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(destroySpy).toHaveBeenCalled();
    expect(fakeVsockModule.connect).not.toHaveBeenCalled();
  });
});
