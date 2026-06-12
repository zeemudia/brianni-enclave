# brianni-enclave

The AWS Nitro Enclave source for [Brianni](https://brianni.ai), a privacy-preserving AI chat product. This standalone repo exists so anyone can rebuild the enclave, compute its PCR0 measurement, and verify that it matches what the production client apps pin and attest against before sending a single byte of encrypted data.

If a rebuild on the documented toolchain stops matching the pinned PCR0, treat it as a release-blocking discrepancy and report it via the security channels below.

> _A note on names._ Internal package names are `@calypso/*` (e.g. `@calypso/enclave`, `@calypso/nitro-verify`). _Calypso_ is the project's internal codename; _Brianni_ is the public product name. They refer to the same thing.

---

## Current pinned measurement

```
PCR0: f89a5d12c4761018c8dce806e3d9d959f40621fea988d93ed4dc83a1e626c56145e3acee0147472c76113e8f78215705
PCR1: 4b4d5b3661b3efc12920900c80e126e4ce783c522de6c02a2a5bf7af3a2b9327b86776f188e4be1c1c404a129dbda493
PCR2: 1f2ef78d797da587cb8a73335fc06506963192406fd1550048d36c3cf962b01872e2dc5aeffa391c853836e1cff995e6
```

- **Verified through the clean-host release path.** On 2026-06-12, this EIF was built from a clean git ref on a temporary Nitro builder, booted in Nitro release mode on a separate Nitro host, and verified through local vsock health plus public attestation health. Every entry is appended to [`VERIFICATIONS.md`](./VERIFICATIONS.md) — contribute your own rebuild there.
- **Vendor manifest SHA256:** `791623b5afd1eedcb5007ea06b537867d95f80e1c154766e2479cdb4090a21fb`. This is a pre-build checksum over every vendored dependency (apt `.deb`s, pip wheels, Yarn cache, node headers). If your `infra/docker/VENDOR-MANIFEST.sha256` matches this value before you build, you have the same dependency bytes we do.
- **Enforced simultaneously by clients, KMS, and this repo.** Divergence takes the product offline rather than silently downgrading: clients reject mismatched attestation, KMS rejects mismatched decrypts, and `enclave/measurement.json` carries the same PCR triple.

---

## Trust model

1. **The client device is the only trust boundary.** PII masking and authenticated encryption happen on-device before transmission.
2. **The application backend is a blind relay.** It handles account/session mechanics, but never sees plaintext message contents.
3. **The enclave is the auditable plaintext boundary.** It runs in AWS Nitro isolation. The source is this repository, the image measurement is PCR0, and KMS decryption is bound to that measurement.
4. **Rebuild verification requires no Brianni secrets.** Provider API keys, encrypted runtime blobs, and private signing keys are not build inputs.

The `packages/nitro-verify/` library documents the ECDSA-P384 + COSE_Sign1 + AWS-root-CA certificate-chain checks clients perform on every attestation document.

---

## Runtime secrets and rebuilds

Provider API keys are runtime secrets, not reproducible-build inputs.

- Rebuilding this repo and comparing PCR0 does **not** require OpenAI, Anthropic, Google, KMS, or Brianni-owned secrets.
- The production enclave receives provider keys only as KMS ciphertext. KMS is configured to decrypt only for an attested enclave whose PCR0 matches the published measurement.
- The KMS request uses Nitro `Recipient` attestation, so KMS returns plaintext re-encrypted to an ephemeral public key generated inside the enclave. The parent host does not receive provider-key plaintext.

The public proof this repo enables is narrower and stronger than "trust our deployment": rebuild the enclave, compute PCR0, verify the signed release tag, and compare that PCR0 to the value clients and KMS pin.

---

## What's in here

| Path                                         | Purpose                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `enclave/`                                   | Node.js enclave application. Entrypoint `src/index.ts`. Built into an EIF via `./enclave/build.sh`.                       |
| `packages/nitro-verify/`                     | Client-side attestation verifier. CBOR + COSE_Sign1 + AWS root cert chain + PCR0 match.                                   |
| `packages/vsock-native/`                     | AF_VSOCK native addon used by enclave/host tests and runtime code. Linux only.                                            |
| `packages/masking-core/`                     | Shared PII regex/tokeniser primitives. PII masking is on-device only; there is no Presidio service in the enclave.        |
| `packages/crypto-core/`                      | AES-256-GCM + HKDF + ECDH primitives.                                                                                     |
| `packages/chat-types/`                       | Type contracts exchanged with the enclave.                                                                                |
| `infra/docker/Dockerfile.enclave`            | Reproducible build recipe (base image digest-pinned).                                                                     |
| `infra/docker/vendor-deps.sh`                | Offline vendoring script — pins apt via snapshot.debian.org, pip versions, Yarn cache, and node headers.                  |
| `infra/docker/enclave-pip-requirements.txt`  | 15 `==`-pinned Python wheels for attestation and media/document tooling.                                                  |
| `infra/docker/VENDOR-MANIFEST.sha256`        | SHA-256 of every vendored file, sorted by path. The pre-build diff target for independent verifiers.                      |
| `infra/enclave-artefacts/`                   | Prebuilt `kmstool_enclave_cli` + `libnsm.so` + `SHA256SUMS`. See that directory's README for provenance.                  |
| `infra/host/*.py`                            | Minimal stdlib-only host helpers used by the enclave boot protocol. They contain no secrets.                              |
| `VERIFICATIONS.md`                           | Append-only log of independent rebuilds and the PCR sets they produced.                                                   |

What this repo deliberately does **not** contain: product application code, infrastructure secrets, provider API keys, private registry signing keys, or KMS-encrypted runtime blobs.

## Quick local checks

If you want to sanity-check the standalone repo before moving to Nitro hardware:

```bash
corepack enable
yarn install
yarn test
yarn type-check
```

These commands exercise the local TypeScript and unit-test surfaces. They do
not produce PCR0; that still requires a Nitro-capable EC2 host.

---

## Rebuilding and verifying the PCR0

**You need:** a Nitro-capable x86_64 EC2 instance with `nitro-cli`, Docker, Git, Node 24.11.0/Corepack, Python, and `jq`. The build won't work on a Mac because PCR0 is produced by `nitro-cli build-enclave`, which requires the Nitro host kernel.

```bash
# 1. Clone this repo onto a Nitro host.
git clone https://github.com/zeemudia/brianni-enclave.git
cd brianni-enclave
git checkout v1.0.0-pcr0-f89a5d12

# Verify the signed release tag. The expected Brianni release key fingerprint is:
# SHA256:vgDASzXg3D8A2xNUFxDkzbCX8ZbauHknSoSilN+AwIA
cat > /tmp/brianni-enclave.allowed_signers <<'EOF'
iosazee1@gmail.com,zee@zeemudia.com namespaces="git" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICLa1pk4xbbrWr2cX8t+D4d9OmJaRwVWxnv0vTrlhafG
EOF
git config --local gpg.format ssh
git config --local gpg.ssh.allowedSignersFile /tmp/brianni-enclave.allowed_signers
git verify-tag v1.0.0-pcr0-f89a5d12

# 2. One-time bootstrap on Amazon Linux 2023:
sudo dnf install -y docker aws-nitro-enclaves-cli \
                    aws-nitro-enclaves-cli-devel \
                    git make gcc-c++ python3-pip jq
sudo systemctl enable --now docker nitro-enclaves-allocator
sudo usermod -aG docker,ne ec2-user
# (log out + back in so docker group takes effect)

# Install node 24.11.0 and enable yarn 4:
NODE_VER=24.11.0
curl -fsSL "https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-linux-x64.tar.xz" \
  | sudo tar -xJ -C /usr/local --strip-components=1
sudo corepack enable
pip3 install --user --upgrade pip

# 3. Verify the prebuilt kmstool binaries against their SHA256SUMS.
cd infra/enclave-artefacts && sha256sum -c SHA256SUMS && cd ../..

# 4. Vendor all dependencies (needs network).
./infra/docker/vendor-deps.sh

# The vendor manifest SHA256 printed at the end MUST match the value in
# this README. If it doesn't, stop — some upstream drifted and the
# resulting build won't match the pinned PCR0.
sha256sum infra/docker/VENDOR-MANIFEST.sha256
# Expect: 791623b5afd1eedcb5007ea06b537867d95f80e1c154766e2479cdb4090a21fb

# 5. Build the EIF with --network=none (needs no network after step 4).
./enclave/build.sh --offline

# 6. Read the measurement.
cat enclave/measurement.json
```

Compare the `pcr0` / `pcr1` / `pcr2` fields against the values in this README. If they match, you have independently verified that the enclave running in production is exactly the code in this repository at this commit — and you should add a row to [`VERIFICATIONS.md`](./VERIFICATIONS.md).

If they don't match, file an issue with both measurements, the vendor manifest output, and your host details so the divergent file can be isolated publicly.

---

## Known limitations

These are documented, accepted states — not latent bugs:

1. **The `kmstool_enclave_cli` binary is committed, not built from source in this repo.** See `infra/enclave-artefacts/README.md` and `SHA256SUMS` for provenance and how to rebuild from [aws/aws-nitro-enclaves-sdk-c](https://github.com/aws/aws-nitro-enclaves-sdk-c). The committed binary is SHA-verified on every `./enclave/build.sh --offline` invocation.
2. **Runtime secrets are intentionally absent.** A verifier rebuilding the enclave does not need provider API keys, encrypted runtime blobs, or private signing keys. Those are only necessary to run a functioning production-integrated enclave, not to verify PCR0.

---

## Verifying the `kmstool_enclave_cli` provenance

The binary handles TLS, SigV4, and NSM-attestation framing for every KMS decrypt the enclave performs. Its integrity is load-bearing.

```bash
# In this repo:
cd infra/enclave-artefacts
sha256sum -c SHA256SUMS   # Must pass before trusting a rebuild.

# To rebuild from AWS source:
git clone https://github.com/aws/aws-nitro-enclaves-sdk-c
cd aws-nitro-enclaves-sdk-c/bin/kmstool-enclave-cli
./build.sh             # Docker build against public.ecr.aws/amazonlinux/amazonlinux:2
# Compare the resulting ./kmstool_enclave_cli and ./libnsm.so against
# the committed binaries. They will sha256-match modulo ELF timestamps
# until full reproducibility work lands upstream in the AWS SDK repo.
```

---

## Reporting a security issue

Please **do not** open a public GitHub issue for vulnerabilities. Two channels:

- Email [security@brianni.ai](mailto:security@brianni.ai) — preferred.
- Or: open a [private GitHub security advisory](https://github.com/zeemudia/brianni-enclave/security/advisories/new) on this repo.

A PGP key will be exchanged on request if follow-up warrants it. We'll acknowledge receipt within 72 hours and keep you posted on remediation.

---

## License

[Apache-2.0](./LICENSE). Patent grant included. You can read, rebuild, audit, fork, and use the code in your own systems. You cannot claim affiliation with Brianni or use its trademarks without permission.
