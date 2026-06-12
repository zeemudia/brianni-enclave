import { z } from "zod";
import type { ConsentCredentialStore, PinnedWebAuthnCredential } from "./provider-consent";

const OriginAllowlistSchema = z.array(z.string().url()).min(1).max(16);

interface ProviderVisibleConsentCredentialRow {
  credentialId: string;
  publicKeyPem: string;
  rpIdHash: string;
  originAllowlist: unknown;
  previousSignCounter: number;
}

interface PrismaTransactionLike {
  $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  providerVisibleConsentCredential: {
    update(args: {
      where: { userId_credentialId: { userId: string; credentialId: string } };
      data: { signCounter: number };
    }): Promise<unknown>;
  };
}

interface PrismaClientLike {
  $transaction<T>(
    fn: (tx: PrismaTransactionLike) => Promise<T>,
    options?: { isolationLevel?: "Serializable" | string },
  ): Promise<T>;
}

export function createPrismaConsentCredentialStore(input: {
  prisma: PrismaClientLike;
  verifyDeviceKeySignature(args: { userId: string; signerKeyId: string; message: string; signature: string }): Promise<boolean>;
}): ConsentCredentialStore {
  return {
    verifyDeviceKey: input.verifyDeviceKeySignature,
    async withWebAuthnCredentialLock(lockInput, fn) {
      return input.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<ProviderVisibleConsentCredentialRow[]>`
          SELECT "credentialId", "publicKeyPem", "rpIdHash", "originAllowlist", "signCounter" AS "previousSignCounter"
          FROM "ProviderVisibleConsentCredential"
          WHERE "userId" = ${lockInput.userId}
            AND "credentialId" = ${lockInput.credentialId}
            AND "revokedAt" IS NULL
          FOR UPDATE
        `;
        const row = rows[0];
        if (!row) return false;
        const origins = OriginAllowlistSchema.safeParse(row.originAllowlist);
        if (!origins.success) return false;
        const credential: PinnedWebAuthnCredential = {
          credentialId: row.credentialId,
          publicKeyPem: row.publicKeyPem,
          rpIdHash: row.rpIdHash,
          originAllowlist: origins.data,
          previousSignCounter: row.previousSignCounter,
        };
        const result = await fn(credential);
        if (!result.ok) return false;
        await tx.providerVisibleConsentCredential.update({
          where: { userId_credentialId: { userId: lockInput.userId, credentialId: lockInput.credentialId } },
          data: { signCounter: result.nextSignCounter },
        });
        return true;
      }, { isolationLevel: "Serializable" });
    },
  };
}
