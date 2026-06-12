export interface LlmRequest {
  model: string;
  systemPrompt: string;
  userMessage: string;
  maxOutputTokens?: number;
  temperature?: number;
}

export interface LlmResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmTransport {
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export interface AnthropicLlmTransportOptions {
  apiKey: string;
  baseUrl?: string;
}

export class AnthropicLlmTransport implements LlmTransport {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: AnthropicLlmTransportOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? 'https://api.anthropic.com';
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: req.model,
        system: req.systemPrompt,
        messages: [{ role: 'user', content: req.userMessage }],
        max_tokens: req.maxOutputTokens ?? 4096,
        ...(req.temperature === undefined || req.model === 'claude-opus-4-7' ? {} : { temperature: req.temperature }),
      }),
    });

    if (!response.ok) {
      // Privacy boundary: the provider error body can echo request content
      // (the masked prompt / memory text) and enclave stderr is host-
      // observable. Drain the body so the socket can be reused, but log only
      // the status code — never the body. The status is enough to diagnose.
      await response.text().catch(() => undefined);
      console.error(`Anthropic LLM transport error: HTTP ${response.status}`);
      throw new Error(`Anthropic LLM transport error: ${response.status}`);
    }

    const body = await response.json() as {
      content?: Array<{ type?: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = body.content
      ?.filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('') ?? '';

    return {
      text,
      inputTokens: body.usage?.input_tokens ?? 0,
      outputTokens: body.usage?.output_tokens ?? 0,
    };
  }
}

export class RecordedLlmTransport implements LlmTransport {
  private readonly fixtures: LlmResponse[];
  private cursor = 0;
  readonly requests: LlmRequest[] = [];

  constructor(fixtures: LlmResponse[]) {
    this.fixtures = fixtures.map((fixture) => ({ ...fixture }));
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push({ ...req });
    const fixture = this.fixtures[this.cursor];
    if (!fixture) {
      throw new Error('Recorded LLM fixture exhausted');
    }
    this.cursor += 1;
    return { ...fixture };
  }
}
