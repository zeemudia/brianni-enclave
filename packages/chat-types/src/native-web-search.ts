export interface NativeWebSearchErrorInput {
  providerId: string;
  error?: unknown;
  status?: number;
  message?: string;
}

interface NativeWebSearchAnnotatedError {
  status?: unknown;
  nativeWebSearchCapabilityRejectionReason?: unknown;
  nativeWebSearchFallbackReason?: unknown;
}

interface NormalisedNativeWebSearchError {
  providerId: string;
  status?: number;
  lowerMessage: string;
}

export function getNativeWebSearchCapabilityRejectionReason(
  input: NativeWebSearchErrorInput,
): string | null {
  const normalised = normaliseNativeWebSearchErrorInput(input);
  const { providerId, lowerMessage, status } = normalised;
  if (!lowerMessage) return null;
  if (!allowsCapabilityRejectionClassification(status, lowerMessage)) return null;

  if (providerId === "openai") {
    const mentionsWebSearch =
      lowerMessage.includes("web_search") ||
      lowerMessage.includes("web search") ||
      lowerMessage.includes("web-search");
    if (mentionsWebSearch) return "web-search-tool-rejected";
    if (
      lowerMessage.includes("unknown parameter") &&
      lowerMessage.includes("tool") &&
      lowerMessage.includes("search")
    ) {
      return "web-search-tool-parameter-rejected";
    }
    return null;
  }

  if (providerId === "anthropic") {
    if (
      lowerMessage.includes("web_search") ||
      (lowerMessage.includes("tool") && lowerMessage.includes("not supported")) ||
      (lowerMessage.includes("organization") && lowerMessage.includes("enable web search"))
    ) {
      return "web-search-tool-rejected";
    }
    return null;
  }

  if (providerId === "google") {
    if (
      lowerMessage.includes("googlesearch") ||
      lowerMessage.includes("google search") ||
      lowerMessage.includes("grounding") ||
      (lowerMessage.includes("tool") && lowerMessage.includes("not supported"))
    ) {
      return "web-search-tool-rejected";
    }
    return null;
  }

  if (lowerMessage.includes("web_search") && lowerMessage.includes("tool")) {
    return "web-search-tool-rejected";
  }
  return null;
}

export function getNativeWebSearchPreOutputFallbackReason(
  input: NativeWebSearchErrorInput,
): string | null {
  const capabilityReason = getNativeWebSearchCapabilityRejectionReason(input);
  if (capabilityReason) return capabilityReason;

  const { status, lowerMessage } = normaliseNativeWebSearchErrorInput(input);
  if (isAuthOrQuotaRejection(status, lowerMessage)) return null;
  if (status !== undefined) {
    if (status >= 500 || status === 408 || status === 425) {
      return "native-search-preoutput-failure";
    }
    if (status >= 400 && status < 500) {
      return "native-search-preoutput-rejected";
    }
    return null;
  }

  if (
    lowerMessage.includes("fetch failed") ||
    lowerMessage.includes("network") ||
    lowerMessage.includes("timeout") ||
    lowerMessage.includes("timed out") ||
    lowerMessage.includes("econnreset") ||
    lowerMessage.includes("econnrefused") ||
    lowerMessage.includes("socket hang up")
  ) {
    return "native-search-preoutput-failure";
  }

  return null;
}

export function annotateNativeWebSearchError<T extends Error>(
  error: T,
  input: NativeWebSearchErrorInput,
): T {
  const status = input.status;
  const capabilityReason = getNativeWebSearchCapabilityRejectionReason(input);
  const fallbackReason = getNativeWebSearchPreOutputFallbackReason(input);
  Object.defineProperties(error, {
    ...(status !== undefined ? { status: { value: status, enumerable: false } } : {}),
    nativeWebSearchCapabilityRejectionReason: {
      value: capabilityReason,
      enumerable: false,
    },
    nativeWebSearchFallbackReason: {
      value: fallbackReason,
      enumerable: false,
    },
  });
  return error;
}

export function getAnnotatedNativeWebSearchFallbackReason(
  providerId: string,
  error: unknown,
): string | null {
  const annotated = error as NativeWebSearchAnnotatedError;
  if (typeof annotated?.nativeWebSearchFallbackReason === "string") {
    return annotated.nativeWebSearchFallbackReason;
  }
  return getNativeWebSearchPreOutputFallbackReason({ providerId, error });
}

export function getAnnotatedNativeWebSearchCapabilityRejectionReason(
  providerId: string,
  error: unknown,
): string | null {
  const annotated = error as NativeWebSearchAnnotatedError;
  if (typeof annotated?.nativeWebSearchCapabilityRejectionReason === "string") {
    return annotated.nativeWebSearchCapabilityRejectionReason;
  }
  return getNativeWebSearchCapabilityRejectionReason({ providerId, error });
}

function normaliseNativeWebSearchErrorInput(
  input: NativeWebSearchErrorInput,
): NormalisedNativeWebSearchError {
  const status = normaliseStatus(input.status ?? statusFromError(input.error));
  const message =
    input.message ??
    messageFromError(input.error) ??
    (status !== undefined ? String(status) : "");
  return {
    providerId: input.providerId,
    status,
    lowerMessage: message.toLowerCase(),
  };
}

function allowsCapabilityRejectionClassification(
  status: number | undefined,
  lowerMessage: string,
): boolean {
  if (isAuthOrQuotaRejection(status, lowerMessage)) return false;
  return status === undefined || (status >= 400 && status < 500);
}

function isAuthOrQuotaRejection(
  status: number | undefined,
  lowerMessage: string,
): boolean {
  return (
    status === 401 ||
    status === 403 ||
    status === 429 ||
    lowerMessage.includes("401") ||
    lowerMessage.includes("403") ||
    lowerMessage.includes("429")
  );
}

function normaliseStatus(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return value;
}

function statusFromError(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = normaliseStatus((error as NativeWebSearchAnnotatedError).status);
  if (status !== undefined) return status;
  const message = messageFromError(error);
  const match = message?.match(/\b([1-5]\d\d)\b/);
  return match ? Number(match[1]) : undefined;
}

function messageFromError(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : undefined;
}
