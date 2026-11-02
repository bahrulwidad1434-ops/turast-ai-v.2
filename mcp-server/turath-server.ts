/**
 * Turast AI's own Turath MCP server (stdio).
 *
 * Derived from turath-mcp-server@1.2.0 (MIT). Same tool names and argument
 * names, so the client contract is unchanged, with one functional addition:
 * `search_library` accepts `book` (restrict to one book ID). The upstream
 * server's zod schema silently dropped that argument even though
 * api.turath.io supports it (verified: /search?book=2186 returns only 2186).
 *
 * Data still comes exclusively from api.turath.io through turath-sdk.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getAuthor, getBookInfo, getPage, search } from "turath-sdk";

class TtlCache<T> {
  private readonly map = new Map<string, { value: T; expiry: number }>();
  constructor(private readonly ttlMs: number, private readonly max = 500) {}
  get(key: string): T | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expiry) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }
  set(key: string, value: T): void {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value as string);
    this.map.set(key, { value, expiry: Date.now() + this.ttlMs });
  }
}

const searchCache = new TtlCache<unknown>(5 * 60_000);
const pageCache = new TtlCache<unknown>(30 * 60_000, 2000);
const bookCache = new TtlCache<unknown>(60 * 60_000);
const authorCache = new TtlCache<unknown>(60 * 60_000);

const SearchArgs = z.object({
  query: z.string().min(1),
  category: z.number().int().positive().optional(),
  author: z.number().int().positive().optional(),
  book: z.number().int().positive().optional(),
  page: z.number().int().positive().optional(),
});
const BookArgs = z.object({ bookId: z.number().int().positive() });
const AuthorArgs = z.object({ authorId: z.number().int().positive() });
const PageArgs = z.object({ bookId: z.number().int().positive(), pageNumber: z.number().int().positive() });

const server = new Server({ name: "turast-turath-server", version: "2.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "search_library",
      description: "Full-text search across turath.io books. Optional filters: category ID, author ID, book ID.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Arabic search query" },
          category: { type: "number", description: "Category ID (cat_id)" },
          author: { type: "number", description: "Author ID" },
          book: { type: "number", description: "Book ID — restrict search to a single book" },
          page: { type: "number", description: "Results page number (20 hits per page)" },
        },
        required: ["query"],
      },
    },
    {
      name: "get_book_info",
      description: "Book metadata (name, bibliographic info, author_id, cat_id) and index (volumes, headings).",
      inputSchema: { type: "object", properties: { bookId: { type: "number" } }, required: ["bookId"] },
    },
    {
      name: "get_author_details",
      description: "Author biography from turath.io, when available.",
      inputSchema: { type: "object", properties: { authorId: { type: "number" } }, required: ["authorId"] },
    },
    {
      name: "read_page",
      description: "Exact text of one book page. pageNumber is the internal page_id from search results, NOT the printed page.",
      inputSchema: {
        type: "object",
        properties: { bookId: { type: "number" }, pageNumber: { type: "number", description: "Internal page_id" } },
        required: ["bookId", "pageNumber"],
      },
    },
  ],
}));

async function cached<T>(cache: TtlCache<unknown>, key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit !== undefined) return hit as T;
  const value = await load();
  cache.set(key, value);
  return value;
}

const ok = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case "search_library": {
        const a = SearchArgs.parse(args);
        const key = `${a.query}|${a.category ?? ""}|${a.author ?? ""}|${a.book ?? ""}|${a.page ?? 1}`;
        return ok(await cached(searchCache, key, () =>
          search(a.query, { category: a.category, author: a.author, book: a.book, page: a.page }),
        ));
      }
      case "get_book_info": {
        const { bookId } = BookArgs.parse(args);
        return ok(await cached(bookCache, String(bookId), () => getBookInfo(bookId)));
      }
      case "get_author_details": {
        const { authorId } = AuthorArgs.parse(args);
        return ok(await cached(authorCache, String(authorId), () => getAuthor(authorId)));
      }
      case "read_page": {
        const { bookId, pageNumber } = PageArgs.parse(args);
        return ok(await cached(pageCache, `${bookId}:${pageNumber}`, () => getPage(bookId, pageNumber)));
      }
      default:
        throw new Error(`Tool not found: ${name}`);
    }
  } catch (error) {
    const message = error instanceof z.ZodError ? `Validation Error: ${error.message}` : (error as Error).message || "Unknown error";
    return { isError: true, content: [{ type: "text" as const, text: message }] };
  }
});

await server.connect(new StdioServerTransport());
console.error("Turast Turath MCP server running on stdio");
