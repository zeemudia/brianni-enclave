# enclave/

The AWS Nitro Enclave that processes every user conversation. This source is
also mirrored into a standalone TEE-only repository so auditors can rebuild and
verify the pinned PCR0 without cloning private product code:

> **Canonical standalone repo:** https://github.com/zeemudia/brianni-enclave
>
> **Current pinned PCR0:**
> `f89a5d12c4761018c8dce806e3d9d959f40621fea988d93ed4dc83a1e626c56145e3acee0147472c76113e8f78215705`
>
> **Verified through the clean-host builder/appliance release path on 2026-06-12**
> The standalone repo's `VERIFICATIONS.md` carries the published release
> evidence for the current tag.

## Why a separate public repo

Three reasons:

1. **Auditability without leaking product internals.** The public
   repo carries only TEE-relevant code. Mobile/web/server trees,
   infrastructure secrets, and planning docs are not part of the public
   TEE release.
2. **Tagged to a verified PCR0.** Each public tag points at source
   that has been measured by real Nitro hardware and promoted only
   after the clean-host builder/appliance proof passes. External
   verifier rows are added to the standalone repo as they arrive.
3. **Reproducible extraction.** The maintainer extraction process filter-repos
   the TEE subset and runs a sensitive-file scan before writing the output
   directory. Keep-list includes
   `vendor-deps.sh`, `enclave-pip-requirements.txt`, `VENDOR-
   MANIFEST.sha256`, and `.dockerignore` so community verifiers can
   rerun `./enclave/build.sh --offline` and land on the same PCR0.

## Reproducible build (`--offline` mode)

The production build pipeline vendors every upstream dependency and
runs `docker build --network=none` so the resulting image only
depends on bytes that are pinned or committed. The current launch
path builds on a temporary Nitro builder and serves from a separate
Nitro appliance host.

```bash
# On a network-connected host, vendor all deps (apt via
# snapshot.debian.org, pip wheels via enclave-pip-requirements.txt,
# Yarn 4 cache, node headers). Emits VENDOR-MANIFEST.sha256.
./infra/docker/vendor-deps.sh

# On a Nitro-capable EC2 host: docker build --network=none, then
# nitro-cli build-enclave, then write measurement.json.
./enclave/build.sh --offline
```

On Linux/Nitro release hosts, `build.sh --offline` runs the embedded Docker
builder through a same-host disposable `dockerd` data-root by default. This
preserves the reproducible legacy `docker build` + `nitro-cli` path while
keeping all transient BuildKit overlay2 state out of the production Docker
graph. Set `CALYPSO_ENCLAVE_DOCKER_ISOLATION=host` only for emergency legacy
diagnosis.

The resulting `enclave/measurement.json` should contain the PCR0
above plus `vendorManifestSha256` matching the current committed
`infra/docker/VENDOR-MANIFEST.sha256`. Divergence from either is a
reproducibility regression — file an issue with both measurements
and your host details.

Runtime dependency changes inside `enclave/package.json` are enclave
image changes. For example, PDF text extraction uses the exact-pinned
`pdfjs-dist` package; upgrading or replacing it requires the same
offline EIF rebuild, `measurement.json` update, client pin injection,
and KMS PCR allowlist rotation as any other enclave code change.

## Current pinned PCR0

```
PCR0: f89a5d12c4761018c8dce806e3d9d959f40621fea988d93ed4dc83a1e626c56145e3acee0147472c76113e8f78215705
PCR1: 4b4d5b3661b3efc12920900c80e126e4ce783c522de6c02a2a5bf7af3a2b9327b86776f188e4be1c1c404a129dbda493
PCR2: 1f2ef78d797da587cb8a73335fc06506963192406fd1550048d36c3cf962b01872e2dc5aeffa391c853836e1cff995e6
```

Lives in `enclave/measurement.json` (source of truth in the build
pipeline), plus the mobile + web clients and the production AWS KMS
key policy. Any rebuild regenerates PCR0; all four must be rotated
together via `./scripts/inject-measurement.sh` + `aws kms put-key-
policy` or the enclave fails at boot.

## Maintainer entry points

- **Build an EIF, byte-reproducible (needs Nitro-capable EC2):**
  `./enclave/build.sh --offline`
- **Build an EIF, online / dev mode:** `./enclave/build.sh`
- **Rotate measurement across clients:** `./scripts/inject-measurement.sh`
- **Reproducibility evidence:** `VERIFICATIONS.md` in the standalone repo.
