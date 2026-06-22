import { describe, expect, it } from "vitest";
import {
  annotateNativeWebSearchError,
  getAnnotatedNativeWebSearchCapabilityRejectionReason,
  getAnnotatedNativeWebSearchFallbackReason,
  getNativeWebSearchCapabilityRejectionReason,
  getNativeWebSearchPreOutputFallbackReason,
} from "../native-web-search";

// Mutation-hardening for the native web-search error classifier. Each test
// drives EXACTLY ONE branch keyword / boundary so a Stryker mutant that drops a
// keyword, flips a boundary, or removes a guard is observably killed. The
// classifier is the single source of truth (consumed by web + mobile + enclave)
// for which provider errors mean "this model can't do native web search" vs "a
// transient pre-output failure" vs "auth/quota — do not retry as a capability
// problem". A wrong verdict either falsely disables a working capability or
// silently retries an auth failure.

describe("native-web-search classifier — capability rejection (per-keyword)", () => {
  // OpenAI: each of the three "mentions web search" spellings, in isolation.
  it.each([
    ["web_search", "web_search disabled"],
    ["web search", "web search disabled"],
    ["web-search", "web-search disabled"],
  ])("openai classifies the %s spelling as tool-rejected", (_label, message) => {
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "openai",
        status: 400,
        message,
      }),
    ).toBe("web-search-tool-rejected");
  });

  it("openai requires ALL of unknown-parameter + tool + search for the parameter-rejected verdict", () => {
    // Full trio -> parameter-rejected.
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "openai",
        status: 400,
        message: "unknown parameter tools[0].search",
      }),
    ).toBe("web-search-tool-parameter-rejected");
    // Drop "search" -> falls through to null (kills the `&& includes("search")` operand).
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "openai",
        status: 400,
        message: "unknown parameter tools[0].foo",
      }),
    ).toBeNull();
    // Drop "tool" -> null (kills the `&& includes("tool")` operand).
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "openai",
        status: 400,
        message: "unknown parameter search field",
      }),
    ).toBeNull();
    // Drop "unknown parameter" -> null (kills the first operand).
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "openai",
        status: 400,
        message: "tool search rejected",
      }),
    ).toBeNull();
  });

  it("openai returns null for an unrelated 4xx message (kills the final `return null`)", () => {
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "openai",
        status: 400,
        message: "context length exceeded",
      }),
    ).toBeNull();
  });

  // Anthropic: each of the three disjuncts in isolation.
  it("anthropic classifies bare web_search wording as tool-rejected", () => {
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "anthropic",
        status: 400,
        message: "web_search is unavailable",
      }),
    ).toBe("web-search-tool-rejected");
  });

  it("anthropic requires BOTH tool AND not-supported for that disjunct", () => {
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "anthropic",
        status: 400,
        message: "this tool is not supported",
      }),
    ).toBe("web-search-tool-rejected");
    // "tool" without "not supported" and without web_search -> null.
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "anthropic",
        status: 400,
        message: "this tool is great",
      }),
    ).toBeNull();
    // "not supported" without "tool" -> null.
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "anthropic",
        status: 400,
        message: "this feature is not supported",
      }),
    ).toBeNull();
  });

  it("anthropic requires BOTH organization AND enable-web-search for that disjunct", () => {
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "anthropic",
        status: 400,
        message: "your organization must enable web search first",
      }),
    ).toBe("web-search-tool-rejected");
    // "organization" without "enable web search" -> null.
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "anthropic",
        status: 400,
        message: "your organization is over budget",
      }),
    ).toBeNull();
    // "enable web search" without "organization" -> null (kills the
    // `includes("organization")` operand: a `""` mutant makes it always-true).
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "anthropic",
        status: 400,
        message: "please enable web search in settings",
      }),
    ).toBeNull();
  });

  it("anthropic returns null for unrelated 4xx (kills the final `return null`)", () => {
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "anthropic",
        status: 400,
        message: "invalid request body",
      }),
    ).toBeNull();
  });

  // Google: each of the four disjuncts in isolation.
  it.each([
    ["googlesearch", "GoogleSearch tool unavailable"],
    ["google search", "the google search grounding is off"],
    ["grounding", "grounding not configured"],
  ])("google classifies the %s disjunct as tool-rejected", (_label, message) => {
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "google",
        status: 400,
        message,
      }),
    ).toBe("web-search-tool-rejected");
  });

  it("google requires BOTH tool AND not-supported for its fourth disjunct", () => {
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "google",
        status: 400,
        message: "this tool is not supported here",
      }),
    ).toBe("web-search-tool-rejected");
    // "tool" alone (no grounding/search/not-supported) -> null.
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "google",
        status: 400,
        message: "tool ready",
      }),
    ).toBeNull();
    // "not supported" without "tool" (and no grounding/search) -> null (kills the
    // `includes("tool")` operand, which a `""` mutant makes always-true).
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "google",
        status: 400,
        message: "this feature is not supported",
      }),
    ).toBeNull();
  });

  it("google returns null for unrelated 4xx (kills the final `return null`)", () => {
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "google",
        status: 400,
        message: "deadline exceeded",
      }),
    ).toBeNull();
  });

  // Unknown provider fallback: needs BOTH web_search AND tool.
  it("unknown provider needs BOTH web_search AND tool keywords", () => {
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "mystery",
        status: 400,
        message: "web_search tool blew up",
      }),
    ).toBe("web-search-tool-rejected");
    // web_search without tool -> null.
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "mystery",
        status: 400,
        message: "web_search blew up",
      }),
    ).toBeNull();
    // tool without web_search -> null.
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "mystery",
        status: 400,
        message: "tool blew up",
      }),
    ).toBeNull();
  });
});

describe("native-web-search classifier — classification gate (status window)", () => {
  it("does NOT classify capability rejection outside the 4xx window", () => {
    // status === undefined is allowed (message-only). A 3xx is rejected.
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "openai",
        status: 399,
        message: "web_search tool rejected",
      }),
    ).toBeNull();
    // 500 is a server error, not a capability rejection.
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "openai",
        status: 500,
        message: "web_search tool rejected",
      }),
    ).toBeNull();
    // 400 boundary IS in window.
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "openai",
        status: 400,
        message: "web_search tool rejected",
      }),
    ).toBe("web-search-tool-rejected");
    // 499 boundary IS in window (< 500).
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "openai",
        status: 499,
        message: "web_search tool rejected",
      }),
    ).toBe("web-search-tool-rejected");
  });

  it("classifies a message-only (no-status) capability rejection", () => {
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "openai",
        message: "web_search tool rejected",
      }),
    ).toBe("web-search-tool-rejected");
  });

  it("an empty message is never a capability rejection (kills the `!lowerMessage` guard)", () => {
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "openai",
        status: 400,
        message: "",
      }),
    ).toBeNull();
  });
});

describe("native-web-search classifier — auth/quota suppression (per discriminator)", () => {
  // Each numeric auth/quota code suppresses capability classification.
  it.each([401, 403, 429])(
    "status %i suppresses capability classification",
    (status) => {
      expect(
        getNativeWebSearchCapabilityRejectionReason({
          providerId: "openai",
          status,
          message: "web_search tool rejected",
        }),
      ).toBeNull();
    },
  );

  // Each auth/quota code embedded in the MESSAGE (no status) also suppresses.
  it.each(["401", "403", "429"])(
    "message containing %s suppresses capability classification",
    (code) => {
      expect(
        getNativeWebSearchCapabilityRejectionReason({
          providerId: "openai",
          message: `web_search tool rejected (${code})`,
        }),
      ).toBeNull();
    },
  );

  it.each([401, 403, 429])(
    "status %i suppresses pre-output fallback (returns null, not a failure)",
    (status) => {
      expect(
        getNativeWebSearchPreOutputFallbackReason({
          providerId: "openai",
          status,
          message: "forbidden",
        }),
      ).toBeNull();
    },
  );
});

describe("native-web-search classifier — pre-output fallback (status boundaries)", () => {
  // 5xx / 408 / 425 -> failure (transient). Each boundary exact.
  it.each([500, 599, 408, 425])(
    "status %i is a pre-output FAILURE",
    (status) => {
      expect(
        getNativeWebSearchPreOutputFallbackReason({
          providerId: "openai",
          status,
          message: "transient",
        }),
      ).toBe("native-search-preoutput-failure");
    },
  );

  // Other 4xx -> rejected. Boundaries 400 and 499 exact.
  it.each([400, 499, 404])(
    "status %i is a pre-output REJECTION",
    (status) => {
      expect(
        getNativeWebSearchPreOutputFallbackReason({
          providerId: "openai",
          status,
          message: "client error",
        }),
      ).toBe("native-search-preoutput-rejected");
    },
  );

  it("a 3xx status is neither a failure nor a rejection (kills both boundary guards)", () => {
    expect(
      getNativeWebSearchPreOutputFallbackReason({
        providerId: "openai",
        status: 302,
        message: "redirect",
      }),
    ).toBeNull();
    // 407 is below 408 but in 4xx -> rejected (proves 408 !== boundary swallows it).
    expect(
      getNativeWebSearchPreOutputFallbackReason({
        providerId: "openai",
        status: 407,
        message: "proxy auth",
      }),
    ).toBe("native-search-preoutput-rejected");
  });

  it("when status is set, the network-wording branch is NOT consulted", () => {
    // A 3xx status with network wording in the message stays null because the
    // `if (status !== undefined) { ...; return null }` returns before the
    // network-wording block (kills mutants that drop the early status return).
    expect(
      getNativeWebSearchPreOutputFallbackReason({
        providerId: "openai",
        status: 302,
        message: "fetch failed network timeout",
      }),
    ).toBeNull();
  });

  it("a capability rejection short-circuits the fallback reason", () => {
    // Even at a 4xx that would otherwise be "rejected", a capability match wins.
    expect(
      getNativeWebSearchPreOutputFallbackReason({
        providerId: "openai",
        status: 400,
        message: "web_search tool not supported",
      }),
    ).toBe("web-search-tool-rejected");
  });
});

describe("native-web-search classifier — network wording (per keyword, no status)", () => {
  it.each([
    "fetch failed",
    "network",
    "timeout",
    "timed out",
    "econnreset",
    "econnrefused",
    "socket hang up",
  ])("the %s wording is a pre-output FAILURE", (wording) => {
    expect(
      getNativeWebSearchPreOutputFallbackReason({
        providerId: "openai",
        message: `request error: ${wording}`,
      }),
    ).toBe("native-search-preoutput-failure");
  });

  it("an unrelated no-status message is null (kills the final `return null`)", () => {
    expect(
      getNativeWebSearchPreOutputFallbackReason({
        providerId: "openai",
        message: "everything is fine",
      }),
    ).toBeNull();
  });
});

describe("native-web-search classifier — status/message extraction helpers", () => {
  it("ignores a non-integer status (kills the Number.isInteger guard)", () => {
    // 400.5 is dropped, so with a plain message the classifier sees no status
    // and an unrelated message -> null (a `>= 400` over 400.5 would say rejected).
    expect(
      getNativeWebSearchPreOutputFallbackReason({
        providerId: "openai",
        status: 400.5,
        message: "plain text only",
      }),
    ).toBeNull();
  });

  it("pulls a status from an Error object's own `status` field", () => {
    expect(
      getNativeWebSearchPreOutputFallbackReason({
        providerId: "openai",
        error: Object.assign(new Error("upstream blew up"), { status: 503 }),
      }),
    ).toBe("native-search-preoutput-failure");
  });

  it("pulls a 3-digit status code out of an Error message when no status field exists", () => {
    expect(
      getNativeWebSearchPreOutputFallbackReason({
        providerId: "openai",
        error: new Error("upstream returned 500 before output"),
      }),
    ).toBe("native-search-preoutput-failure");
    // A non-1xx-5xx code is NOT matched as a status (regex is [1-5]\d\d).
    expect(
      getNativeWebSearchPreOutputFallbackReason({
        providerId: "openai",
        error: new Error("error code 700 occurred"),
      }),
    ).toBeNull();
  });

  it("ignores a non-Error, non-string error value (kills messageFromError branch)", () => {
    expect(
      getNativeWebSearchPreOutputFallbackReason({
        providerId: "openai",
        error: { weird: true },
      }),
    ).toBeNull();
  });

  it("does NOT mine a status code out of a non-object (string) error (kills the statusFromError object guard)", () => {
    // statusFromError must early-return undefined for a non-object error. If the
    // `typeof error !== "object"` guard were dropped, the regex would mine 503
    // out of the string and wrongly flip this to a transient failure.
    expect(
      getNativeWebSearchPreOutputFallbackReason({
        providerId: "openai",
        error: "returned 503",
      }),
    ).toBeNull();
  });

  it("treats a bare string error as the message", () => {
    expect(
      getNativeWebSearchPreOutputFallbackReason({
        providerId: "openai",
        error: "socket hang up",
      }),
    ).toBe("native-search-preoutput-failure");
  });
});

describe("native-web-search classifier — annotation round-trip", () => {
  it("annotates non-enumerable status + reasons and reads them back", () => {
    const error = annotateNativeWebSearchError(
      new Error("web_search tool not supported"),
      {
        providerId: "openai",
        status: 404,
        message: "web_search tool not supported",
      },
    );
    // status is set but NON-enumerable (kills the ObjectLiteral/enumerable mutants).
    expect(Object.prototype.hasOwnProperty.call(error, "status")).toBe(true);
    expect(Object.keys(error)).not.toContain("status");
    expect(Object.keys(error)).not.toContain(
      "nativeWebSearchCapabilityRejectionReason",
    );
    expect(Object.keys(error)).not.toContain("nativeWebSearchFallbackReason");
    // The DESCRIPTOR VALUES are stored directly (kills the `{}` ObjectLiteral
    // mutants that would leave each property defined-but-undefined).
    const annotated = error as unknown as {
      status?: unknown;
      nativeWebSearchCapabilityRejectionReason?: unknown;
      nativeWebSearchFallbackReason?: unknown;
    };
    expect(annotated.status).toBe(404);
    expect(annotated.nativeWebSearchCapabilityRejectionReason).toBe(
      "web-search-tool-rejected",
    );
    expect(annotated.nativeWebSearchFallbackReason).toBe(
      "web-search-tool-rejected",
    );
    // The annotated reasons are readable.
    expect(
      getAnnotatedNativeWebSearchCapabilityRejectionReason("openai", error),
    ).toBe("web-search-tool-rejected");
    expect(getAnnotatedNativeWebSearchFallbackReason("openai", error)).toBe(
      "web-search-tool-rejected",
    );
  });

  it("omits the status property entirely when no status is supplied", () => {
    const error = annotateNativeWebSearchError(new Error("network down"), {
      providerId: "openai",
      message: "network",
    });
    expect(Object.prototype.hasOwnProperty.call(error, "status")).toBe(false);
    expect(getAnnotatedNativeWebSearchFallbackReason("openai", error)).toBe(
      "native-search-preoutput-failure",
    );
  });

  it("reads a pre-annotated string reason without re-deriving it", () => {
    // A pre-set string short-circuits (kills the `typeof === 'string'` guard and
    // the OptionalChaining on the annotated read).
    const annotated = {
      nativeWebSearchFallbackReason: "native-search-preoutput-failure",
      nativeWebSearchCapabilityRejectionReason: "web-search-tool-rejected",
    };
    expect(getAnnotatedNativeWebSearchFallbackReason("openai", annotated)).toBe(
      "native-search-preoutput-failure",
    );
    expect(
      getAnnotatedNativeWebSearchCapabilityRejectionReason("openai", annotated),
    ).toBe("web-search-tool-rejected");
  });

  it("re-derives the reason when the annotated field is absent or non-string", () => {
    // Non-string annotated field -> fall through to fresh derivation.
    const notAnnotated = { nativeWebSearchFallbackReason: 42 };
    expect(
      getAnnotatedNativeWebSearchFallbackReason("openai", notAnnotated),
    ).toBeNull();
    // A null/undefined error still derives (proves the optional-chaining guard).
    expect(getAnnotatedNativeWebSearchFallbackReason("openai", null)).toBeNull();
  });

  it("re-derives the CAPABILITY reason from a plain Error when not annotated (kills the `{ providerId, error }` ObjectLiteral)", () => {
    // No annotated field present, but the Error message names the rejected tool —
    // the fallback path must rebuild { providerId, error } and re-derive. A `{}`
    // mutant on that object would drop the provider+error and return null.
    const plainErr = new Error("web_search tool not supported");
    expect(
      getAnnotatedNativeWebSearchCapabilityRejectionReason("openai", plainErr),
    ).toBe("web-search-tool-rejected");
  });

  it("does not throw when the CAPABILITY reader is given a null error (kills the `annotated?.` optional chaining)", () => {
    // Without optional chaining, `null.nativeWebSearchCapabilityRejectionReason`
    // would throw. The reader must tolerate null and re-derive (here: null).
    expect(
      getAnnotatedNativeWebSearchCapabilityRejectionReason("openai", null),
    ).toBeNull();
  });
});

describe("native-web-search classifier — status-derived fallback message (no body)", () => {
  // When the provider gives ONLY a numeric status (no message, no error body),
  // the classifier derives its working message from String(status). That derived
  // text is then run through the SAME auth/quota suppression
  // (isAuthOrQuotaRejection's `lowerMessage.includes("401"|"403"|"429")` arm), so
  // a non-standard multi-digit status that embeds an auth/quota code is still
  // suppressed as auth/quota rather than misreported as a transient 5xx failure.
  // This pins the `status !== undefined ? String(status) : ""` fallback: dropping
  // it to a constant "" (the `=> false` / `=> status === undefined` mutants) would
  // erase the derived message, skip the auth-substring suppression, and — because
  // e.g. 1429 >= 500 — wrongly flip the verdict to a pre-output FAILURE.
  it.each([1401, 1403, 1429])(
    "a body-less status %i that embeds an auth/quota code is suppressed (not a transient failure)",
    (status) => {
      expect(
        getNativeWebSearchPreOutputFallbackReason({ providerId: "openai", status }),
      ).toBeNull();
    },
  );

  it("a body-less standard 5xx status is still a pre-output failure (no auth substring)", () => {
    // Contrast case: 500 has no 401/403/429 substring, so the derived "500"
    // message is NOT auth-suppressed and the 5xx rule reports a failure. This
    // keeps the suppression specific to the embedded-auth-code path above.
    expect(
      getNativeWebSearchPreOutputFallbackReason({ providerId: "openai", status: 500 }),
    ).toBe("native-search-preoutput-failure");
  });
});
