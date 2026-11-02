/**
 * Minimal client for Geraikita's OpenAI-compatible chat completions endpoint.
 * Runs server-side only; the API key never reaches the browser.
 *
 * Model selection: GERAIKITA_MODEL is tried first. If the endpoint refuses it
 * (403 "model not allowed" / 404), GERAIKITA_FALLBACK_MODEL is used instead
 * and remembered for the rest of the process.
 */

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ChatOptions = {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** Ask the endpoint for a JSON object response. */
  json?: boolean;
};

export class AiHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class GeraikitaClient {
  private activeModel: string;

  constructor(
    private readonly baseUrl = process.env.GERAIKITA_BASE_URL ?? "https://ai.geraikita.com/v1",
    private readonly apiKey = process.env.GERAIKITA_API_KEY ?? "",
    readonly preferredModel = process.env.GERAIKITA_MODEL ?? "gemini-2.5-flash",
    private readonly fallbackModel = process.env.GERAIKITA_FALLBACK_MODEL ?? "gemini-3.8-flash-token",
  ) {
    this.activeModel = preferredModel;
  }

  get model(): string {
    return this.activeModel;
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    if (!this.isConfigured()) throw new Error("GERAIKITA_API_KEY belum diatur di .env.");
    try {
      return await this.requestWithRetry(this.activeModel, messages, opts);
    } catch (err) {
      const refused = err instanceof AiHttpError && (err.status === 403 || err.status === 404);
      if (!refused || this.activeModel === this.fallbackModel || !this.fallbackModel) throw err;
      console.warn(`[ai] model "${this.activeModel}" ditolak endpoint (HTTP ${(err as AiHttpError).status}); beralih ke "${this.fallbackModel}".`);
      this.activeModel = this.fallbackModel;
      return this.requestWithRetry(this.activeModel, messages, opts);
    }
  }

  /** Retry transient failures (network drops, 429, 5xx) with short backoff. */
  private async requestWithRetry(model: string, messages: ChatMessage[], opts: ChatOptions): Promise<string> {
    const delays = [600, 1500];
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.request(model, messages, opts);
      } catch (err) {
        const transient =
          !(err instanceof AiHttpError) || err.status === 429 || err.status >= 500;
        const timedOut = (err as Error).name === "TimeoutError";
        if (!transient || timedOut || attempt >= delays.length) throw err;
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }
  }

  /** Chat and parse a JSON object from the reply. */
  async chatJson<T>(messages: ChatMessage[], opts: ChatOptions = {}): Promise<T> {
    const raw = await this.chat(messages, { ...opts, json: true });
    return parseJsonObject<T>(raw);
  }

  private async request(model: string, messages: ChatMessage[], opts: ChatOptions): Promise<string> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 1024,
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
    });
    if (!res.ok) {
      // Body may echo request details; keep only the status for callers.
      throw new AiHttpError(res.status, `Layanan AI menolak permintaan (HTTP ${res.status}).`);
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }> };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("Layanan AI mengembalikan respons kosong.");
    return content;
  }
}

export function parseJsonObject<T>(raw: string): T {
  const fenced = raw.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  try {
    return JSON.parse(fenced) as T;
  } catch {
    const start = fenced.indexOf("{");
    const end = fenced.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(fenced.slice(start, end + 1)) as T;
    throw new Error("Respons AI bukan JSON yang valid.");
  }
}
