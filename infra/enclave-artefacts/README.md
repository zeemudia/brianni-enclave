# Enclave artefacts

Prebuilt binaries baked into the enclave image by `infra/docker/Dockerfile.enclave`.

## Contents

| File | Purpose | Source |
|---|---|---|
| `kmstool_enclave_cli` | Nitro KMS client. Speaks TLS + SigV4 to KMS, attaches the NSM attestation document, so KMS can enforce the attestation-bound key policy. | [aws-nitro-enclaves-sdk-c](https://github.com/aws/aws-nitro-enclaves-sdk-c) — `bin/kmstool-enclave-cli/build.sh` (builds on amazonlinux:2) |
| `libnsm.so` | Rust-linked NSM userspace library (`/dev/nsm` ioctl wrapper) that kmstool dynamically links against. | Same repo, produced by the same build. |
| `SHA256SUMS` | Integrity manifest. `shasum -c SHA256SUMS` in this directory must pass on any host before trusting a rebuild of the EIF. |

## Reproducing

Check out the SDK pinned to the commit noted in `SHA256SUMS` (or HEAD if no pin) and run:

```bash
git clone https://github.com/aws/aws-nitro-enclaves-sdk-c
cd aws-nitro-enclaves-sdk-c/bin/kmstool-enclave-cli
./build.sh   # docker build against public.ecr.aws/amazonlinux/amazonlinux:2
# Produces ./kmstool_enclave_cli and ./libnsm.so
```

The binaries here must sha256-match what that script emits, modulo timestamps
baked into the ELF (builds are not yet byte-deterministic across hosts).

## Why we commit binaries

They are baked into the enclave EIF, whose PCR0 is the load-bearing measurement
for client attestation. Committing the exact bytes that produced the pinned
PCR0 means every rebuild on the same host reproduces that PCR0 without having
to re-run the ~10-minute AWS SDK C build.

Longer term: move the build into a multi-stage of `Dockerfile.enclave` with
a pinned SDK commit + `SOURCE_DATE_EPOCH=0`, so reproducibility becomes
transitive all the way to the AWS SDK source.
