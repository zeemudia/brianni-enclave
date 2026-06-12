import { describe, expect, it } from "vitest";
import { createPrismaConsentCredentialStore } from "../media/consent-credential-store";

describe("ConsentCredentialStore", () => {
  it("locks the credential row, validates JSON origins, and persists the next sign counter", async () => {
    const sql: string[] = [];
    const updates: unknown[] = [];
    const prisma = {
      $transaction: async (fn: (tx: unknown) => Promise<boolean>, options: unknown) => {
        expect(options).toMatchObject({ isolationLevel: "Serializable" });
        return fn({
          $queryRaw: async (strings: TemplateStringsArray) => {
            sql.push(strings.join("?"));
            return [{
              credentialId: "cred_1",
              publicKeyPem: "pem",
              rpIdHash: "rp_hash",
              originAllowlist: ["https://app.calypso.local"],
              previousSignCounter: 41,
            }];
          },
          providerVisibleConsentCredential: {
            update: async (args: unknown) => updates.push(args),
          },
        });
      },
    };

    const store = createPrismaConsentCredentialStore({
      prisma: prisma as never,
      verifyDeviceKeySignature: async () => true,
    });
    const ok = await store.withWebAuthnCredentialLock({ userId: "user_1", credentialId: "cred_1" }, async (credential) => {
      expect(credential.previousSignCounter).toBe(41);
      return { ok: true, nextSignCounter: 42 };
    });

    expect(ok).toBe(true);
    expect(sql.join("\n")).toContain("FOR UPDATE");
    expect(sql.join("\n")).toContain('"userId" =');
    expect(updates).toEqual([
      {
        where: { userId_credentialId: { userId: "user_1", credentialId: "cred_1" } },
        data: { signCounter: 42 },
      },
    ]);
  });

  it("fails closed without updating when the stored origin list is malformed or the counter regresses", async () => {
    const updates: unknown[] = [];
    const rows = [
      [{ credentialId: "cred_1", publicKeyPem: "pem", rpIdHash: "rp_hash", originAllowlist: ["not a url"], previousSignCounter: 41 }],
      [{ credentialId: "cred_1", publicKeyPem: "pem", rpIdHash: "rp_hash", originAllowlist: ["https://app.calypso.local"], previousSignCounter: 42 }],
    ];
    const prisma = {
      $transaction: async (fn: (tx: unknown) => Promise<boolean>) =>
        fn({
          $queryRaw: async () => rows.shift() ?? [],
          providerVisibleConsentCredential: { update: async (args: unknown) => updates.push(args) },
        }),
    };
    const store = createPrismaConsentCredentialStore({
      prisma: prisma as never,
      verifyDeviceKeySignature: async () => true,
    });

    await expect(store.withWebAuthnCredentialLock({ userId: "user_1", credentialId: "cred_1" }, async () => ({ ok: true, nextSignCounter: 42 }))).resolves.toBe(false);
    await expect(store.withWebAuthnCredentialLock({ userId: "user_1", credentialId: "cred_1" }, async () => ({ ok: false, reason: "WEBAUTHN_SIGN_COUNTER_REGRESSED" }))).resolves.toBe(false);
    expect(updates).toEqual([]);
  });

  it("binds each credential lookup to the call-scoped user id when a store instance is reused", async () => {
    const updates: unknown[] = [];
    const prisma = {
      $transaction: async (fn: (tx: unknown) => Promise<boolean>) =>
        fn({
          $queryRaw: async (_strings: TemplateStringsArray, userId: string, credentialId: string) => [{
            credentialId,
            publicKeyPem: "pem",
            rpIdHash: "rp_hash",
            originAllowlist: ["https://app.calypso.local"],
            previousSignCounter: userId === "user_a" ? 1 : 10,
          }],
          providerVisibleConsentCredential: { update: async (args: unknown) => updates.push(args) },
        }),
    };
    const store = createPrismaConsentCredentialStore({
      prisma: prisma as never,
      verifyDeviceKeySignature: async () => true,
    });

    await store.withWebAuthnCredentialLock({ userId: "user_a", credentialId: "cred_1" }, async () => ({ ok: true, nextSignCounter: 2 }));
    await store.withWebAuthnCredentialLock({ userId: "user_b", credentialId: "cred_1" }, async () => ({ ok: true, nextSignCounter: 11 }));

    expect(updates).toEqual([
      { where: { userId_credentialId: { userId: "user_a", credentialId: "cred_1" } }, data: { signCounter: 2 } },
      { where: { userId_credentialId: { userId: "user_b", credentialId: "cred_1" } }, data: { signCounter: 11 } },
    ]);
  });
});
