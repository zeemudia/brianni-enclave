#!/usr/bin/env python3
"""
Host-side IAM credential broker for Nitro enclaves.

Listens on AF_VSOCK:8100. On each inbound connection, fetches fresh IMDSv2
credentials for the instance's attached IAM role and writes them as one line
of JSON, then closes. The enclave uses these credentials to spawn
kmstool_enclave_cli, which then speaks TLS + SigV4 to KMS through
vsock-proxy on port 8000.

The enclave cannot reach 169.254.169.254 directly (it has no network), so
this tiny broker is the only trusted link that binds "IMDS creds for this
EC2 role" to "creds the enclave uses for KMS decrypt". KMS still enforces
the attestation-bound key policy, so a compromised broker cannot elevate
beyond what the role already permits.

Keep this script stdlib-only so it runs on any EC2 AMI with /usr/bin/python3.
"""
from __future__ import annotations

import argparse
import json
import socket
import sys
import urllib.error
import urllib.request

IMDS_TOKEN_URL = "http://169.254.169.254/latest/api/token"
IMDS_ROLE_ROOT = "http://169.254.169.254/latest/meta-data/iam/security-credentials/"


def fetch_imds_creds(role: str, timeout: float = 2.0) -> bytes:
    """Fetch the role's credentials via IMDSv2. Raises on failure."""
    token_req = urllib.request.Request(
        IMDS_TOKEN_URL,
        method="PUT",
        headers={"X-aws-ec2-metadata-token-ttl-seconds": "60"},
    )
    token = urllib.request.urlopen(token_req, timeout=timeout).read().decode()

    creds_req = urllib.request.Request(
        IMDS_ROLE_ROOT + role,
        headers={"X-aws-ec2-metadata-token": token},
    )
    return urllib.request.urlopen(creds_req, timeout=timeout).read()


def serve(role: str, port: int) -> None:
    # AF_VSOCK is stable in the Linux ABI; Python exposes it on recent kernels.
    sock = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    # VMADDR_CID_ANY is -1 cast to uint32; Python accepts -1 directly.
    sock.bind((socket.VMADDR_CID_ANY, port))
    sock.listen(4)
    print(f"[cred-broker] listening on vsock:*:{port}, role={role}", flush=True)

    while True:
        conn, addr = sock.accept()
        try:
            raw = fetch_imds_creds(role)
            conn.sendall(raw + b"\n")
            try:
                # Tell the enclave-side reader the payload is complete before
                # the descriptor is closed. Without this half-close, AF_VSOCK
                # can surface peer close as ENOTCONN instead of EOF.
                conn.shutdown(socket.SHUT_WR)
            except OSError:
                # Peer may have already closed/reset the connection; the
                # half-close is best-effort and a failure here is harmless.
                pass
            # Validate payload locally for logging hygiene — don't leak the body.
            parsed = json.loads(raw)
            expiry = parsed.get("Expiration", "?")
            print(
                f"[cred-broker] served creds to cid={addr[0]} (expires {expiry})",
                flush=True,
            )
        except urllib.error.URLError as exc:
            msg = f"IMDS unreachable: {exc}".encode()
            conn.sendall(b'{"error":' + json.dumps(msg.decode()).encode() + b"}\n")
            print(f"[cred-broker] IMDS error: {exc}", file=sys.stderr, flush=True)
        except Exception as exc:  # noqa: BLE001 — broker must stay up
            print(f"[cred-broker] unexpected error: {exc}", file=sys.stderr, flush=True)
        finally:
            conn.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--role", required=True, help="IAM role name attached to the EC2 instance")
    parser.add_argument("--port", type=int, default=8100, help="vsock port to listen on")
    args = parser.parse_args()
    try:
        serve(args.role, args.port)
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
