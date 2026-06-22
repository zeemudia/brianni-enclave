import { describe, expect, it } from "vitest";
import {
  annotateNativeWebSearchError,
  getAnnotatedNativeWebSearchCapabilityRejectionReason,
  getAnnotatedNativeWebSearchFallbackReason,
  getNativeWebSearchCapabilityRejectionReason,
  getNativeWebSearchPreOutputFallbackReason,
  ModelCapabilitySchema,
  type ChatChunk,
  type ChatPayload,
  type ChatProcessor,
} from "../index";

describe("native web search chat contracts", () => {
  it("allows main chat payloads to request automatic native search", () => {
    const payload: ChatPayload = {
      model: "gpt-5.5",
      messages: [{ role: "user", content: "latest FCA consultation?" }],
      stream: true,
      nativeWebSearch: "auto",
    };

    expect(payload.nativeWebSearch).toBe("auto");
  });

  it("allows chat chunks to carry normalized citations", () => {
    const chunk: ChatChunk = {
      id: "chunk_1",
      choices: [{ delta: {}, finish_reason: "stop" }],
      citations: [
        {
          url: "https://example.com/source",
          title: "Source",
          startIndex: 0,
          endIndex: 6,
          anchorTextHash: "abc",
          anchorTextLength: 6,
          provider: "openai",
        },
      ],
    };

    expect(chunk.citations?.[0]?.provider).toBe("openai");
  });

  it("exposes signed native-search capability metadata", () => {
    const parsed = ModelCapabilitySchema.parse({
      modelId: "claude-opus-4-7",
      providerId: "anthropic",
      strengths: ["general_reasoning", "research", "search_grounded"],
      modalities: ["text_in", "text_out"],
      endpointFamily: "chat",
      costTier: "high",
      latencyTier: "standard",
      nativeWebSearch: {
        providerTool: "anthropic_web_search",
        toolVersion: "web_search_20260209",
      },
    });

    expect(parsed.nativeWebSearch).toEqual({
      providerTool: "anthropic_web_search",
      toolVersion: "web_search_20260209",
    });
  });

  it("keeps native search optional on ChatProcessor options", () => {
    const processor: ChatProcessor = {
      async *streamChat(_messages, options) {
        expect(options.nativeWebSearch).toBe("off");
        yield {
          id: "ok",
          choices: [{ delta: { content: "done" }, finish_reason: null }],
        };
      },
    };

    expect(
      processor.streamChat([{ role: "user", content: "hi" }], {
        model: "gpt-5.5",
        nativeWebSearch: "off",
      }),
    ).toBeDefined();
  });

  it("classifies native-search capability errors without treating 5xx as capability rejection", () => {
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "openai",
        status: 400,
        message: "web_search tool not supported for this model",
      }),
    ).toBe("web-search-tool-rejected");
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "openai",
        status: 500,
        message: "web_search tool crashed upstream",
      }),
    ).toBeNull();
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "anthropic",
        status: 400,
        message: "web_search tool not supported for this model",
      }),
    ).toBe("web-search-tool-rejected");
  });

  it("allows pre-output fallback for non-auth native-search failures without hiding auth or quota failures", () => {
    expect(
      getNativeWebSearchPreOutputFallbackReason({
        providerId: "openai",
        status: 503,
        message: "service unavailable",
      }),
    ).toBe("native-search-preoutput-failure");
    expect(
      getNativeWebSearchPreOutputFallbackReason({
        providerId: "openai",
        status: 400,
        message: "Unknown parameter: 'max_output_tokens'",
      }),
    ).toBe("native-search-preoutput-rejected");
    expect(
      getNativeWebSearchPreOutputFallbackReason({
        providerId: "anthropic",
        status: 403,
      message: "forbidden",
    }),
    ).toBeNull();
  });

  it("classifies provider-specific capability rejection wording", () => {
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "openai",
        status: 400,
        message: "Unknown parameter: tools[0].search",
      }),
    ).toBe("web-search-tool-parameter-rejected");
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "anthropic",
        status: 400,
        message: "Organization must enable web search before this tool can run",
      }),
    ).toBe("web-search-tool-rejected");
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "google",
        status: 400,
        message: "GoogleSearch grounding tool is not supported",
      }),
    ).toBe("web-search-tool-rejected");
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "unknown-provider",
        status: 400,
        message: "web_search tool rejected",
      }),
    ).toBe("web-search-tool-rejected");
  });

  it("does not classify empty, unrelated, auth, or quota errors as web-search capability failures", () => {
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "openai",
        status: 400,
        message: "",
      }),
    ).toBeNull();
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "google",
        status: 400,
        message: "safety settings rejected the prompt",
      }),
    ).toBeNull();
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "openai",
        status: 401,
        message: "web_search tool unauthorized",
      }),
    ).toBeNull();
    expect(
      getNativeWebSearchCapabilityRejectionReason({
        providerId: "anthropic",
        message: "429 web_search quota exceeded",
      }),
    ).toBeNull();
  });

  it("derives fallback reasons from status codes embedded in Error messages and network wording", () => {
    expect(
      getNativeWebSearchPreOutputFallbackReason({
        providerId: "google",
        error: new Error("upstream returned 425 before output"),
      }),
    ).toBe("native-search-preoutput-failure");
    expect(
      getNativeWebSearchPreOutputFallbackReason({
        providerId: "openai",
        error: new Error("502 fetch failed: socket hang up"),
      }),
    ).toBe("native-search-preoutput-failure");
    expect(
      getNativeWebSearchPreOutputFallbackReason({
        providerId: "anthropic",
        error: "network timeout",
      }),
    ).toBe("native-search-preoutput-failure");
    expect(
      getNativeWebSearchPreOutputFallbackReason({
        providerId: "openai",
        status: 302,
        message: "temporary redirect",
      }),
    ).toBeNull();
  });

  it("annotates errors with non-enumerable capability and fallback metadata", () => {
    const error = annotateNativeWebSearchError(new Error("web_search tool not supported"), {
      providerId: "openai",
      status: 400,
      message: "web_search tool not supported",
    });

    expect(getAnnotatedNativeWebSearchCapabilityRejectionReason("openai", error)).toBe(
      "web-search-tool-rejected",
    );
    expect(getAnnotatedNativeWebSearchFallbackReason("openai", error)).toBe(
      "web-search-tool-rejected",
    );
    expect(Object.keys(error)).not.toContain("nativeWebSearchFallbackReason");
    expect(Object.keys(error)).not.toContain("nativeWebSearchCapabilityRejectionReason");
    expect(Object.keys(error)).not.toContain("status");
  });

  it("falls back to classifying unannotated errors through their message and status", () => {
    const error = Object.assign(new Error("503 service unavailable"), { status: 503 });

    expect(getAnnotatedNativeWebSearchFallbackReason("openai", error)).toBe(
      "native-search-preoutput-failure",
    );
    expect(getAnnotatedNativeWebSearchCapabilityRejectionReason("openai", error)).toBeNull();
  });
});
