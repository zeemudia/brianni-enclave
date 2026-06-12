import type { Socket, Server } from 'node:net';

/**
 * Connect to a vsock endpoint via AF_VSOCK.
 * Returns a standard net.Socket wrapping the vsock file descriptor.
 *
 * @param port - vsock port number
 * @param cid  - vsock CID (enclave's CID from nitro-cli describe-enclaves)
 */
export function connect(port: number, cid: number): Socket;

/**
 * Create an AF_VSOCK server.
 *
 * Returns a net.Server whose listen(port) method binds to AF_VSOCK
 * (VMADDR_CID_ANY:port) instead of TCP. Connection handling uses Node.js's
 * standard event loop — each accepted connection is a net.Socket.
 *
 * @param connectionHandler - Called for each incoming vsock connection
 */
export function createServer(connectionHandler: (socket: Socket) => void): Server;
