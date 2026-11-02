import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TurathMcpClient } from "../retrieval/mcpClient.js";
import { RetrievalService } from "../retrieval/retrievalService.js";
import { toDisplayEvidence } from "../retrieval/validation.js";
import { RegistryStore } from "../registry/registryStore.js";
import { TurathCatalog, type CatalogType } from "../catalog/catalog.js";

const envFile = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const port = Number(process.env.PORT ?? 8787);

// Inisialisasi MCP Client & Retrieval Service
const mcp = new TurathMcpClient({
  command: process.env.TURATH_MCP_COMMAND,
  args: process.env.TURATH_MCP_ENTRY
    ? ["--yes", "tsx", process.env.TURATH_MCP_ENTRY]
    : undefined,
});
const retrieval = new RetrievalService(mcp);

// Registri & Katalog Turath
const registryFile =
  process.env.TURAST_REGISTRY_FILE ??
  fileURLToPath(new URL("../../data/source-registry.json", import.meta.url));
const store = new RegistryStore(registryFile);
const registry = store.get();

const catalog = new TurathCatalog(
  process.env.TURATH_CATALOG_FILE ??
    fileURLToPath(new URL("../../data/turath-catalog.sqlite", import.meta.url)),
);
void catalog.ensureLoaded();

// Helper validasi ID numerik
const positiveInt = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n > 0 && n <= Number.MAX_SAFE_INTEGER
    ? n
    : undefined;
};

// CORS Lengkap agar bisa di-fetch bebas dari Gemini Canvas
const corsHeaders: Record<string, string> = {
  "access-control-allow-origin": process.env.CORS_ORIGIN ?? "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "Content-Type, Authorization, X-Requested-With, Accept",
  "access-control-max-age": "86400",
};

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, {
    ...corsHeaders,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
};

const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  let body = "";
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > 50_000) throw new Error("Request terlalu besar.");
  }
  const parsed: unknown = JSON.parse(body || "{}");
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // Preflight check
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders);
      return res.end();
    }

    // Healthcheck endpoint
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/api/health")) {
      await catalog.ensureLoaded();
      let tools: unknown[] = [];
      let error: string | null = null;
      try {
        tools = await mcp.listTools();
      } catch (e) {
        error = (e as Error).message;
      }
      return json(res, error ? 503 : 200, {
        ok: !error,
        service: "Turast Backend Engine (MCP & Retrieval)",
        aiMode: "Client-side (Gemini Canvas)",
        mcp: { configured: true, tools, error },
        catalog: catalog.stats(),
      });
    }

    // Endpoint Autocomplete Filter (Kitab, Penulis, Kategori) untuk UI Canvas
    if (req.method === "GET" && url.pathname === "/api/catalog/search") {
      const type = url.searchParams.get("type") as CatalogType;
      if (!["book", "author", "category"].includes(type)) {
        return json(res, 400, { error: "type harus book, author, atau category." });
      }
      const q = (url.searchParams.get("q") ?? "").slice(0, 80);
      await catalog.ensureLoaded();
      if (!catalog.ready) {
        return json(res, 503, { error: `Katalog belum siap: ${catalog.error ?? "memuat…"}` });
      }
      return json(res, 200, {
        items: catalog.search(type, q, Number(url.searchParams.get("limit") ?? 20)),
      });
    }

    // Endpoint Pencarian Teks Asli (Ibarah & Sanad) dari Database Turath
    if (req.method === "POST" && url.pathname === "/api/search") {
      const body = await readBody(req);
      if (typeof body.query !== "string" || body.query.trim().length === 0) {
        return json(res, 400, { error: "query wajib diisi teks pencarian Arab/Indonesia." });
      }

      const result = await retrieval.search({
        query: body.query.trim(),
        category: positiveInt(body.category),
        author: positiveInt(body.author),
        book: positiveInt(body.book),
        pages: positiveInt(body.pages),
      });

      const mode = url.searchParams.get("mode") === "explore" ? "explore" : "research";
      const hits = result.hits
        .filter((hit) => mode === "explore" || registry.isApproved(hit.bookId))
        .map(toDisplayEvidence)
        .filter((hit): hit is NonNullable<typeof hit> => hit !== null)
        .map((hit) => ({
          evidenceId: hit.evidenceId,
          sourceStatus: registry.get(hit.bookId)?.status ?? "pending_review",
          ibarahAsli: hit.sourceText,
          reference: {
            title: hit.pageMeta.book_name,
            author: hit.pageMeta.author_name ?? null,
            volume: hit.pageMeta.vol ?? null,
            printedPage: hit.pageMeta.page ?? null,
            bookId: hit.bookId,
            pageId: hit.pageId,
          },
          sourceTextHash: hit.sourceTextHash,
        }));

      return json(res, 200, {
        ...result,
        mode,
        hits,
        excludedByRegistry: mode === "research" ? result.hits.length - hits.length : 0,
      });
    }

    json(res, 404, { error: "Endpoint not found" });
  } catch (error) {
    console.error("[turast] request error:", (error as Error).message);
    json(res, 500, { error: "Terjadi kesalahan internal pada server database Turath." });
  }
});

server.listen(port, () => {
  console.log(`Turast Backend Engine berjalan di port :${port}`);
});

const shutdown = async () => {
  await mcp.close();
  server.close();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
