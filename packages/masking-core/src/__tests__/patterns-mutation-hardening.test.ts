/**
 * Mutation-hardening suite for patterns.ts — the sole on-device PII
 * de-identification surface (architecture invariant). Each test is written to
 * fail for a specific surviving Stryker mutant: the regex separator/boundary
 * mutants, the Luhn/SSN validators, the NAME suppression rules (roles, places,
 * organisations), the contextual capture-group offsets, and the overlap /
 * sort / keep-highest-confidence dedup. Assertions pin exact spans and texts
 * (not just `.some(...)`) so a weakened pattern is observable.
 */
import { describe, it, expect } from "vitest";
import { detectPII } from "../patterns";

const has = (text: string, type: string) =>
  detectPII(text).some((e) => e.type === type);
const find = (text: string, type: string) =>
  detectPII(text).filter((e) => e.type === type);

describe("EMAIL pattern boundaries", () => {
  it("captures the exact email span", () => {
    const entities = detectPII("write to jane.doe+tag@sub.example.co.uk now");
    expect(entities).toContainEqual(
      expect.objectContaining({
        type: "EMAIL",
        text: "jane.doe+tag@sub.example.co.uk",
      }),
    );
  });
});

describe("UK phone separator boundaries", () => {
  it("detects a +44 number with NO space after the country code", () => {
    // Kills `\+44\s?` -> `\+44\s` (mandatory space after +44).
    const entities = detectPII("ring +447700900123 today");
    expect(entities).toContainEqual(
      expect.objectContaining({ type: "PHONE", text: "+447700900123" }),
    );
  });

  it("detects a +44 number WITH a space after the country code", () => {
    expect(detectPII("ring +44 7700900123 today")).toContainEqual(
      expect.objectContaining({ type: "PHONE", text: "+44 7700900123" }),
    );
  });

  it("detects a leading-zero UK number", () => {
    expect(detectPII("ring 07700 900123 today")).toContainEqual(
      expect.objectContaining({ type: "PHONE" }),
    );
  });
});

describe("US phone separator boundaries", () => {
  it("detects a bare 10-digit number with no separators", () => {
    // Kills `[-.\s]?` -> `[-.\s]` (separators made mandatory).
    expect(detectPII("call 5551234567 please")).toContainEqual(
      expect.objectContaining({ type: "PHONE", text: "5551234567" }),
    );
  });

  it("detects a space-separated US number (the separator must allow whitespace)", () => {
    // Kills `[-.\s]` -> `[-.\S]` (would forbid a space separator).
    expect(detectPII("call 555 123 4567 please")).toContainEqual(
      expect.objectContaining({ type: "PHONE", text: "555 123 4567" }),
    );
  });

  it("detects a dot-separated US number with all four trailing digits", () => {
    // Kills `\d{4}` -> `\d` (would truncate the subscriber number).
    expect(detectPII("call 555.123.4567 please")).toContainEqual(
      expect.objectContaining({ type: "PHONE", text: "555.123.4567" }),
    );
  });
});

describe("UK postcode boundaries", () => {
  it("detects an outcode with a trailing letter (SW1A 1AA)", () => {
    // Kills `\d` -> `\D` (first digit) and `[A-Z\d]?` -> `[^A-Z\d]?` (3rd char).
    expect(detectPII("I live at SW1A 1AA today")).toContainEqual(
      expect.objectContaining({ type: "ADDR", text: "SW1A 1AA" }),
    );
  });

  it("detects an outcode with a trailing digit (B33 8TH)", () => {
    // Kills `[A-Z\d]` -> `[A-Z\D]` (would forbid a digit in the 3rd position).
    expect(detectPII("I live at B33 8TH now")).toContainEqual(
      expect.objectContaining({ type: "ADDR", text: "B33 8TH" }),
    );
  });

  it("detects a postcode with NO space between outcode and incode (EC1A1BB)", () => {
    // Kills `\s?` -> `\s` (mandatory space).
    expect(detectPII("office at EC1A1BB here")).toContainEqual(
      expect.objectContaining({ type: "ADDR", text: "EC1A1BB" }),
    );
  });

  it("detects a short outcode postcode (M1 1AE)", () => {
    expect(detectPII("near M1 1AE station")).toContainEqual(
      expect.objectContaining({ type: "ADDR", text: "M1 1AE" }),
    );
  });
});

describe("US ZIP boundaries", () => {
  it("detects a bare 5-digit ZIP exactly", () => {
    expect(detectPII("ZIP 90210 here")).toContainEqual(
      expect.objectContaining({ type: "ADDR", text: "90210" }),
    );
  });

  it("detects a ZIP+4 including all four extension digits", () => {
    // Kills `-\d{4}` -> `-\D{4}` and `-\d{4}` -> `-\d` in the ZIP+4 group.
    // Uses an invalid-SSN area (000) so the SSN pattern does not claim the span.
    expect(detectPII("ZIP 00000-1234 here")).toContainEqual(
      expect.objectContaining({ type: "ADDR", text: "00000-1234" }),
    );
  });
});

describe("UK National Insurance separator boundaries", () => {
  it("detects an NI number with NO spaces (AB123456C)", () => {
    // Kills all four `\s?` -> `\s` mutants in the NI pattern at once.
    expect(detectPII("NI number AB123456C on file")).toContainEqual(
      expect.objectContaining({ type: "ID", text: "AB123456C" }),
    );
  });

  it("detects an NI number with spaces (AB 12 34 56 C)", () => {
    expect(detectPII("NI number AB 12 34 56 C on file")).toContainEqual(
      expect.objectContaining({ type: "ID", text: "AB 12 34 56 C" }),
    );
  });
});

describe("US SSN separator boundaries", () => {
  it("detects an SSN with NO separators (123456789)", () => {
    // Kills `[-\s]?` -> `[-\s]` (separators made mandatory).
    expect(detectPII("SSN 123456789 filed")).toContainEqual(
      expect.objectContaining({ type: "ID", text: "123456789" }),
    );
  });

  it("detects an SSN with SPACE separators (123 45 6789)", () => {
    // Kills `[-\s]` -> `[-\S]` (would forbid a space separator).
    expect(detectPII("SSN 123 45 6789 filed")).toContainEqual(
      expect.objectContaining({ type: "ID", text: "123 45 6789" }),
    );
  });
});

describe("Credit card (ACCT) Luhn + separator boundaries", () => {
  it("detects a Luhn-valid card whose doubled digits exceed 9", () => {
    // Kills `d -= 9` -> `d += 9`: 5555-series doubles 5 -> 10 (>9), so the
    // subtract-9 step is load-bearing. (4111... never exercises it.)
    expect(detectPII("Card 5555 5555 5555 4444 charged")).toContainEqual(
      expect.objectContaining({ type: "ACCT", text: "5555 5555 5555 4444" }),
    );
  });

  it("detects a Luhn-valid card with NO separators", () => {
    // Kills `[-\s]?` -> `[-\s]` (separators made mandatory) in the card pattern.
    expect(detectPII("Card 5555555555554444 charged")).toContainEqual(
      expect.objectContaining({ type: "ACCT", text: "5555555555554444" }),
    );
  });

  it("does NOT flag a 16-digit group that fails Luhn", () => {
    expect(has("Ref 4111 1111 1111 1112 logged", "ACCT")).toBe(false);
  });
});

describe("SSN structural validation is enforced through detection", () => {
  it("detects a structurally valid SSN", () => {
    expect(detectPII("SSN 123-45-6789 filed")).toContainEqual(
      expect.objectContaining({ type: "ID", text: "123-45-6789" }),
    );
  });

  it.each([
    ["000-45-6789", "area 000"],
    ["666-45-6789", "area 666"],
    ["900-45-6789", "area >= 900"],
    ["123-00-6789", "group 00"],
    ["123-45-0000", "serial 0000"],
  ])("suppresses an SSN with %s (%s)", (ssn) => {
    expect(has(`SSN is ${ssn} ok`, "ID")).toBe(false);
  });
});

describe("Contextual capture-group offset + endIndex arithmetic", () => {
  it("computes a GitHub handle's endIndex as startIndex + handle length", () => {
    // Kills `startIndex + captured.length` -> `startIndex - captured.length`.
    const handles = find("see github.com/octocat/repo", "HANDLE");
    expect(handles).toHaveLength(1);
    const h = handles[0];
    expect(h.text).toBe("octocat");
    expect(h.endIndex).toBe(h.startIndex + h.text.length);
    expect(h.startIndex).toBeGreaterThan(0);
  });

  it("detects a bare-host handle with no scheme and no www", () => {
    // Bare `github.com/<user>` (the leading scheme/www groups are optional).
    expect(detectPII("profile github.com/octocat")).toContainEqual(
      expect.objectContaining({ type: "HANDLE", text: "octocat" }),
    );
  });

  it("detects handles across all supported hosts", () => {
    const text =
      "gitlab.com/alice bitbucket.org/bob-team x.com/carol_x linkedin.com/in/dan-e";
    for (const handle of ["alice", "bob-team", "carol_x", "dan-e"]) {
      expect(detectPII(text)).toContainEqual(
        expect.objectContaining({ type: "HANDLE", text: handle }),
      );
    }
  });

  it("detects a single-character GitHub handle", () => {
    // Kills the inner `(?:...[A-Za-z0-9])?` -> mandatory tail: a 1-char handle
    // must still be captured (the tail group is optional).
    expect(detectPII("profile github.com/a here")).toContainEqual(
      expect.objectContaining({ type: "HANDLE", text: "a" }),
    );
  });

  it("detects a single-character LinkedIn handle", () => {
    expect(detectPII("profile linkedin.com/in/a here")).toContainEqual(
      expect.objectContaining({ type: "HANDLE", text: "a" }),
    );
  });

  it("captures the exact LinkedIn handle when followed by a space", () => {
    // Kills the lookahead `[\s"'<>)]` -> `[\S...]` / `[^\s...]` mutants: a
    // trailing space must terminate the handle without truncating it.
    const handles = find("see linkedin.com/in/dan-e here", "HANDLE");
    expect(handles).toContainEqual(
      expect.objectContaining({ type: "HANDLE", text: "dan-e" }),
    );
  });
});

describe("Unix / Windows user-path boundaries", () => {
  it("detects a /Users path preceded by whitespace", () => {
    // Kills `[^\w/]` -> `[^\W/]` / `[\w/]` in the leading boundary group. The
    // path is followed by another `/` so the `(?=\/|$)` lookahead is satisfied.
    const paths = find("open /Users/jane/notes here", "PATH");
    expect(paths).toContainEqual(
      expect.objectContaining({ type: "PATH", text: "/Users/jane" }),
    );
  });

  it("detects a /home path at the very end of the string", () => {
    // Kills `(?=\/|$)` -> `(?=\/)` (drops the end-of-string alternative).
    expect(detectPII("logged in as /home/bob")).toContainEqual(
      expect.objectContaining({ type: "PATH", text: "/home/bob" }),
    );
  });

  it("detects a Windows user path at the START of the string", () => {
    // Kills `(^|[^\w/])` -> `([^\w/])` (drops the start-of-string alternative).
    // Followed by `\notes` so the `(?=\\|$)` lookahead is satisfied.
    expect(detectPII(String.raw`C:\Users\jane\notes opened`)).toContainEqual(
      expect.objectContaining({ type: "PATH", text: String.raw`C:\Users\jane` }),
    );
  });

  it("detects a Windows user path at the END of the string", () => {
    // Kills `(?=\\|$)` -> `(?=\\)` (drops the end-of-string alternative).
    expect(detectPII(String.raw`saved to C:\Users\bob`)).toContainEqual(
      expect.objectContaining({ type: "PATH", text: String.raw`C:\Users\bob` }),
    );
  });
});

describe("NAME accented + affixed forms still match", () => {
  it("detects an accented two-part name", () => {
    expect(detectPII("email José Martínez about it")).toContainEqual(
      expect.objectContaining({ type: "NAME", text: "José Martínez" }),
    );
  });

  it("detects Mc / O' surname affixes", () => {
    expect(has("ask James McDonald now", "NAME")).toBe(true);
    expect(has("ask Sarah O'Brien now", "NAME")).toBe(true);
  });
});

describe("NAME role-word suppression precision", () => {
  it("STILL masks a name that mixes one role word with a real surname", () => {
    // Kills `tokens.every(isRole)` -> `tokens.some(isRole)`: under `.some`,
    // a single role token ("Senior"/"Lead") would wrongly suppress the name.
    expect(detectPII("offer for Senior Okafor today")).toContainEqual(
      expect.objectContaining({ type: "NAME", text: "Senior Okafor" }),
    );
    expect(detectPII("offer for Lead Adeyemi today")).toContainEqual(
      expect.objectContaining({ type: "NAME", text: "Lead Adeyemi" }),
    );
  });

  it("suppresses a phrase that is ENTIRELY role words", () => {
    expect(has("the Senior Product Engineer role", "NAME")).toBe(false);
  });
});

describe("NAME organisation-descriptor suppression precision", () => {
  it("suppresses a phrase with two organisation descriptors and no known org", () => {
    // Kills `descriptorCount >= 2` -> `> 2` / `false`, and `||` -> `&&`.
    expect(has("visit Acme Web Services online", "NAME")).toBe(false);
  });

  it("suppresses a phrase with one descriptor AND a known organisation", () => {
    // Kills `descriptorCount > 0` -> `<= 0` and the known-org branch -> false.
    expect(has("open Amazon Web today", "NAME")).toBe(false);
  });

  it("does NOT suppress two brand words with zero descriptors", () => {
    // Kills `descriptorCount > 0` -> `>= 0` and the known-org branch -> true:
    // with zero descriptors the suppression must not fire.
    expect(has("compare Amazon Apple offerings", "NAME")).toBe(true);
  });

  it("STILL masks a real name carrying a single descriptor word", () => {
    expect(detectPII("my contact is Jane Services here")).toContainEqual(
      expect.objectContaining({ type: "NAME", text: "Jane Services" }),
    );
  });
});

describe("NAME leading-word + title-prefix gating", () => {
  it("suppresses a place that starts with a leading non-name word", () => {
    for (const phrase of ["Los Angeles", "New York", "The Hague"]) {
      expect(has(`went to ${phrase} once`, "NAME"), phrase).toBe(false);
    }
  });

  it("does NOT treat a longer word that merely starts like a title as a prefix", () => {
    // Kills TITLE_PREFIX_RE `\.?$` -> `\.?` (dropping the end anchor): without
    // `$`, "Professor" would match the "Prof" prefix and spuriously set
    // hasTitlePrefix, disabling the leading-word suppression of "New".
    expect(has("the New Professor arrived", "NAME")).toBe(false);
  });

  it("masks a genuinely titled name", () => {
    expect(detectPII("call Dr. Osazee Edigin")).toContainEqual(
      expect.objectContaining({ type: "NAME", text: "Dr. Osazee Edigin" }),
    );
  });

  it("normalises internal whitespace when matching curated non-name phrases", () => {
    // Kills the `replace(/[ \t]+/g, " ")` -> `/[ \t]/g` mutant: a double-spaced
    // "San  Francisco" must still collapse to the curated key and be suppressed.
    expect(has("weather in San  Francisco today", "NAME")).toBe(false);
  });
});

describe("+44 phone suppression boundary (preceding character)", () => {
  it("detects a standalone +44 number at the start of the text", () => {
    // Kills the suppression `previous !== undefined && test(previous)` -> true:
    // a +44 number with no preceding char must NOT be suppressed.
    expect(detectPII("+44 7700 900123 is my mobile")).toContainEqual(
      expect.objectContaining({ type: "PHONE", text: "+44 7700 900123" }),
    );
  });

  it("suppresses a +44 number glued to a preceding alphanumeric token", () => {
    expect(has("ref9+44 7700 900123 here", "PHONE")).toBe(false);
  });

  it("does NOT bypass ACCT Luhn suppression (the phone branch must be phone-only)", () => {
    // Kills `if (type === "PHONE" && ...)` -> `if (true)`: that would route a
    // failing-Luhn card through the phone branch and skip the ACCT rejection.
    expect(has("ref 4111 1111 1111 1112 here", "ACCT")).toBe(false);
  });
});

describe("entity ordering, overlap and keep-highest-confidence dedup", () => {
  it("returns entities sorted by ascending startIndex regardless of detection order", () => {
    // Kills the sort comparator mutants (`a - b` -> `a + b`, arrow -> undefined,
    // and dropping `.sort`). EMAIL is detected before PHONE by pattern order,
    // but the phone appears earlier in the text, so a real sort must reorder.
    const entities = detectPII("dial 07700 900123 or mail amy@ex.com");
    const starts = entities.map((e) => e.startIndex);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(entities[0].type).toBe("PHONE");
  });

  it("keeps two well-separated entities (no false overlap merge)", () => {
    // Kills overlap-condition mutants that force unrelated entities to merge.
    const entities = detectPII("mail amy@ex.com and open /Users/jane");
    expect(entities.some((e) => e.type === "EMAIL")).toBe(true);
    expect(entities.some((e) => e.type === "PATH")).toBe(true);
    expect(entities).toHaveLength(2);
  });

  it("replaces a lower-confidence overlap with a higher-confidence one", () => {
    // Kills the keep-highest-confidence replace branch (block -> {} and
    // condition -> false): NAME (0.7) "John Smith" is added first, then the
    // overlapping EMAIL (0.99) "Smith@ex.com" must replace it.
    const entities = detectPII("John Smith@ex.com");
    expect(entities).toContainEqual(
      expect.objectContaining({ type: "EMAIL", text: "Smith@ex.com" }),
    );
    expect(entities.some((e) => e.type === "NAME")).toBe(false);
  });
});

describe("NAME whitespace robustness (inter-token and post-title)", () => {
  it("masks a name with TWO spaces between forename and surname", () => {
    // Kills the inter-token separator `[ \t]+` -> `[ \t]` (single space): the
    // double space must not break the multi-token name match.
    expect(detectPII("email John  Smith now")).toContainEqual(
      expect.objectContaining({ type: "NAME", text: "John  Smith" }),
    );
  });

  it("masks a titled name with TWO spaces after the honorific", () => {
    // Kills the post-title separator `\.?[ \t]+` -> `\.?[ \t]` (single space).
    expect(detectPII("call Dr.  Jane Smith today")).toContainEqual(
      expect.objectContaining({ type: "NAME", text: "Dr.  Jane Smith" }),
    );
  });
});

describe("NAME title-prefix gate must not OVER-suppress (privacy: avoid name leaks)", () => {
  it("STILL masks a titled name whose first token is a leading place-word", () => {
    // "New Dr Smith" carries a title prefix ("Dr"), so the leading-non-name-word
    // suppression that would fire on "New" MUST be skipped — otherwise a real
    // name leaks unmasked. Kills the hasTitlePrefix mutants together:
    //   `.some(...)` -> `.every(...)`, the callback arrow -> `() => undefined`,
    //   `!hasTitlePrefix` -> `true`, and `!hasTitlePrefix && ...` -> `|| ...`.
    expect(detectPII("went to New Dr Smith once")).toContainEqual(
      expect.objectContaining({ type: "NAME", text: "New Dr Smith" }),
    );
  });
});
