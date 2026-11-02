import { TurathMcpClient } from "./mcpClient.js";
import { cleanTurathMarkup } from "./validation.js";
import {
  TurathBookInfo,
  TurathPageResponse,
  TurathSearchResponse,
  type TurathPageMeta,
  type TurathSearchHit,
} from "./schemas.js";

export type RetrievalQuery = {
  query: string;
  category?: number;
  author?: number;
  book?: number;
  /** Maximum search result page to request; capped for safety. */
  pages?: number;
  /** Maximum hits to materialize via read_page (each costs one MCP call). */
  maxHits?: number;
};

export type RetrievalEvidence = {
  /** Stable local ID derived from the exact source identity. */
  evidenceId: string;
  /** Never AI-generated. Exactly the text returned by MCP read_page. */
  sourceText: string;
  /** Search hit text, if available; kept separately from sourceText. */
  matchedText: string | null;
  /** Metadata returned from read_page, not guessed. */
  pageMeta: TurathPageMeta;
  bookId: number;
  /** Internal page id used for retrieval. */
  pageId: number;
  /** Search category/author IDs when supplied by the hit. */
  categoryId: number | null;
  authorId: number | null;
  sourceUrl: null;
  sourceIdentity: string;
  retrieval: {
    query: string;
    retrievedAt: string;
    searchRaw: string;
    pageRaw: string;
  };
  validation: {
    verified: boolean;
    reason: string;
  };
};

export type RetrievalResult = {
  query: string;
  status: "ok" | "empty" | "error";
  message?: string;
  hits: RetrievalEvidence[];
  searchCount: number | null;
  diagnostics: { searchPages: number; rawHits: number; dropped: number };
};

export class RetrievalService {
  constructor(
    private readonly mcp: TurathMcpClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async search(input: RetrievalQuery): Promise<RetrievalResult> {
    const query = input.query.trim();
    if (!query) {
      return {
        query,
        status: "empty",
        message: "Masukkan pertanyaan atau kata kunci pencarian.",
        hits: [],
        searchCount: 0,
        diagnostics: { searchPages: 0, rawHits: 0, dropped: 0 },
      };
    }

    const maxPages = Math.min(Math.max(input.pages ?? 1, 1), 3);
    const hits: RetrievalEvidence[] = [];
    let searchCount: number | null = null;
    let rawHits = 0;
    let dropped = 0;

    for (let page = 1; page <= maxPages; page++) {
      const response = await this.mcp.callTool("search_library", {
        query,
        ...(input.category === undefined ? {} : { category: input.category }),
        ...(input.author === undefined ? {} : { author: input.author }),
        ...(input.book === undefined ? {} : { book: input.book }),
        page,
      });
      if (!response.ok) {
        return {
          query,
          status: "error",
          message: response.error ?? "Pencarian MCP gagal.",
          hits: [],
          searchCount,
          diagnostics: { searchPages: page, rawHits, dropped },
        };
      }

      const parsed = TurathSearchResponse.safeParse(response.data);
      if (!parsed.success) {
        return {
          query,
          status: "error",
          message: "Format hasil pencarian MCP tidak dikenali; kutipan tidak ditampilkan.",
          hits: [],
          searchCount,
          diagnostics: { searchPages: page, rawHits, dropped },
        };
      }
      searchCount = parsed.data.count ?? null;
      rawHits += parsed.data.data.length;
      const maxHits = Math.min(Math.max(input.maxHits ?? 20, 1), 20);
      for (const hit of parsed.data.data) {
        if (hits.length + dropped >= maxHits) break;
        const evidence = await this.materializeEvidence(query, hit, response.rawText);
        if (evidence) hits.push(evidence);
        else dropped++;
      }
      // Empty page or no declared additional results means no reason to call more.
      if (parsed.data.data.length === 0) break;
    }

    // De-duplicate by exact source identity, preserving first occurrence.
    const unique = [...new Map(hits.map((h) => [h.evidenceId, h])).values()];
    return {
      query,
      status: unique.length ? "ok" : "empty",
      message: unique.length ? undefined : "Tidak ditemukan dalam sumber yang tersedia.",
      hits: unique,
      searchCount,
      diagnostics: { searchPages: maxPages, rawHits, dropped },
    };
  }

  private async materializeEvidence(
    query: string,
    hit: TurathSearchHit,
    searchRaw: string,
  ): Promise<RetrievalEvidence | null> {
    // page_id, not the printed `page`, is the only safe argument to read_page.
    const page = await this.mcp.callTool("read_page", {
      bookId: hit.book_id,
      pageNumber: hit.meta.page_id,
    });
    if (!page.ok) return null;
    const parsed = TurathPageResponse.safeParse(page.data);
    if (!parsed.success || !parsed.data.text) return null;

    const pageMeta = parsed.data.meta;
    // Verify identity across search and page response. A mismatch is not safe.
    if (
      pageMeta.page_id !== hit.meta.page_id ||
      pageMeta.book_name !== hit.meta.book_name ||
      (pageMeta.vol ?? null) !== (hit.meta.vol ?? null)
    ) {
      return null;
    }

    const sourceIdentity = [
      hit.book_id,
      pageMeta.page_id,
      pageMeta.vol ?? "",
      pageMeta.book_name,
    ].join(":");
    const evidenceId = `turath:${sourceIdentity}`;
    return {
      evidenceId,
      sourceText: cleanTurathMarkup(parsed.data.text),
      matchedText: hit.text ?? hit.snip ?? null,
      pageMeta,
      bookId: hit.book_id,
      pageId: pageMeta.page_id,
      categoryId: hit.cat_id ?? null,
      authorId: hit.author_id ?? null,
      sourceUrl: null,
      sourceIdentity,
      retrieval: {
        query,
        retrievedAt: this.now().toISOString(),
        searchRaw,
        pageRaw: page.rawText,
      },
      validation: {
        verified: true,
        reason: "Book ID, internal page ID, volume, and book name match search and page responses.",
      },
    };
  }

  async getBookInfo(bookId: number): Promise<ReturnType<typeof TurathBookInfo.parse>> {
    const result = await this.mcp.callTool("get_book_info", { bookId });
    if (!result.ok) throw new Error(result.error ?? "Gagal mengambil metadata kitab.");
    return TurathBookInfo.parse(result.data);
  }

  /**
   * Search only (one MCP call, no read_page). Returns validated hits plus the
   * raw payload so a later `materialize` can keep the audit trail.
   */
  async searchHits(input: Omit<RetrievalQuery, "maxHits" | "pages"> & { page?: number }): Promise<
    | { ok: true; count: number | null; hits: TurathSearchHit[]; raw: string }
    | { ok: false; error: string }
  > {
    const query = input.query.trim();
    if (!query) return { ok: true, count: 0, hits: [], raw: "" };
    const response = await this.mcp.callTool("search_library", {
      query,
      ...(input.category === undefined ? {} : { category: input.category }),
      ...(input.author === undefined ? {} : { author: input.author }),
      ...(input.book === undefined ? {} : { book: input.book }),
      ...(input.page === undefined ? {} : { page: input.page }),
    });
    if (!response.ok) return { ok: false, error: response.error ?? "Pencarian MCP gagal." };
    const parsed = TurathSearchResponse.safeParse(response.data);
    if (!parsed.success) return { ok: false, error: "Format hasil pencarian MCP tidak dikenali." };
    return { ok: true, count: parsed.data.count ?? null, hits: parsed.data.data, raw: response.rawText };
  }

  /** Read the full page for a search hit and verify its identity. */
  materialize(query: string, hit: TurathSearchHit, searchRaw: string): Promise<RetrievalEvidence | null> {
    return this.materializeEvidence(query, hit, searchRaw);
  }

  /**
   * Read a page directly by (bookId, pageId) — used when the client asks for
   * an action on a card. Accepted only if Turath echoes the same page_id.
   */
  async readPage(bookId: number, pageId: number): Promise<RetrievalEvidence | null> {
    const page = await this.mcp.callTool("read_page", { bookId, pageNumber: pageId });
    if (!page.ok) return null;
    const parsed = TurathPageResponse.safeParse(page.data);
    if (!parsed.success || !parsed.data.text || parsed.data.meta.page_id !== pageId) return null;
    const pageMeta = parsed.data.meta;
    const sourceIdentity = [bookId, pageMeta.page_id, pageMeta.vol ?? "", pageMeta.book_name].join(":");
    return {
      evidenceId: `turath:${sourceIdentity}`,
      sourceText: cleanTurathMarkup(parsed.data.text),
      matchedText: null,
      pageMeta,
      bookId,
      pageId: pageMeta.page_id,
      categoryId: null,
      authorId: null,
      sourceUrl: null,
      sourceIdentity,
      retrieval: { query: "", retrievedAt: this.now().toISOString(), searchRaw: "direct-read", pageRaw: page.rawText },
      validation: { verified: true, reason: "Page read directly; Turath echoed the requested page_id." },
    };
  }
}
