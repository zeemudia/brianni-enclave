import vectors from "./citation-anchor-vectors.json" with { type: "json" };

export const CITATION_ANCHOR_HMAC_SALT = "brianni:citation-anchor-hmac:salt:v1";
export const CITATION_ANCHOR_HMAC_INFO = "brianni:citation-anchor-hmac:v1";
export const CITATION_ANCHOR_KEY_LENGTH = 32;

export type CitationAnchorVector =
  | {
      name: string;
      conversationKeyHex: string;
      content: string;
      startIndex: number;
      endIndex: number;
      salt: typeof CITATION_ANCHOR_HMAC_SALT;
      info: typeof CITATION_ANCHOR_HMAC_INFO;
      len: 32;
      substring: string;
      utf8MessageHex: string;
      anchorKeyHex: string;
      hmacSha256Hex: string;
      anchorTextHash: string;
    }
  | {
      name: string;
      content: string;
      startIndex: number;
      endIndex: number;
      rejectedBeforeHmac: true;
      reason: "surrogate_boundary" | "malformed_utf16";
    };

export const CITATION_ANCHOR_VECTORS =
  vectors as readonly CitationAnchorVector[];
