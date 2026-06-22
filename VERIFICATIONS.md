# Enclave build verifications

This file records the build evidence for each enclave release. The blocking
pre-deploy gate is the clean-host release path: build the EIF on a temporary
Nitro builder from a clean git ref, verify the artifact measurement with
`nitro-cli describe-eif`, boot it in Nitro release mode on a separate Nitro
host, then verify local vsock health and public attestation health after
promotion. External independent rebuilds remain the stronger long-term audit
posture and should be added here as they arrive.

The verification protocol is:

```bash
git clone https://github.com/zeemudia/brianni-enclave
cd brianni-enclave
git checkout v1.0.0-pcr0-db6dcedf

# Verify the signed release tag before rebuilding.
cat > /tmp/brianni-enclave.allowed_signers <<'EOF'
zee@zeemudia.com namespaces="git" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICLa1pk4xbbrWr2cX8t+D4d9OmJaRwVWxnv0vTrlhafG
EOF
git config --local gpg.format ssh
git config --local gpg.ssh.allowedSignersFile /tmp/brianni-enclave.allowed_signers
git verify-tag v1.0.0-pcr0-db6dcedf

./infra/docker/vendor-deps.sh
./enclave/build.sh --offline
jq -r .pcr0 enclave/measurement.json
```

The release tags are SSH-signed with the Brianni release key:
`SHA256:vgDASzXg3D8A2xNUFxDkzbCX8ZbauHknSoSilN+AwIA`.

If the printed value matches the table's "Published PCR0" below, open a
Pull Request (or GitHub issue — template in the repo) adding a row to the
Verifications table. If it does not match, open an issue titled
`PCR0 mismatch on <tag>` with your host's AMI, full SHA256SUMS of
`enclave/dist/`, and the output of `docker buildx version`.

A match means: the production enclave you are attesting against can be
rebuilt from the public source and dependency set by an independent party.
That is the property the attestation chain (client PCR0 pin → KMS
`RecipientAttestation:PCR0` → deployed EIF) depends on. Without an
external verifier the single-operator attack model is intact; with at
least one external verifier, the trust surface narrows to "the operator
AND the verifier must collude" for the public PCR0 to differ from the
deployed one.

## Latest release: v1.0.0-pcr0-db6dcedf (2026-06-22)

- **Published PCR0:** `db6dcedf3edf433f88c3ef14404fc419d038f8c99ab45218ad50c9d9f4f144718b720f09b1f22f19298f52dcb2e39981`
- **Published PCR1:** `4b4d5b3661b3efc12920900c80e126e4ce783c522de6c02a2a5bf7af3a2b9327b86776f188e4be1c1c404a129dbda493` (kernel / initramfs — normally stable)
- **Published PCR2:** `f5916a7d6bcd460ee7a55db68d03dd669d2cea19285ca0856c30f7b33fefcbe5f0a6d7e1bbf3eb5a1c580502fc3b03ae` (application layer — rotates on any enclave code change)
- **Vendor manifest SHA256:** `52bd8259c465363c1e41ff275544fbdb5bcbe613dd2bbcc778a0ea079de8627d`
- **Published source commit:** [`acaff4f95ba98dac6a6ab9406205c93be4b19f81`](https://github.com/zeemudia/brianni-enclave/commit/acaff4f95ba98dac6a6ab9406205c93be4b19f81)
- **Release gate:** clean-host builder/appliance proof before public promotion.

### Verifications table

| Verifier | Date (UTC) | Build host (AMI / OS / region) | Observed PCR0 | Result |
|---|---|---|---|---|
| Clean-host release proof | 2026-06-22 | Temporary Nitro builder + separate Nitro host, Amazon Linux 2023 | `db6dcedf3edf433f88c3ef14404fc419d038f8c99ab45218ad50c9d9f4f144718b720f09b1f22f19298f52dcb2e39981` | EIF measurement matched, release-mode enclave booted, local vsock health OK, public attestation valid |

External independent rows should be added below the operator proof once a
third-party verifier rebuilds the tag and reports a matching PCR0. The launch
target is three independent external verifier rows.

### External verification target

Independent verifiers follow the protocol above and add their row to the table.
A match means the production enclave being attested can be rebuilt from the
public source and dependency set by someone outside the operator account.

## Prior releases

Kept for audit trail. Past PCR0s are retired when a release rotates; any
blob wrapped under a retired PCR0 is no longer decryptable (forward
secrecy by design — pre-MVP retired blobs carried no user data).

| Tag | Date | PCR0 | Source commit | Status |
|---|---|---|---|---|
| v0.1.0-pcr0-80e74173 | 2026-04-18 | `80e74173…` | 6369547 | Retired (Phase 2 closeout baseline) |
| v0.1.0-pcr0-778aa155 | 2026-04-19 | `778aa155…` | 4e896a0 | Retired (P1a registry externalisation) |
