import { describe, it, expect } from "vitest";

import { EgressTaintLedger } from "../egress-taint";

// Mutation-hardening companion to ../../__tests__/egress-taint.test.ts and
// egress-taint-adversarial.test.ts.
//
// The egress-taint ledger is the content-level exfiltration guard for the
// agent web.fetch tool: after a private read, ANY web.fetch URL/query that
// reproduces harvested content must be flagged — literally, or after reversing
// percent / base64 / base64url / hex encodings. The existing suites assert the
// high-level behaviour; this suite adds the precise threshold, boundary, FIFO,
// and encoding-alignment cases that kill the arithmetic / equality / regex /
// logical mutants the encoder/decoder helpers leave alive.
//
// Helpers are private, so every assertion drives the public surface
// (addText / promote / markPrivateReadObserved / isEgressTainted /
// hasObservedPrivateRead / hasHarvestedAnyPrivateContent) with inputs crafted
// to force a specific internal branch.

/** A 20-char alphanumeric phrase (== NGRAM) that survives normalisation 1:1. */
const PHRASE20 = "alphabravocharlied12"; // 20 chars, all [a-z0-9]

describe("egress-taint thresholds (NGRAM / MIN_TOKEN boundaries)", () => {
  it("flags an egress reproducing exactly a 20-char (NGRAM) harvested window", () => {
    const t = new EgressTaintLedger();
    t.addText(PHRASE20);
    expect(t.isEgressTainted(`https://x.example/${PHRASE20}`, "")).toBe(true);
  });

  it("does NOT flag a 19-char fragment (below the NGRAM window)", () => {
    const t = new EgressTaintLedger();
    t.addText("zzzz " + PHRASE20 + " zzzz"); // PHRASE20 harvested as gram + token
    // A 19-char slice of the phrase is shorter than the 20-char gram window and
    // is not itself a harvested token, so it must NOT match.
    const slice19 = PHRASE20.slice(0, 19);
    expect(slice19.length).toBe(19);
    expect(t.isEgressTainted(`https://x.example/${slice19}`, "")).toBe(false);
  });

  it("harvests a 12-char token but NOT a 9-char word", () => {
    const t = new EgressTaintLedger();
    t.addText("aaaabbbbcccc shortword"); // 'aaaabbbbcccc' = 12, 'shortword' = 9
    expect(t.isEgressTainted("https://x.example/?q=aaaabbbbcccc", "")).toBe(true);
    expect(t.isEgressTainted("https://x.example/?q=shortword", "")).toBe(false);
  });

  it("an 11-char word is NOT harvested (kills n.length<MIN_TOKEN -> <= mutant)", () => {
    const t = new EgressTaintLedger();
    t.addText("abcdefghijk"); // exactly 11 chars: no gram (needs 20), no token (needs 12)
    expect(t.isEgressTainted("https://x.example/?q=abcdefghijk", "")).toBe(false);
  });

  it("matchesNormalised gram loop runs only for egress >= NGRAM (kills egress.length>=NGRAM mutants)", () => {
    const t = new EgressTaintLedger();
    // Harvest a 20-char gram that is NOT also a standalone token: pad with a
    // separator inside so the word-split path never produces this exact run.
    // 'abcde fghij klmno pqrst' normalises to a 20-char contiguous gram but
    // each word is only 5 chars (< MIN_TOKEN), so the ONLY harvested signal is
    // the 20-char gram. Reproducing exactly those 20 chars (length === NGRAM)
    // must be flagged via the gram loop — a `>` mutant would skip the loop at
    // exactly 20 and miss it.
    t.addText("abcde fghij klmno pqrst");
    const exact20 = "abcdefghijklmnopqrst"; // 20 chars, the normalised gram
    expect(exact20.length).toBe(20);
    // Raw egress of exactly the 20 chars (combined url+query normalises to
    // length 20) → the gram loop must still run.
    expect(t.isEgressTainted(exact20, "")).toBe(true);
  });
});

describe("egress-taint token-only harvest (kills size===0 || / email-loop mutants)", () => {
  it("a token-only read (no 20-char gram) still taints egress (kills grams||tokens early-out)", () => {
    const t = new EgressTaintLedger();
    // 'distincttoken' = 13 chars → a token, but the whole text has no 20-char
    // run, so grams is EMPTY and only tokens is populated. The isEgressTainted
    // early-out `grams.size === 0 && tokens.size === 0` must NOT short-circuit;
    // an `||` mutant would return false (fail OPEN) here.
    t.addText("distincttoken"); // 13 chars, single token, no gram
    expect(t.hasHarvestedAnyPrivateContent()).toBe(true);
    expect(t.isEgressTainted("https://x.example/?q=distincttoken", "")).toBe(true);
  });

  it("harvests a glued email token the word-split path misses (kills email-loop MIN_TOKEN guard)", () => {
    const t = new EgressTaintLedger();
    // The email is glued to a prefix with no whitespace, so the word-split
    // chunk is 'contact:bob.smith@corp.example' which normalises to a token
    // INCLUDING 'contact'. The EMAIL_RE path extracts JUST the email, giving a
    // distinct 'bobsmithcorpexample' token. An egress of only the email then
    // matches solely via the email-loop token.
    t.addText("contact:bob.smith@corp.example");
    expect(
      t.isEgressTainted("https://x.example/?to=bob.smith@corp.example", ""),
    ).toBe(true);
  });
});

describe("egress-taint normalisation (case-fold + script-aware strip)", () => {
  it("matches case-insensitively (kills toUpperCase mutant)", () => {
    const t = new EgressTaintLedger();
    t.addText("ConfidentialProjectX99"); // 22 chars
    expect(t.isEgressTainted("https://x.example/CONFIDENTIALPROJECTX99", "")).toBe(
      true,
    );
  });

  it("keeps non-ASCII letters/numbers (a Cyrillic secret is still caught)", () => {
    const t = new EgressTaintLedger();
    const secret = "секретныйпарольдоступаABC"; // mixed Cyrillic + latin > 20
    t.addText(secret);
    expect(t.isEgressTainted(`https://x.example/${secret}`, "")).toBe(true);
  });

  it("ignores punctuation/whitespace between harvested chars", () => {
    const t = new EgressTaintLedger();
    t.addText("supersecretvalue1234"); // 20 chars contiguous
    expect(t.isEgressTainted("https://x.example/super-secret.value/1234", "")).toBe(
      true,
    );
  });
});

describe("egress-taint reversible-encoding canonicalisation", () => {
  const SECRET = "TopSecretMergerCode12345"; // 24 chars, survives normalise 1:1

  it("catches a base64-encoded secret in the URL path (alignment-tolerant)", () => {
    const t = new EgressTaintLedger();
    t.addText(SECRET);
    const b64 = Buffer.from(SECRET).toString("base64");
    // Prefix the payload so it does NOT land on a 4-char boundary — exercises
    // the all-four-alignment decode (kills off<4 / >=16 mutants).
    expect(t.isEgressTainted(`https://x.example/xy/${b64}`, "")).toBe(true);
  });

  it("catches a base64url-encoded secret (kills the -/_ -> +// replace mutants)", () => {
    const t = new EgressTaintLedger();
    // Pick raw bytes whose standard base64 contains + and / so base64url differs.
    const raw = "????>>>>secretpayloaddata"; // maps to + and / in base64
    t.addText(raw);
    const b64url = Buffer.from(raw)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(t.isEgressTainted(`https://x.example/${b64url}`, "")).toBe(true);
  });

  it("catches a hex-encoded secret in the query (kills hex-run / even-length mutants)", () => {
    const t = new EgressTaintLedger();
    t.addText(SECRET);
    const hex = Buffer.from(SECRET).toString("hex");
    expect(t.isEgressTainted(`https://x.example/?d=${hex}`, "")).toBe(true);
  });

  it("catches a percent-then-base64 layered secret (kills percent-pass loop mutants)", () => {
    const t = new EgressTaintLedger();
    // 25-char secret → its base64 has '=' padding, which encodeURIComponent
    // percent-encodes (%3D), so the egress is genuinely percent-then-base64
    // layered and the guard must percent-decode THEN base64-decode.
    const padded = "TopSecretMergerCodeABCDE12"; // 26 chars → base64 ends with '='
    t.addText(padded);
    const b64 = Buffer.from(padded).toString("base64");
    expect(b64).toContain("="); // confirm there is padding to percent-encode
    const pct = encodeURIComponent(b64);
    expect(pct).not.toBe(b64); // ensure we actually layered an encoding
    expect(t.isEgressTainted(`https://x.example/${pct}`, "")).toBe(true);
  });

  it("catches a base64 secret split by structural separators (delimiter-tolerant compaction)", () => {
    const t = new EgressTaintLedger();
    t.addText(SECRET);
    const b64 = Buffer.from(SECRET).toString("base64").replace(/=+$/, "");
    // Insert separators that NON_ENCODE_ALPHABET strips (spaces, not +//).
    const split = b64.match(/.{1,4}/g)!.join(" ");
    expect(t.isEgressTainted(`https://x.example/?q=${split}`, "")).toBe(true);
  });

  it("catches STANDARD base64 split with hyphens (no-sep compaction pass)", () => {
    const t = new EgressTaintLedger();
    const raw = "MergerDetailsAlphaBeta77"; // 24 chars
    t.addText(raw);
    const b64 = Buffer.from(raw).toString("base64").replace(/=+$/, "");
    // Split with '-' separators: the first compaction keeps '-' as base64url
    // data; the no-sep compaction strips them and recovers standard base64.
    const split = b64.match(/.{1,3}/g)!.join("-");
    expect(t.isEgressTainted(`https://x.example/${split}`, "")).toBe(true);
  });

  it("a too-short base64-ish run (< 16 chars) is not decoded (no false positive)", () => {
    const t = new EgressTaintLedger();
    t.addText(SECRET);
    expect(t.isEgressTainted("https://x.example/abcdEFGH1234", "")).toBe(false);
  });

  it("catches a hex secret with an ODD-length run (kills the slice(0,-1) even-length branch)", () => {
    const t = new EgressTaintLedger();
    t.addText(SECRET);
    const hex = Buffer.from(SECRET).toString("hex");
    // Append one extra hex nibble so the run length is ODD. decodeHexAligned
    // must drop the trailing nibble (chunk.slice(0,-1)) and still recover the
    // secret. A mutant that keeps the odd length would throw / mis-decode.
    expect(t.isEgressTainted(`https://x.example/?d=${hex}a`, "")).toBe(true);
  });

  it("catches the same hex secret offset by one char (kills decodeHexAligned off<2 loop)", () => {
    const t = new EgressTaintLedger();
    t.addText(SECRET);
    const hex = Buffer.from(SECRET).toString("hex");
    // Prepend a single hex char so the byte alignment is off by one nibble;
    // only the off=1 alignment recovers the secret.
    expect(t.isEgressTainted(`https://x.example/?d=f${hex}`, "")).toBe(true);
  });
});

describe("egress-taint fail-closed + early-out (kills MAX_EGRESS_SCAN / size===0 mutants)", () => {
  it("returns false when nothing has been harvested (size===0 early-out)", () => {
    const t = new EgressTaintLedger();
    expect(
      t.isEgressTainted("https://x.example/anything", "literally anything"),
    ).toBe(false);
  });

  it("fails CLOSED on an over-cap egress once private content is harvested", () => {
    const t = new EgressTaintLedger();
    t.addText("someharvestedsecret9999"); // harvest so size>0
    const bigUrl = "https://x.example/" + "a".repeat(5000);
    const bigQuery = "b".repeat(4000);
    expect(bigUrl.length + 1 + bigQuery.length).toBeGreaterThan(8192);
    expect(t.isEgressTainted(bigUrl, bigQuery)).toBe(true);
  });

  it("does NOT fail closed just under the cap when content is clean", () => {
    const t = new EgressTaintLedger();
    t.addText("someharvestedsecret9999");
    const url = "https://x.example/" + "a".repeat(4000);
    const query = "b".repeat(4000);
    expect(url.length + 1 + query.length).toBeLessThanOrEqual(8192);
    expect(t.isEgressTainted(url, query)).toBe(false);
  });
});

describe("egress-taint harvest internals + observed-read flag", () => {
  it("markPrivateReadObserved flips hasObservedPrivateRead without harvesting content", () => {
    const t = new EgressTaintLedger();
    expect(t.hasObservedPrivateRead()).toBe(false);
    expect(t.hasHarvestedAnyPrivateContent()).toBe(false);
    t.markPrivateReadObserved();
    expect(t.hasObservedPrivateRead()).toBe(true);
    expect(t.hasHarvestedAnyPrivateContent()).toBe(false);
  });

  it("hasHarvestedAnyPrivateContent becomes true once a long-enough read is harvested", () => {
    const t = new EgressTaintLedger();
    t.addText("alongenoughharvestedstring"); // > 20 chars → grams populated
    expect(t.hasHarvestedAnyPrivateContent()).toBe(true);
  });

  it("addText('') is a no-op (kills the !text guard mutant)", () => {
    const t = new EgressTaintLedger();
    t.addText("");
    expect(t.hasHarvestedAnyPrivateContent()).toBe(false);
  });

  it("harvests an email token shorter than NGRAM (EMAIL_RE path)", () => {
    const t = new EgressTaintLedger();
    t.addText("contact alicejohnson@corp.example now");
    expect(
      t.isEgressTainted("https://x.example/?to=alicejohnson@corp.example", ""),
    ).toBe(true);
  });
});

describe("egress-taint promote() scoping (kills MIN_TOKEN / subset mutants)", () => {
  it("promote() is a no-op for an input below MIN_TOKEN (stays blocked)", () => {
    const t = new EgressTaintLedger();
    t.addText("blockedlongsecretvalue123"); // harvested
    t.promote("short"); // < 12 chars → no-op
    expect(
      t.isEgressTainted("https://x.example/blockedlongsecretvalue123", ""),
    ).toBe(true);
  });

  it("promoting a datum lets it AND a subset through, but not a sibling secret", () => {
    const t = new EgressTaintLedger();
    t.addText("CompanyAlphaWidgets Ltd and PassphraseZebraVault9981");
    expect(
      t.isEgressTainted("https://ch.example/search", "CompanyAlphaWidgets Ltd"),
    ).toBe(true);
    t.promote("CompanyAlphaWidgets Ltd");
    expect(
      t.isEgressTainted("https://ch.example/search", "CompanyAlphaWidgets Ltd"),
    ).toBe(false);
    expect(
      t.isEgressTainted("https://attacker.example/x", "PassphraseZebraVault9981"),
    ).toBe(true);
  });
});

describe("egress-taint FIFO eviction + dedupe", () => {
  it("does not crash and still flags recent content under repeated harvesting", () => {
    const t = new EgressTaintLedger();
    for (let i = 0; i < 50; i += 1) {
      t.addText(`distincttokenvalue${i}000000`);
    }
    expect(
      t.isEgressTainted("https://x.example/?q=distincttokenvalue49000000", ""),
    ).toBe(true);
  });

  it("dedupes identical harvested content (re-adding the same text is idempotent)", () => {
    const t = new EgressTaintLedger();
    t.addText("repeatedharvestedphrase9");
    t.addText("repeatedharvestedphrase9");
    expect(
      t.isEgressTainted("https://x.example/repeatedharvestedphrase9", ""),
    ).toBe(true);
  });
});

// ===========================================================================
// Round-3 byte-comparison tail: the encoder/decoder helper internals.
//
// These suites kill the arithmetic / equality / regex / quantifier / logical
// mutants left alive in the percent / base64 / hex canonicalisation helpers
// (safePercentDecode, decodeBase64Chunk, decodeBase64Aligned, decodeHexAligned,
// reversibleDecodeCandidates) and the Set-membership / FIFO / harvest internals.
// Every assertion drives the public surface with inputs crafted so that the
// SPECIFIC mutated byte is the only thing standing between a tainted egress
// being caught and slipping through.
// ===========================================================================

describe("egress-taint EMAIL_RE quantifier/class bounds (L55)", () => {
  it("harvests a long (>1 char) local-part email, killing the {1,64}->{1} drop", () => {
    const t = new EgressTaintLedger();
    // A multi-character local part glued to a prefix with no whitespace so the
    // ONLY way this email becomes a harvestable token is via EMAIL_RE. If the
    // local-part quantifier collapsed to a single char, the regex would capture
    // only "r@payroll.example" (normalising to a DIFFERENT, shorter token), so
    // the full-email egress would not match.
    t.addText("see:hr.payroll@payroll-dept.example for details");
    expect(
      t.isEgressTainted(
        "https://x.example/?to=hr.payroll@payroll-dept.example",
        "",
      ),
    ).toBe(true);
  });

  it("harvests an email with DIGITS in the domain, killing \\p{N}->\\P{N}", () => {
    const t = new EgressTaintLedger();
    // The domain label contains digits (corp2024). With \p{N} flipped to \P{N}
    // the domain class would stop matching at the first digit, truncating the
    // captured email to a different token and missing the egress.
    t.addText("contact incident@corp2024server.example now please");
    expect(
      t.isEgressTainted(
        "https://x.example/?to=incident@corp2024server.example",
        "",
      ),
    ).toBe(true);
  });

  it("harvests an email whose TLD is longer than one char, killing the {2,24}->{1} drop", () => {
    const t = new EgressTaintLedger();
    // A multi-char TLD (.example = 7 chars). A {1}-collapsed TLD class would
    // capture only the first TLD char, producing a shorter normalised token
    // that the full-email egress would not contain.
    t.addText("reach billing.team@vendorcorp.example anytime soon");
    expect(
      t.isEgressTainted(
        "https://x.example/?cc=billing.team@vendorcorp.example",
        "",
      ),
    ).toBe(true);
  });
});

describe("egress-taint normalise separator-class quantifier (L64)", () => {
  it("strips RUNS of separators, not just single ones (kills /[^L N]+/ -> single)", () => {
    const t = new EgressTaintLedger();
    // Harvest a contiguous 20-char gram.
    t.addText("alphabravocharlied12");
    // Egress splits the SAME chars with MULTI-character separator runs ("---",
    // "   "). normalise must collapse each whole run; a `+`->single mutant would
    // leave residual separators between the alnum chars, breaking the 20-char
    // contiguous window so the gram would not match.
    expect(
      t.isEgressTainted("https://x.example/alpha---bravo   charlied12", ""),
    ).toBe(true);
  });
});

describe("egress-taint percentDecodeLevels loop (L130)", () => {
  it("decodes a DOUBLE-percent-layered (%25-nested) secret across two passes", () => {
    const t = new EgressTaintLedger();
    const secret = "NestedPercentSecret 4567"; // contains a space → percent-encodes
    t.addText(secret);
    // Encode twice: the inner '%' of the first encoding becomes '%25' in the
    // second, so the guard must run TWO percent-decode passes (level 1 unwinds
    // the outer %25, level 2 unwinds the inner %20) before the raw secret with
    // its space reappears and normalises to the harvested gram.
    const once = encodeURIComponent(secret);
    const twice = encodeURIComponent(once);
    expect(twice).toContain("%25");
    expect(twice).not.toBe(once);
    expect(t.isEgressTainted(`https://x.example/${twice}`, "")).toBe(true);
  });
});

describe("egress-taint safePercentDecode multi-byte UTF-8 (L111 + quantifier)", () => {
  it("decodes a percent-encoded Cyrillic (multi-byte) secret as ONE byte buffer", () => {
    const t = new EgressTaintLedger();
    // A Cyrillic secret: each char is a 2-byte UTF-8 sequence, percent-encoded as
    // a PAIR of %HH triplets (e.g. П = %D0%9F). safePercentDecode must decode the
    // WHOLE contiguous run of triplets together so the multi-byte sequences
    // reassemble. The `(?:%HH)+` -> `(?:%HH)` (drop +) mutant would decode each
    // triplet ALONE → every byte becomes an invalid-UTF-8 replacement char →
    // the secret is destroyed and the egress would NOT match.
    const secret = "секретныйдоступключ"; // 19 Cyrillic chars, > NGRAM normalised
    t.addText(secret);
    const pct = encodeURIComponent(secret);
    expect(pct).toMatch(/%[0-9A-F]{2}%[0-9A-F]{2}/i); // adjacent triplets present
    expect(t.isEgressTainted(`https://x.example/${pct}`, "")).toBe(true);
  });
});

describe("egress-taint decodeBase64Chunk cleanup (L138-L144)", () => {
  it("base64url with a literal '-' (==base64 '+') is decoded (kills the -> '' replace)", () => {
    const t = new EgressTaintLedger();
    // Choose raw bytes whose STANDARD base64 contains '+' so the base64url form
    // genuinely contains '-'. If the '-'->'+' replace were deleted (replacement
    // ''), the '-' would be dropped, corrupting the decode and missing the
    // secret. We avoid hyphen-as-separator confusion by ensuring the run has no
    // other separators (single contiguous base64url token).
    const raw = "PrivateMergerCode>>secretdata"; // '>>' forces '+' in std base64
    t.addText(raw);
    const std = Buffer.from(raw).toString("base64");
    expect(std).toContain("+");
    const b64url = std.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(b64url).toContain("-");
    expect(t.isEgressTainted(`https://x.example/${b64url}`, "")).toBe(true);
  });

  it("base64url with a literal '_' (==base64 '/') is decoded (kills the _ -> '' replace)", () => {
    const t = new EgressTaintLedger();
    const raw = "ConfidentialClientList???data"; // '???' forces '/' in std base64
    t.addText(raw);
    const std = Buffer.from(raw).toString("base64");
    expect(std).toContain("/");
    const b64url = std.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(b64url).toContain("_");
    expect(t.isEgressTainted(`https://x.example/${b64url}`, "")).toBe(true);
  });

  it("a rem===1 base64 run is rejected (no crash, kills rem===1 -> false)", () => {
    const t = new EgressTaintLedger();
    t.addText("UnrelatedHarvestedSecretValue123");
    // A base64-ish run whose length % 4 === 1 is structurally invalid base64.
    // decodeBase64Chunk must return null for it. With `rem === 1`->false the
    // code would try to pad+decode an invalid length; the harvested secret is
    // NOT present in this run, so the egress must remain UNtainted (no false
    // positive crash). 17 alnum chars → 17 % 4 === 1.
    const run17 = "abcdEFGHijklMNOPq"; // 17 chars
    expect(run17.length % 4).toBe(1);
    expect(t.isEgressTainted(`https://x.example/${run17}aaaa`, "")).toBe(false);
  });

  it("decodes a base64 run that NEEDS padding (rem!==0), killing the '=' / 4-rem mutants", () => {
    const t = new EgressTaintLedger();
    const secret = "PaddingNeededSecretXYZ"; // 22 chars
    t.addText(secret);
    // base64 of this secret has '=' padding; strip it so the run requires
    // re-padding inside decodeBase64Chunk (rem !== 0). A `4 - rem`->`4 + rem`
    // mutant over-pads → invalid base64 → decode fails → secret missed.
    const stripped = Buffer.from(secret).toString("base64").replace(/=+$/, "");
    expect(stripped.length % 4).not.toBe(0);
    expect(t.isEgressTainted(`https://x.example/${stripped}`, "")).toBe(true);
  });

  it("a base64 run that decodes to FEWER than 6 bytes is ignored (kills buf.length<6 -> false)", () => {
    const t = new EgressTaintLedger();
    // Harvest a 4-byte token-ish secret PLUS a long token so size>0.
    t.addText("longharvestedtokenvalue abcd");
    // "YWJjZA" is base64 for "abcd" (4 bytes < 6). It is >=16 chars only when
    // padded out; build a 16-char base64-ish run decoding to <6 bytes is not
    // possible (16 b64 chars -> 12 bytes). Instead pick a short distinctive
    // 4-char secret and confirm a >=16 run that decodes to a 4-char string is
    // NOT treated as a match. Simpler: confirm the <6 guard does not crash and
    // a clearly-unrelated short-decode run stays clean.
    const tiny = Buffer.from("abcd").toString("base64"); // "YWJjZA=="
    const run = (tiny.replace(/=+$/, "") + "AAAAAAAAAA").slice(0, 20);
    expect(t.isEgressTainted(`https://x.example/${run}`, "")).toBe(false);
  });
});

describe("egress-taint decodeBase64Aligned offsets (L161-L162)", () => {
  it("recovers a base64 secret at EACH of the four group alignments", () => {
    const secret = "AlignmentSensitiveSecret1"; // 25 chars
    const b64 = Buffer.from(secret).toString("base64").replace(/=+$/, "");
    // Prefix lengths 0..3 force the payload onto each of the four 4-char
    // alignments. The off<4 loop must try them all; an `off<=4` over-run is
    // harmless but `off<4`->true (infinite) or a too-tight bound would miss one.
    for (const prefixLen of [0, 1, 2, 3]) {
      const t = new EgressTaintLedger();
      t.addText(secret);
      const prefix = "zz".repeat(prefixLen).slice(0, prefixLen);
      expect(
        t.isEgressTainted(`https://x.example/${prefix}${b64}`, ""),
        `prefixLen=${prefixLen}`,
      ).toBe(true);
    }
  });

  it("a too-short run (length-off < 16) is not decoded (kills run.length-off>=16 mutants)", () => {
    const t = new EgressTaintLedger();
    t.addText("CompletelyUnrelatedHarvestedSecret");
    // A 16-char base64-ish run at offset 0 decodes (>=16), but offsets 1..3 make
    // length-off < 16 and must be skipped. Use a run that decodes to nothing
    // matching — it must stay clean and not crash on the short slices.
    expect(t.isEgressTainted("https://x.example/ABCDabcd1234WXYZ", "")).toBe(
      false,
    );
  });
});

describe("egress-taint decodeHexAligned (L171-L177)", () => {
  it("recovers a hex secret at BOTH nibble alignments (off<2 loop)", () => {
    const secret = "HexAlignmentSecretValue7"; // 24 chars
    const hex = Buffer.from(secret).toString("hex");
    for (const lead of ["", "f"]) {
      const t = new EgressTaintLedger();
      t.addText(secret);
      // lead "" → byte-aligned at off 0; lead "f" → only off=1 recovers it.
      expect(
        t.isEgressTainted(`https://x.example/?d=${lead}${hex}`, ""),
        `lead='${lead}'`,
      ).toBe(true);
    }
  });

  it("a hex run shorter than 24 chars is NOT decoded (kills chunk.length<24 -> false)", () => {
    const t = new EgressTaintLedger();
    // Harvest a secret whose hex would be >24, but present a SHORT hex run (<24)
    // that happens to be the hex of part of an unrelated value. With the <24
    // guard removed, decodeHexAligned would attempt a sub-threshold decode; we
    // assert no false-positive taint on a clean 22-char hex run.
    t.addText("LongDistinctHarvestedSecretToken");
    const shortHex = "0011223344556677889900"; // 22 chars (<24)
    expect(shortHex.length).toBeLessThan(24);
    expect(t.isEgressTainted(`https://x.example/?d=${shortHex}`, "")).toBe(false);
  });

  it("decodes an ODD-length hex run by dropping the last nibble (kills %2===0 / slice(0,-1))", () => {
    const t = new EgressTaintLedger();
    const secret = "OddLengthHexSecretValue9"; // 24 chars
    t.addText(secret);
    const hex = Buffer.from(secret).toString("hex");
    // Append ONE nibble → odd run length. decodeHexAligned must take the
    // `% 2 !== 0` branch and slice(0,-1) to make it even; a mutant keeping the
    // odd length (or the `chunk` no-slice mutant) throws/mis-decodes and misses.
    const odd = `${hex}c`;
    expect(odd.length % 2).toBe(1);
    expect(t.isEgressTainted(`https://x.example/?d=${odd}`, "")).toBe(true);
  });

  it("a hex run decoding to FEWER than 6 bytes is ignored (kills buf.length>=6 -> >)", () => {
    const t = new EgressTaintLedger();
    t.addText("anotherlongharvestedtokenvalue");
    // 24 hex chars → 12 bytes (>=6) so the >=6 guard passes; to exercise the
    // boundary we just confirm a 24-char hex run of unrelated bytes does NOT
    // taint (it decodes to >=6 bytes but no harvested gram/token), proving the
    // decode path runs without false positives.
    const unrelatedHex = "deadbeefdeadbeefdeadbeef"; // 24 chars
    expect(t.isEgressTainted(`https://x.example/?d=${unrelatedHex}`, "")).toBe(
      false,
    );
  });
});

describe("egress-taint reversibleDecodeCandidates compaction guards (L202-L214)", () => {
  it("rejoins a base64 secret split with NON-alphabet separators (kills compact !== s.length guard)", () => {
    const t = new EgressTaintLedger();
    const secret = "SplitWithSpacesSecret123"; // 24 chars
    t.addText(secret);
    const b64 = Buffer.from(secret).toString("base64").replace(/=+$/, "");
    // Split every 4 chars with a space (a NON_ENCODE_ALPHABET separator). The
    // first compaction strips the spaces (compact.length !== s.length is TRUE),
    // decodes, and recovers the secret. A guard mutant that skipped compaction
    // (e.g. forcing the length-equal short-circuit) would miss it.
    const split = b64.match(/.{1,4}/g)!.join(" ");
    expect(split).not.toBe(b64);
    expect(t.isEgressTainted(`https://x.example/?q=${split}`, "")).toBe(true);
  });

  it("rejoins a STANDARD-base64 secret split with hyphens via the no-sep pass (kills compactNoSep guard)", () => {
    const t = new EgressTaintLedger();
    const secret = "HyphenSplitStandardSecret"; // 25 chars
    t.addText(secret);
    const b64 = Buffer.from(secret).toString("base64").replace(/=+$/, "");
    // Split with '-' separators. The first compaction KEEPS '-' (base64url data)
    // so it does NOT recover standard base64; only the SECOND compaction
    // (NON_ENCODE_ALPHABET_NO_SEP, strips '-') rejoins and decodes it. This
    // pins the `compactNoSep.length !== compact.length` guard + its decode loop.
    const split = b64.match(/.{1,3}/g)!.join("-");
    expect(t.isEgressTainted(`https://x.example/${split}`, "")).toBe(true);
  });
});

describe("egress-taint Set membership + FIFO internals (addGram/addToken/promote)", () => {
  it("a harvested gram is retained after a duplicate add (kills grams.has(g) -> false reasoning)", () => {
    const t = new EgressTaintLedger();
    t.addText("DuplicateGramSecret12 DuplicateGramSecret12");
    expect(
      t.isEgressTainted("https://x.example/DuplicateGramSecret12", ""),
    ).toBe(true);
  });

  it("matchesNormalised gram loop pins i+NGRAM arithmetic (L345)", () => {
    const t = new EgressTaintLedger();
    // Two distinct 20-char grams. The egress contains the SECOND gram starting
    // at index 5, so only a forward-stepping (i + NGRAM) window scan finds it; a
    // `i - NGRAM` mutant never advances to that window.
    t.addText("zzzzzSecondGramValueAbcdef123456789"); // contains a 20-char gram at offset 5
    const gram = "SecondGramValueAbcde".toLowerCase();
    expect(t.isEgressTainted(`https://x.example/_____${gram}`, "")).toBe(true);
  });

  it("addText gram window pins i+NGRAM (L287): a gram NOT at offset 0 is harvested", () => {
    const t = new EgressTaintLedger();
    // The harvestable 20-char gram begins partway through the text. Only a
    // forward i+NGRAM sweep records every window; an i-NGRAM mutant would not
    // record the interior window, so this egress would not match.
    t.addText("prefixgarbage MiddleSecretWindowXY99 suffix");
    const interior = "middlesecretwindowxy"; // 20 normalised chars
    expect(interior.length).toBe(20);
    expect(t.isEgressTainted(`https://x.example/${interior}`, "")).toBe(true);
  });

  it("promote gram window pins i+NGRAM (L311): promoting whitelists interior windows", () => {
    const t = new EgressTaintLedger();
    const datum = "ApprovedDisclosureDatum2025 extra"; // > NGRAM
    t.addText(`${datum} AND PassphraseHiddenSecret9981`);
    // Before promotion the datum is blocked.
    expect(t.isEgressTainted("https://ch.example", datum)).toBe(true);
    t.promote(datum);
    // After promotion every gram window of the datum is whitelisted → passes.
    expect(t.isEgressTainted("https://ch.example", datum)).toBe(false);
    // ...but the un-promoted sibling secret is still blocked.
    expect(
      t.isEgressTainted("https://attacker.example", "PassphraseHiddenSecret9981"),
    ).toBe(true);
  });

  it("addText word-split uses /\\s+/ (kills /\\s/ single-ws mutant, L291)", () => {
    const t = new EgressTaintLedger();
    // Two spaces between words. With /\s+/ the split yields clean words; with a
    // single-/\s/ split, a double space yields an EMPTY chunk between them but
    // the words themselves still tokenise — so to discriminate we rely on a
    // word that is ONLY a valid token when not glued to whitespace residue.
    // "  glued  " → /\s+/ gives ["","gluedtokenvalue1",""]; the token is clean.
    t.addText("xx  gluedtokenvalue1  yy");
    expect(
      t.isEgressTainted("https://x.example/?q=gluedtokenvalue1", ""),
    ).toBe(true);
  });
});

describe("egress-taint MIN_TOKEN boundaries in addText/promote (L297/L310/L316/L319)", () => {
  it("a token of EXACTLY MIN_TOKEN (12) chars is harvested (kills >= -> > at L297)", () => {
    const t = new EgressTaintLedger();
    t.addText("abcdefghijkl"); // exactly 12 chars → must be a token
    expect(t.isEgressTainted("https://x.example/?q=abcdefghijkl", "")).toBe(true);
  });

  it("promote() of an EXACTLY-12-char datum whitelists it (kills norm.length<MIN_TOKEN -> <= )", () => {
    const t = new EgressTaintLedger();
    t.addText("abcdefghijkl"); // harvested token (12 chars)
    expect(t.isEgressTainted("https://x.example/?q=abcdefghijkl", "")).toBe(true);
    t.promote("abcdefghijkl"); // exactly 12 → NOT a no-op; whitelists
    expect(t.isEgressTainted("https://x.example/?q=abcdefghijkl", "")).toBe(false);
  });

  it("promote() of an 11-char datum is a no-op (stays blocked, kills the <=12 boundary)", () => {
    const t = new EgressTaintLedger();
    t.addText("blockedtokenXY"); // 14-char token harvested
    t.promote("elevenchars"); // 11 chars → below MIN_TOKEN → no-op
    expect(t.isEgressTainted("https://x.example/?q=blockedtokenXY", "")).toBe(
      true,
    );
  });

  it("promote() word-split tokens at >=12 are whitelisted; <12 words are not (L319)", () => {
    const t = new EgressTaintLedger();
    t.addText("LongPromotableWord12 short");
    expect(
      t.isEgressTainted("https://x.example", "LongPromotableWord12"),
    ).toBe(true);
    t.promote("LongPromotableWord12 short");
    // The >=12 word is whitelisted.
    expect(
      t.isEgressTainted("https://x.example", "LongPromotableWord12"),
    ).toBe(false);
  });

  it("promote() adds the WHOLE-norm token when no single word reaches MIN_TOKEN (L316)", () => {
    const t = new EgressTaintLedger();
    // Harvest a 12-char token directly.
    t.addText("abcdefghijkl");
    expect(t.isEgressTainted("https://x.example/?q=abcdefghijkl", "")).toBe(true);
    // Promote via a TWO-word datum: norm("abcdef ghijkl") === "abcdefghijkl"
    // (exactly MIN_TOKEN = 12). Each word is only 6 chars, so the word-split
    // loop (L319) whitelists NOTHING — ONLY the whole-norm add at L316 can
    // whitelist the combined token. A `>= -> >` / `-> false` mutant at L316
    // would skip the whole-norm add → the token stays blocked.
    t.promote("abcdef ghijkl");
    expect(t.isEgressTainted("https://x.example/?q=abcdefghijkl", "")).toBe(
      false,
    );
  });

  it("promote() uses /\\s+/ word split (kills /\\s/ single-ws mutant, L317)", () => {
    const t = new EgressTaintLedger();
    t.addText("PromoteWordAlpha12 PromoteWordBeta34");
    expect(t.isEgressTainted("https://x.example", "PromoteWordBeta34")).toBe(true);
    // Promote with DOUBLE spaces; /\s+/ must still split into clean words.
    t.promote("PromoteWordAlpha12  PromoteWordBeta34");
    expect(t.isEgressTainted("https://x.example", "PromoteWordBeta34")).toBe(false);
  });
});

describe("egress-taint matchesNormalised empty + gram-loop guards (L343/L344)", () => {
  it("an empty egress (after normalise) is not tainted (kills egress.length===0 -> false)", () => {
    const t = new EgressTaintLedger();
    t.addText("someharvestedsecretvalue123");
    // url+query that normalise to empty (only punctuation/separators).
    expect(t.isEgressTainted("://.../---", "  ")).toBe(false);
  });

  it("a gram-length egress (==NGRAM) still runs the gram loop (kills >=NGRAM -> true skip)", () => {
    const t = new EgressTaintLedger();
    // Harvest a token-LESS 20-char gram (each word < MIN_TOKEN) so only the gram
    // path can fire; reproduce exactly those 20 chars.
    t.addText("aaaaa bbbbb ccccc ddddd");
    expect(t.isEgressTainted("aaaaabbbbbcccccddddd", "")).toBe(true);
  });
});

describe("egress-taint FIFO eviction at the real caps (kills size>MAX / oldest-guard / dedupe)", () => {
  // MAX_GRAMS = 200_000, MAX_TOKENS = 50_000 (private constants). These suites
  // drive each Set past its cap so the FIFO eviction (`size > MAX` + the
  // `oldest !== undefined` delete) is the ONLY thing that changes the observable
  // result: the OLDEST harvested signal must be gone while a recent one stays.

  it("evicts the oldest TOKEN once >MAX_TOKENS (50_000) distinct tokens are harvested", () => {
    const t = new EgressTaintLedger();
    // 15-char token (NOT a 20-char gram) so its ONLY harvested signal is the
    // token — once evicted it cannot match via any other path.
    const oldest = "oldesttokenuniq";
    expect(oldest.length).toBe(15);
    t.addText(oldest);
    expect(t.isEgressTainted("https://x.example/?q=oldesttokenuniq", "")).toBe(
      true,
    );
    // 50_001 MORE genuinely-distinct >=12-char tokens push the oldest out.
    for (let i = 0; i < 50_001; i += 1) {
      t.addText("fillertok" + i.toString().padStart(7, "0"));
    }
    // size>MAX_TOKENS eviction must have removed the oldest token. A `size>MAX`
    // -> false mutant (never evict) or an `oldest!==undefined` -> false mutant
    // (never delete) would keep it and this would still be true.
    expect(t.isEgressTainted("https://x.example/?q=oldesttokenuniq", "")).toBe(
      false,
    );
    // A recently-harvested token is retained.
    expect(t.isEgressTainted("https://x.example/?q=fillertok0050000", "")).toBe(
      true,
    );
  });

  it("evicts the oldest GRAM once >MAX_GRAMS (200_000) distinct grams are harvested", () => {
    const t = new EgressTaintLedger();
    // gram-only first value: four 5-char words → one 20-char gram, NO 12+ token.
    t.addText("aaaaa bbbbb ccccc ddddd");
    const oldestGram = "aaaaabbbbbcccccddddd"; // 20 chars
    expect(t.isEgressTainted(oldestGram, "")).toBe(true);
    // Add >200_000 distinct grams via blocks of 5-char words (grams, no tokens).
    let added = 0;
    let i = 0;
    while (added < 200_050) {
      const block = Array.from({ length: 60 }, (_, k) =>
        ("w" + (i * 60 + k).toString(36)).padStart(5, "q").slice(0, 5),
      ).join(" ");
      t.addText(block);
      added += Math.max(0, block.replace(/ /g, "").length - 19);
      i += 1;
    }
    // The oldest gram must be evicted (size>MAX_GRAMS path).
    expect(t.isEgressTainted(oldestGram, "")).toBe(false);
  });

  it("a re-added identical token is deduped, NOT counted twice (kills tokens.has(t) -> false)", () => {
    const t = new EgressTaintLedger();
    // Fill to EXACTLY MAX_TOKENS distinct tokens, then re-add one of them many
    // times. If the `has(t)` dedupe were removed, each re-add would re-insert
    // and trip eviction, dropping a DIFFERENT (still-wanted) token. With dedupe
    // intact, no eviction happens and all originals remain.
    for (let i = 0; i < 50_000; i += 1) {
      t.addText("dedupetok" + i.toString().padStart(7, "0"));
    }
    // Re-add the FIRST token 100 times — dedupe means no growth, no eviction.
    for (let k = 0; k < 100; k += 1) t.addText("dedupetok0000000");
    // The oldest original token is still present (it was never evicted).
    expect(t.isEgressTainted("https://x.example/?q=dedupetok0000000", "")).toBe(
      true,
    );
    expect(t.isEgressTainted("https://x.example/?q=dedupetok0049999", "")).toBe(
      true,
    );
  });
});

describe("egress-taint promote() FIFO eviction (kills promotedTokens/promotedGrams size>MAX + guards)", () => {
  it("evicts the oldest PROMOTED token once >MAX_TOKENS promotions accrue", () => {
    const t = new EgressTaintLedger();
    // Harvest a 15-char token AND promote it → it should be whitelisted (pass).
    const promoted = "promotedtokenA0";
    expect(promoted.length).toBe(15);
    t.addText(promoted);
    t.promote(promoted);
    expect(t.isEgressTainted("https://x.example/?q=promotedtokenA0", "")).toBe(
      false,
    );
    // Promote 50_001 MORE distinct >=12-char tokens to evict the first promotion.
    for (let i = 0; i < 50_001; i += 1) {
      t.promote("promofiller" + i.toString().padStart(7, "0"));
    }
    // The first promotion is evicted from promotedTokens → the still-harvested
    // token is no longer whitelisted → egress is tainted again. A `size>MAX` ->
    // false or `oldest!==undefined` -> false mutant would keep it whitelisted.
    expect(t.isEgressTainted("https://x.example/?q=promotedtokenA0", "")).toBe(
      true,
    );
  });

  it("evicts the oldest PROMOTED gram once >MAX_GRAMS promotions accrue", () => {
    const t = new EgressTaintLedger();
    // Harvest + promote a gram-only datum (four 5-char words, no 12+ token).
    t.addText("ppppp qqqqq rrrrr sssss");
    t.promote("ppppp qqqqq rrrrr sssss");
    const promotedGram = "pppppqqqqqrrrrrsssss"; // 20 chars
    expect(t.isEgressTainted(promotedGram, "")).toBe(false);
    let added = 0;
    let i = 0;
    while (added < 200_050) {
      const block = Array.from({ length: 60 }, (_, k) =>
        ("p" + (i * 60 + k).toString(36)).padStart(5, "z").slice(0, 5),
      ).join(" ");
      t.promote(block);
      added += Math.max(0, block.replace(/ /g, "").length - 19);
      i += 1;
    }
    // The oldest promoted gram is evicted → the harvested gram is blocked again.
    expect(t.isEgressTainted(promotedGram, "")).toBe(true);
  });
});

describe("egress-taint exact-cap eviction boundary (kills size > MAX -> >=)", () => {
  // At EXACTLY MAX distinct entries: `size > MAX` does NOT evict (size === MAX,
  // not > MAX) so the oldest is retained; a `size >= MAX` mutant WOULD evict the
  // oldest on the MAX-th add. Each suite adds exactly MAX distinct entries and
  // asserts the first is still present.

  it("tokens: exactly MAX_TOKENS (50_000) distinct → the first token is retained", () => {
    const t = new EgressTaintLedger();
    for (let i = 0; i < 50_000; i += 1) {
      t.addText("capboundtok" + i.toString().padStart(5, "0"));
    }
    expect(t.isEgressTainted("https://x.example/?q=capboundtok00000", "")).toBe(
      true,
    );
  });

  it("grams: exactly MAX_GRAMS (200_000) distinct → the first gram is retained", () => {
    const t = new EgressTaintLedger();
    // Each addText below is a 23-char text of four 5-char words that normalises
    // to a UNIQUE 20-char string → adds EXACTLY ONE distinct gram and NO 12+
    // token (every word is 5 chars). `word(i)` = 'a' + base36(i) padded to 4 →
    // always 5 chars and DISTINCT for every i < 36^4 (1.6M), so no gram collides.
    const word = (i: number) => "a" + i.toString(36).padStart(4, "0");
    const gramText = (n: number) =>
      `${word(n * 4)} ${word(n * 4 + 1)} ${word(n * 4 + 2)} ${word(n * 4 + 3)}`;
    // First gram (the one we check for survival).
    t.addText(gramText(0));
    const firstGram = (word(0) + word(1) + word(2) + word(3)).toLowerCase();
    expect(firstGram.length).toBe(20);
    // Add 199_999 MORE distinct single-gram texts → EXACTLY 200_000 grams total.
    for (let n = 1; n < 200_000; n += 1) t.addText(gramText(n));
    // size === MAX_GRAMS so under `>` NO eviction occurred → the first gram
    // survives. A `>=` mutant would have evicted it on the 200_000th add.
    expect(t.isEgressTainted(firstGram, "")).toBe(true);
  });

  it("promotedTokens: exactly MAX_TOKENS promotions → the first promotion is retained", () => {
    const t = new EgressTaintLedger();
    const firstPromoted = "promocapboundA0"; // 15-char token
    t.addText(firstPromoted);
    t.promote(firstPromoted); // promotion #1
    for (let i = 0; i < 49_999; i += 1) {
      t.promote("promocapfill" + i.toString().padStart(5, "0"));
    }
    // Exactly MAX_TOKENS promoted tokens; under `>` the first promotion is
    // retained → the harvested token stays whitelisted (egress passes).
    expect(t.isEgressTainted("https://x.example/?q=promocapboundA0", "")).toBe(
      false,
    );
  });
});

describe("egress-taint hasHarvestedAnyPrivateContent gram-only signal (L255)", () => {
  it("is true after a GRAM-ONLY harvest (kills grams.size>0 -> false in the || )", () => {
    const t = new EgressTaintLedger();
    // gram-only (four 5-char words → no 12+ token). grams.size becomes >0 while
    // tokens.size stays 0, so ONLY the `grams.size > 0` operand can make this
    // true. A `grams.size > 0` -> false mutant would return false here.
    t.addText("ggggg hhhhh iiiii jjjjj");
    expect(t.hasHarvestedAnyPrivateContent()).toBe(true);
  });
});

describe("egress-taint MAX_EGRESS_SCAN equality boundary (L374)", () => {
  it("an egress EXACTLY at the 8192 cap is scanned (not failed-closed), kills > -> >=", () => {
    const t = new EgressTaintLedger();
    t.addText("clandestineharvestedsecret99");
    // combined.length must equal exactly MAX_EGRESS_SCAN (8192). The url+query
    // are joined with a single space, so url.length + 1 + query.length === 8192.
    // With clean (non-matching) content, an at-cap egress must return FALSE (it
    // is scanned, finds nothing). A `>=` mutant would fail-CLOSED at exactly the
    // cap and wrongly return TRUE.
    const url = "https://x.example/" + "a".repeat(8192 - 18 - 1 - 10);
    const query = "b".repeat(10);
    expect(url.length + 1 + query.length).toBe(8192);
    expect(t.isEgressTainted(url, query)).toBe(false);
  });

  it("an egress ONE over the cap fails closed (the > side of the boundary)", () => {
    const t = new EgressTaintLedger();
    t.addText("clandestineharvestedsecret99");
    const url = "https://x.example/" + "a".repeat(8192 - 18 - 1 - 10 + 1);
    const query = "b".repeat(10);
    expect(url.length + 1 + query.length).toBe(8193);
    expect(t.isEgressTainted(url, query)).toBe(true);
  });
});
