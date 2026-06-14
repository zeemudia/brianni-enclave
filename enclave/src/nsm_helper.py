#!/usr/bin/env python3
"""
NSM attestation helper — called by nsm.ts to generate attestation documents.

This uses the iovec-style ioctl interface exposed by the NSM device
(/dev/nsm), which is only available inside Nitro Enclaves.

Two invocation modes:

1. Daemon mode (production, called by NsmSidecar at enclave boot):
       python3 nsm_helper.py --daemon
   Reads line-framed JSON from stdin:
       {"nonce": "<base64>", "public_key": "<base64>"}
   Writes line-framed JSON to stdout:
       {"status": "ok", "attestation_doc": "<base64>", "pcrs": {...}}
       {"status": "error", "error": "<msg>"}
   Emits "NSM_READY\\n" on startup before entering the request loop.

2. One-shot mode (kept for backwards compat with scripts that exec the
   helper directly; no longer used by nsm.ts):
       python3 nsm_helper.py --nonce <base64> --public-key <base64>
"""

import argparse
import base64
import ctypes
import json
import os
import sys

NSM_RESPONSE_MAX_SIZE = 0x3000  # 12288 bytes
NSM_IOCTL = 0xC0200A00  # _IOWR(0x0A, 0, struct nsm_message) where sizeof=32


class NsmIovec(ctypes.Structure):
    _fields_ = [
        ("iov_base", ctypes.c_void_p),
        ("iov_len", ctypes.c_size_t),
    ]


class NsmMessage(ctypes.Structure):
    _fields_ = [
        ("request", NsmIovec),
        ("response", NsmIovec),
    ]


_libc = ctypes.CDLL(None, use_errno=True)
_libc.ioctl.restype = ctypes.c_int


def nsm_request(request_cbor: bytes) -> bytes:
    """Send a CBOR request to /dev/nsm via ioctl and return the response."""
    req_buf = ctypes.create_string_buffer(request_cbor)
    resp_buf = ctypes.create_string_buffer(NSM_RESPONSE_MAX_SIZE)

    msg = NsmMessage()
    msg.request.iov_base = ctypes.cast(req_buf, ctypes.c_void_p)
    msg.request.iov_len = len(request_cbor)
    msg.response.iov_base = ctypes.cast(resp_buf, ctypes.c_void_p)
    msg.response.iov_len = NSM_RESPONSE_MAX_SIZE

    fd = os.open("/dev/nsm", os.O_RDWR)
    try:
        ret = _libc.ioctl(
            ctypes.c_int(fd),
            ctypes.c_ulong(NSM_IOCTL),
            ctypes.pointer(msg),
        )
        errno = ctypes.get_errno()
        if ret < 0:
            raise OSError(errno, f"NSM ioctl failed: {os.strerror(errno)}")
    finally:
        os.close(fd)

    return resp_buf.raw[: msg.response.iov_len]


def get_attestation(nonce: bytes, public_key: bytes, user_data: bytes = b"") -> dict:
    """Request an attestation document from NSM with nonce, public key, and
    optional user_data (the media-provenance public key, bound into the
    attested document so a client can verify it against the pinned PCR0)."""
    import cbor2

    attestation = {
        "nonce": nonce,
        "public_key": public_key,
    }
    if user_data:
        attestation["user_data"] = user_data
    request = {"Attestation": attestation}
    request_bytes = cbor2.dumps(request)
    response_bytes = nsm_request(request_bytes)
    response = cbor2.loads(response_bytes)

    if "Attestation" in response:
        doc = response["Attestation"]
        if isinstance(doc, dict) and "document" in doc:
            doc_bytes = doc["document"]
        else:
            doc_bytes = doc
    elif "Error" in response:
        raise RuntimeError(f"NSM error: {response['Error']}")
    else:
        raise RuntimeError(f"Unexpected NSM response: {list(response.keys())}")

    # Parse the COSE_Sign1 attestation document to extract PCRs.
    # The attestation doc is an untagged COSE_Sign1 array (no CBOR tag 18).
    cose_array = cbor2.loads(doc_bytes)
    # COSE_Sign1 = [protected, unprotected, payload, signature]
    payload = cbor2.loads(cose_array[2])
    pcrs = payload.get("pcrs", {})

    return {
        "attestation_doc": base64.b64encode(doc_bytes).decode(),
        "pcrs": {
            f"PCR{i}": pcrs.get(i, b"").hex() for i in range(3)
        },
    }


def daemon_loop():
    """Long-running stdin/stdout JSON-line protocol. One attestation per line."""
    sys.stdout.write("NSM_READY\n")
    sys.stdout.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            nonce = base64.b64decode(req["nonce"])
            public_key = base64.b64decode(req["public_key"])
            user_data = base64.b64decode(req["user_data"]) if req.get("user_data") else b""
            result = get_attestation(nonce, public_key, user_data)
            sys.stdout.write(json.dumps({"status": "ok", **result}) + "\n")
        except Exception as e:
            sys.stdout.write(json.dumps({"status": "error", "error": str(e)}) + "\n")
        sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser(description="NSM attestation helper")
    parser.add_argument("--daemon", action="store_true",
                        help="Run as a stdin/stdout JSON-line daemon")
    parser.add_argument("--nonce", help="Base64-encoded nonce (one-shot mode)")
    parser.add_argument("--public-key", help="Base64-encoded ECDH public key (one-shot mode)")
    parser.add_argument("--user-data", help="Base64-encoded attested user_data (one-shot mode)")
    args = parser.parse_args()

    if args.daemon:
        daemon_loop()
        return

    if not args.nonce or not args.public_key:
        parser.error("--nonce and --public-key are required in one-shot mode")

    try:
        nonce = base64.b64decode(args.nonce)
        public_key = base64.b64decode(args.public_key)
        user_data = base64.b64decode(args.user_data) if args.user_data else b""
        result = get_attestation(nonce, public_key, user_data)
        print(json.dumps({"status": "ok", **result}))
    except Exception as e:
        print(json.dumps({"status": "error", "error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
