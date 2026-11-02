/**
 * Thin MCP stdio client for the Turath server.
 *
 * The server is launched as a child process over stdio. No credentials are
 * involved: turath.io's public API is unauthenticated, and the MCP server needs
 * none. If that ever changes, secrets belong here (server-side only) and must
 * never be forwarded to the browser.
 */
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export type McpToolResult = {
  ok: boolean;
  data: unknown;
  /** Raw text payload as returned by the server, kept for audit. */
  rawText: string;
  error?: string;
};

export type McpClientOptions = {
  /** Command that starts the Turath MCP server. */
  command?: string;
  args?: string[];
  /** Per-call timeout. */
  timeoutMs?: number;
};

const DEFAULT_SERVER = "mcp-server/turath-server.ts";

export class TurathMcpClient {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private readonly command: string;
  private readonly args: string[];
  private readonly timeoutMs: number;
  private lastError: string | null = null;

  constructor(opts: McpClientOptions = {}) {
    // Run tsx through the current Node binary: avoids npx/.cmd shims on Windows.
    this.command = opts.command ?? process.env.TURATH_MCP_COMMAND ?? process.execPath;
    this.args = opts.args ?? [
      "--import",
      "tsx",
      process.env.TURATH_MCP_ENTRY ??
        fileURLToPath(new URL("../../" + DEFAULT_SERVER, import.meta.url)),
    ];
    this.timeoutMs = opts.timeoutMs ?? 45_000;
  }

  /** Human-readable description of how the server is launched (no secrets). */
  describe(): string {
    return `${this.command} ${this.args.join(" ")}`;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const transport = new StdioClientTransport({
        command: this.command,
        args: this.args,
        stderr: "pipe",
      });
      // The server writes cache diagnostics to stderr. Keep it out of stdout.
      transport.stderr?.on("data", () => {});

      const client = new Client(
        { name: "turast-ai", version: "0.1.0" },
        { capabilities: {} },
      );
      await client.connect(transport);
      this.client = client;
      this.lastError = null;
      return client;
    })();

    try {
      return await this.connecting;
    } catch (err) {
      this.connecting = null;
      this.lastError = (err as Error).message;
      throw new Error(
        `Gagal terhubung ke server MCP Turath. Perintah: ${this.describe()}. ` +
          `Pastikan turath-mcp-server terpasang (npm install). Detail: ${this.lastError}`,
      );
    }
  }

  private async withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timeout ${this.timeoutMs}ms pada ${label}`)),
        this.timeoutMs,
      );
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async listTools(): Promise<{ name: string; description?: string }[]> {
    const client = await this.connect();
    const res = await this.withTimeout(client.listTools(), "listTools");
    return res.tools.map((t) => ({ name: t.name, description: t.description }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const client = await this.connect();
    let res;
    try {
      res = await this.withTimeout(
        client.callTool({ name, arguments: args }),
        `callTool:${name}`,
      );
    } catch (err) {
      // A transport failure invalidates the cached client.
      this.client = null;
      this.connecting = null;
      this.lastError = (err as Error).message;
      return { ok: false, data: null, rawText: "", error: this.lastError };
    }

    const content = (res as { content?: unknown }).content;
    const first = Array.isArray(content) ? content[0] : undefined;
    const rawText =
      first && typeof first === "object" && first !== null && "text" in first
        ? String((first as { text: unknown }).text ?? "")
        : "";

    if ((res as { isError?: boolean }).isError) {
      return { ok: false, data: null, rawText, error: rawText || "MCP tool error" };
    }

    let data: unknown = rawText;
    if (rawText.trim().startsWith("{") || rawText.trim().startsWith("[")) {
      try {
        data = JSON.parse(rawText);
      } catch {
        // Leave as text; the caller decides whether text is acceptable.
      }
    }
    return { ok: true, data, rawText };
  }

  /** Probe which capabilities actually respond, for the health endpoint. */
  async probe(): Promise<Record<string, { ok: boolean; detail: string }>> {
    const out: Record<string, { ok: boolean; detail: string }> = {};
    for (const [label, name, args] of [
      ["search", "search_library", { query: "الوضوء" }],
      ["book_info", "get_book_info", { bookId: 9953 }],
      ["read_page", "read_page", { bookId: 9953, pageNumber: 1 }],
      ["author", "get_author_details", { authorId: 125 }],
    ] as const) {
      const r = await this.callTool(name, args as Record<string, unknown>);
      out[label] = { ok: r.ok, detail: r.ok ? "ok" : (r.error ?? "gagal") };
    }
    return out;
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close().catch(() => {});
      this.client = null;
    }
    this.connecting = null;
  }
}
