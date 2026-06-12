#!/usr/bin/env python3
"""
Host-side provider-key ciphertext broker for Nitro enclaves.

Listens on AF_VSOCK:8102. On each inbound connection, reads the
KMS-encrypted provider-key blob from a filesystem path (default
/etc/calypso/encrypted-keys.json) and writes its bytes to the socket,
then closes.

Why a broker instead of baking encrypted-keys.json into the EIF: the
enclave image measurement (PCR0) hashes the image bytes. If the blob
is in the image, every key rotation changes PCR0 and requires a KMS
policy rotation + mobile/web client release. Serving it over vsock
at boot keeps key-rotation changes out of the measurement.

Trust model: KMS policy binds decryption to the pinned PCR0, so a
host operator substituting a ciphertext of their choosing produces
plaintexts the attacker does not control (the provider rejects them).
No signature layer is needed at this boundary.

The broker is stdlib-only so it runs on any EC2 AMI with
/usr/bin/python3.
"""
from __future__ import annotations

import argparse
import os
import socket
import sys

DEFAULT_KEYS_PATH = "/etc/calypso/encrypted-keys.json"
DEFAULT_PORT = 8102


def serve(keys_path: str, port: int, use_inet: bool = False) -> None:
    if not os.path.isfile(keys_path):
        print(
            f"[keys-broker] fatal: {keys_path} not found. "
            "Stage the encrypted-keys.json at this path before launching the enclave "
            "(see infra/scripts/rotate-provider-keys.sh).",
            file=sys.stderr,
            flush=True,
        )
        sys.exit(2)

    # Fail-closed if we can't read the file. On Linux, open() will raise
    # PermissionError; catch it here rather than at first connect so the
    # broker doesn't look up and then immediately log errors.
    try:
        with open(keys_path, "rb") as f:
            f.read(1)
    except PermissionError as e:
        print(
            f"[keys-broker] fatal: cannot read {keys_path}: {e}",
            file=sys.stderr,
            flush=True,
        )
        sys.exit(2)

    family = socket.AF_INET if use_inet else socket.AF_VSOCK
    sock = socket.socket(family, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    if use_inet:
        sock.bind(("127.0.0.1", port))
    else:
        sock.bind((socket.VMADDR_CID_ANY, port))
    sock.listen(4)
    print(
        f"[keys-broker] listening on {'tcp' if use_inet else 'vsock'}:*:{port}, serving {keys_path}",
        flush=True,
    )

    while True:
        conn, addr = sock.accept()
        try:
            with open(keys_path, "rb") as f:
                payload = f.read()
            conn.sendall(payload)
            print(
                f"[keys-broker] served {len(payload)} bytes to {addr}",
                flush=True,
            )
        except FileNotFoundError:
            print(
                f"[keys-broker] error: {keys_path} disappeared between boot and request",
                file=sys.stderr,
                flush=True,
            )
        except BrokenPipeError:
            # Client disconnected mid-transfer. Broker stays up.
            print(
                f"[keys-broker] client disconnected before recv: {addr}",
                file=sys.stderr,
                flush=True,
            )
        except Exception as exc:  # noqa: BLE001 — broker must stay up
            print(
                f"[keys-broker] unexpected error: {exc}",
                file=sys.stderr,
                flush=True,
            )
        finally:
            conn.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--keys-path",
        default=DEFAULT_KEYS_PATH,
        help="Filesystem path to the encrypted-keys.json blob on the host",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
        help="vsock port to listen on (default: 8102)",
    )
    parser.add_argument(
        "--use-inet-for-tests",
        action="store_true",
        help="Bind AF_INET on 127.0.0.1 instead of AF_VSOCK. Tests only.",
    )
    args = parser.parse_args()
    try:
        serve(args.keys_path, args.port, use_inet=args.use_inet_for_tests)
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
