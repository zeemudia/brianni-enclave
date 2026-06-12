import { describe, expect, it } from "vitest";
import type { MediaProvenanceRecord } from "@calypso/chat-types";
import { evaluateRenderCustody } from "../media/custody-gate";

const publicRecord: MediaProvenanceRecord = {
  handleId: "mh_public",
  kind: "image",
  origin: "public",
  providerVisible: false,
  sourceHandleIds: [],
  createdBy: "import",
  createdAt: "2026-05-19T08:00:00.000Z",
  ttlSeconds: 900,
  byteSize: 4,
  sha256: "a".repeat(64),
  signature: "sig",
};

const privateRecord: MediaProvenanceRecord = {
  ...publicRecord,
  handleId: "mh_private",
  origin: "generated_from_private",
  sha256: "b".repeat(64),
};

describe("render custody gate", () => {
  it("allows generated/public inputs on a non-attested renderer", () => {
    expect(
      evaluateRenderCustody({
        records: [publicRecord],
        rendererTrustLevel: "non_attested_generated_only",
      }),
    ).toEqual({ allowed: true, custody: "public_or_generated" });
  });

  it("blocks private-tainted inputs on a non-attested renderer", () => {
    expect(
      evaluateRenderCustody({
        records: [privateRecord],
        rendererTrustLevel: "non_attested_generated_only",
      }),
    ).toEqual({
      allowed: false,
      reason: "SECURE_RENDERING_UNAVAILABLE",
      custody: "private",
    });
  });

  it("allows private-tainted inputs only with attested rendering", () => {
    expect(
      evaluateRenderCustody({
        records: [privateRecord],
        rendererTrustLevel: "attested",
      }),
    ).toEqual({ allowed: true, custody: "private" });
  });
});
