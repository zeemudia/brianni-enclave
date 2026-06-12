#!/usr/bin/env python3
"""
Host-side provider-registry broker for Nitro enclaves.

Listens on AF_VSOCK:8101. On each inbound connection, reads the signed
provider registry JSON from a filesystem path (default
/etc/calypso/providers.json) and writes its bytes to the socket, then closes.

Why a broker instead of baking providers.json into the EIF: the enclave
image measurement (PCR0) hashes the image bytes. If providers.json is in
the image, every registry change rotates PCR0 and requires a KMS policy
rotation + client re-release. Serving it over vsock at boot keeps config
changes out of the measurement; the enclave still verifies the Ed25519
signature against the baked public key (enclave/src/providers/registry-
verify-key.pem) before trusting the JSON, so a compromised host cannot
inject a malicious registry.

The broker is stdlib-only so it runs on any EC2 AMI with /usr/bin/python3.
"""
from __future__ import annotations

import argparse
import os
import socket
import sys

DEFAULT_REGISTRY_PATH = "/etc/calypso/providers.json"
DEFAULT_PORT = 8101


def serve(registry_path: str, port: int) -> None:
    if not os.path.isfile(registry_path):
        print(
            f"[registry-broker] fatal: {registry_path} not found. "
            "Stage the signed providers.json at this path before launching the enclave.",
            file=sys.stderr,
            flush=True,
        )
        sys.exit(2)

    # AF_VSOCK is stable in the Linux ABI; Python exposes it on recent kernels.
    sock = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((socket.VMADDR_CID_ANY, port))
    sock.listen(4)
    print(
        f"[registry-broker] listening on vsock:*:{port}, serving {registry_path}",
        flush=True,
    )

    while True:
        conn, addr = sock.accept()
        try:
            # Read fresh from disk so an operator editing the file between
            # enclave runs doesn't require restarting this broker.
            with open(registry_path, "rb") as f:
                payload = f.read()
            conn.sendall(payload)
            print(
                f"[registry-broker] served {len(payload)} bytes to cid={addr[0]}",
                flush=True,
            )
        except FileNotFoundError:
            print(
                f"[registry-broker] error: {registry_path} disappeared between boot and request",
                file=sys.stderr,
                flush=True,
            )
        except Exception as exc:  # noqa: BLE001 — broker must stay up
            print(
                f"[registry-broker] unexpected error: {exc}",
                file=sys.stderr,
                flush=True,
            )
        finally:
            conn.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--registry-path",
        default=DEFAULT_REGISTRY_PATH,
        help="Filesystem path to the signed providers.json on the host",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
        help="vsock port to listen on",
    )
    args = parser.parse_args()
    try:
        serve(args.registry_path, args.port)
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
