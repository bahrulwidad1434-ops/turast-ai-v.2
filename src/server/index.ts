import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TurathMcpClient } from "../retrieval/mcpClient.js";
import { RetrievalService } from "../retrieval/retrievalService.js";
import { toDisplayEvidence } from "../retrieval/validation.js";
import { RegistryStore } from "../registry/registryStore.js";
import { GeraikitaClient } from "../ai/geraikita.js";
import { AiSearchService, type SearchFilters } from "../ai/aiSearch.js";
import { TurathCatalog, type CatalogType } from "../catalog/catalog.js";

const envFile = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const port = Number(process.env.PORT ?? 8787);
const mcp = new TurathMcpClient({
  command: process.env.TURATH_MCP_COMMAND,
  args: process.env.TURATH_MCP_ENTRY
    ? ["--yes", "tsx", process.env.TURATH_MCP_ENTRY]
    : undefined,
});
const retrieval = new RetrievalService(mcp);
const registryFile =
  process.env.TURAST_REGISTRY_FILE ??
  fileURLToPath(new URL("../../data/source-registry.json", import.meta.url));
const store = new RegistryStore(registryFile);
const registry = store.get();
const ai = new GeraikitaClient();
const catalog = new TurathCatalog(
  process.env.TURATH_CATALOG_FILE ?? fileURLToPath(new URL("../../data/turath-catalog.sqlite", import.meta.url)),
);
void catalog.ensureLoaded();
const aiSearch = new AiSearchService(ai, retrieval, catalog);

const positiveInt = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n > 0 && n <= Number.MAX_SAFE_INTEGER ? n : undefined;
};

/** Accept only filter IDs that exist in Turath's catalog. */
async function readFilters(raw: unknown): Promise<{ filters: SearchFilters; error?: string }> {
  const f = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const filters: SearchFilters = {};
  for (const k of ["category", "author", "book"] as const) {
    if (f[k] === undefined || f[k] === null || f[k] === "") continue;
    const id = positiveInt(f[k]);
    if (id === undefined) return { filters, error: `Filter ${k} tidak valid.` };
    filters[k] = id;
  }
  if (!Object.keys(filters).length) return { filters };
  await catalog.ensureLoaded();
  if (!catalog.ready) {
    return { filters, error: "Katalog Turath belum tersedia, filter belum dapat diverifikasi. Coba lagi sebentar." };
  }
  if (filters.category && !catalog.category(filters.category)) return { filters, error: "Kategori tidak ada di katalog Turath." };
  if (filters.author && !catalog.author(filters.author)) return { filters, error: "Penulis tidak ada di katalog Turath." };
  if (filters.book && !catalog.book(filters.book)) return { filters, error: "Kitab tidak ada di katalog Turath." };
  return { filters };
}

// Konfigurasi CORS Middleware Lengkap untuk Akses Lintas Domain (Canvas, Pages, dll)
const corsHeaders: Record<string, string> = {
  "access-control-allow-origin": process.env.CORS_ORIGIN ?? "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
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
    if (body.length > 20_000) throw new Error("Request terlalu besar.");
  }
  const parsed: unknown = JSON.parse(body || "{}");
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // Preflight check untuk browser/CORS
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders);
      return res.end();
    }

    // Healthcheck endpoint
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/api/health")) {
      await catalog.ensureLoaded();
      let tools: unknown[] = [];
      let error: string | null = null;
      try { tools = await mcp.listTools(); } catch (e) { error = (e as Error).message; }
      return json(res, error ? 503 : 200, {
        ok: !error,
        status: "Turast API Service Active",
        mcp: { configured: true, tools, error },
        ai: { configured: ai.isConfigured(), model: ai.model },
        catalog: catalog.stats(),
      });
    }

    // Catalog autocomplete for the filter bar (books, authors, categories).
    if (req.method === "GET" && url.pathname === "/api/catalog/search") {
      const type = url.searchParams.get("type") as CatalogType;
      if (!["book", "author", "category"].includes(type)) return json(res, 400, { error: "type harus book, author, atau category." });
      const q = (url.searchParams.get("q") ?? "").slice(0, 80);
      await catalog.ensureLoaded();
      if (!catalog.ready) return json(res, 503, { error: `Katalog Turath belum tersedia: ${catalog.error ?? "memuat…"}` });
      return json(res, 200, { items: catalog.search(type, q, Number(url.searchParams.get("limit") ?? 20)) });
    }

    // Contextual AI search: question -> intent expansion -> multi-query Turath -> rerank -> summary.
    if (req.method === "POST" && url.pathname === "/api/ask") {
      const body = await readBody(req);
      const query = typeof body.query === "string" ? body.query.trim() : "";
      if (!query || query.length > 300) {
        return json(res, 400, { error: "Pertanyaan wajib diisi, maksimal 300 karakter." });
      }
      const { filters, error } = await readFilters(body.filters);
      if (error) return json(res, 400, { error });
      const result = await aiSearch.search(query, filters);
      const filterLabels = Object.fromEntries(
        (Object.entries(filters) as Array<[keyof SearchFilters, number]>).map(([k, id]) => [
          k, catalog.toItem(k === "category" ? "category" : k, id),
        ]),
      );
      return json(res, result.status === "error" ? 502 : 200, { ...result, filterLabels });
    }

    // "Verbatim Lengkap": auto-tashkeel + translation + citation for one card.
    if (req.method === "POST" && url.pathname === "/api/verbatim") {
      const body = await readBody(req);
      const bookId = positiveInt(body.bookId);
      const pageId = positiveInt(body.pageId);
      if (!bookId || !pageId) return json(res, 400, { error: "bookId dan pageId wajib berupa angka positif." });
      const result = await aiSearch.verbatim({ bookId, pageId });
      return json(res, result.status === "error" ? 502 : 200, result);
    }

    // Raw retrieval endpoint (Arabic query, no AI), kept for integrations.
    if (req.method === "POST" && url.pathname === "/api/search") {
      const body = await readBody(req);
      if (typeof body.query !== "string" || body.query.length > 500) {
        return json(res, 400, { error: "query wajib berupa teks maksimal 500 karakter." });
      }
      const result = await retrieval.search({
        query: body.query,
        category: typeof body.category === "number" ? body.category : undefined,
        author: typeof body.author === "number" ? body.author : undefined,
        book: typeof body.book === "number" ? body.book : undefined,
        pages: typeof body.pages === "number" ? body.pages : undefined,
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

    json(res, 404, { error: "Not found" });
  } catch (error) {
    console.error("[turast] request failed:", (error as Error).message);
    json(res, 500, { error: "Terjadi kesalahan internal. Tidak ada kutipan yang dibuat." });
  }
});

server.listen(port, () => {
  console.log(`Turast API running at port :${port}`);
  if (!ai.isConfigured()) console.warn("[turast] GERAIKITA_API_KEY belum diatur; /api/ask akan gagal.");
});

const shutdown = async () => { await mcp.close(); server.close(); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);