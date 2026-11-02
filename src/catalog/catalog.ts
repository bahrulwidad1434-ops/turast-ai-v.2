/**
 * Turath.io's official catalog (books, authors, categories).
 *
 * Source: app.turath.io/data-core-v4.sqlite — the same snapshot the official
 * Turath app downloads to populate its library. Cached on disk, refreshed
 * when older than CATALOG_MAX_AGE_DAYS. Entries are used verbatim; nothing is
 * added or inferred.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { arabicSkeleton, isArabic, matchScore, type Skeleton } from "./translit.js";

export const CATALOG_URL = process.env.TURATH_CATALOG_URL ?? "https://app.turath.io/data-core-v4.sqlite";

export type CatalogType = "book" | "author" | "category";

export type BookEntry = { id: number; name: string; authorId: number | null; catId: number | null; pageCount: number | null };
export type AuthorEntry = { id: number; name: string; death: number | null };
export type CategoryEntry = { id: number; name: string };

export type CatalogItem = {
  type: CatalogType;
  id: number;
  name: string;
  /** Secondary line: author for books, death year for authors. */
  detail: string | null;
};

type Indexed<T> = T & { sk: Skeleton };

export class TurathCatalog {
  private books = new Map<number, Indexed<BookEntry>>();
  private authors = new Map<number, Indexed<AuthorEntry>>();
  private cats = new Map<number, Indexed<CategoryEntry>>();
  private loading: Promise<void> | null = null;
  dataVersion: number | null = null;
  loadedAt: string | null = null;
  error: string | null = null;

  constructor(
    private readonly filePath: string,
    private readonly maxAgeDays = Number(process.env.CATALOG_MAX_AGE_DAYS ?? 7),
  ) {}

  get ready(): boolean {
    return this.books.size > 0;
  }

  stats() {
    return {
      ready: this.ready,
      books: this.books.size,
      authors: this.authors.size,
      categories: this.cats.size,
      dataVersion: this.dataVersion,
      loadedAt: this.loadedAt,
      source: CATALOG_URL,
      error: this.error,
    };
  }

  /** Load from disk, downloading first if missing or stale. Safe to call repeatedly. */
  ensureLoaded(): Promise<void> {
    if (this.ready) return Promise.resolve();
    this.loading ??= this.load().catch((err) => {
      this.error = (err as Error).message;
      console.warn("[catalog] gagal memuat katalog Turath:", this.error);
      this.loading = null;
    });
    return this.loading;
  }

  private async load(): Promise<void> {
    const stale =
      !existsSync(this.filePath) ||
      Date.now() - statSync(this.filePath).mtimeMs > this.maxAgeDays * 86_400_000;
    if (stale) {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await this.download();
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
      if (lastErr) {
        // A stale-but-present snapshot is still real Turath data; use it.
        if (!existsSync(this.filePath)) throw lastErr;
        console.warn("[catalog] refresh failed, using cached snapshot:", (lastErr as Error).message);
      }
    }
    this.readFile();
  }

  private async download(): Promise<void> {
    const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Unduh katalog Turath gagal (HTTP ${res.status}).`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.subarray(0, 15).toString("latin1") !== "SQLite format 3") {
      throw new Error("File katalog Turath bukan SQLite yang valid.");
    }
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, buf);
    renameSync(tmp, this.filePath);
  }

  private readFile(): void {
    const db = new DatabaseSync(this.filePath, { readOnly: true });
    try {
      const rows = (table: string) =>
        db.prepare(`SELECT json FROM ${table}`).all().map((r) => JSON.parse(String(r.json)) as Record<string, unknown>);
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

      for (const c of rows("cats")) {
        const e = { id: Number(c.id), name: String(c.name) };
        this.cats.set(e.id, { ...e, sk: arabicSkeleton(e.name) });
      }
      for (const a of rows("authors")) {
        const e = { id: Number(a.id), name: String(a.name), death: num(a.death) };
        this.authors.set(e.id, { ...e, sk: arabicSkeleton(e.name) });
      }
      for (const b of rows("books")) {
        const e = { id: Number(b.id), name: String(b.name), authorId: num(b.author_id), catId: num(b.cat_id), pageCount: num(b.page_count) };
        this.books.set(e.id, { ...e, sk: arabicSkeleton(e.name) });
      }
      const meta = db.prepare("SELECT data_version FROM snapshot_meta LIMIT 1").get();
      this.dataVersion = meta ? Number(meta.data_version) : null;
      this.loadedAt = new Date().toISOString();
      this.error = null;
    } finally {
      db.close();
    }
  }

  book(id: number) { return this.books.get(id); }
  author(id: number) { return this.authors.get(id); }
  category(id: number) { return this.cats.get(id); }

  toItem(type: CatalogType, id: number): CatalogItem | null {
    if (type === "book") {
      const b = this.books.get(id);
      if (!b) return null;
      const a = b.authorId != null ? this.authors.get(b.authorId) : undefined;
      return { type, id, name: b.name, detail: a ? a.name : null };
    }
    if (type === "author") {
      const a = this.authors.get(id);
      return a ? { type, id, name: a.name, detail: a.death ? `ت ${a.death}هـ` : null } : null;
    }
    const c = this.cats.get(id);
    return c ? { type, id, name: c.name, detail: null } : null;
  }

  search(type: CatalogType, query: string, limit = 25): CatalogItem[] {
    const source: Iterable<Indexed<{ id: number; name: string }>> =
      type === "book" ? this.books.values() : type === "author" ? this.authors.values() : this.cats.values();
    const q = query.trim();

    if (!q) {
      // Empty query: categories list in catalog order; nothing for large lists.
      return type === "category" ? [...this.cats.values()].map((c) => this.toItem("category", c.id)!) : [];
    }
    const scored: Array<{ id: number; score: number; len: number }> = [];
    for (const e of source) {
      const s = matchScore(q, e.name, e.sk);
      if (s > 0) scored.push({ id: e.id, score: s, len: e.name.length });
    }
    scored.sort((a, b) => b.score - a.score || a.len - b.len || a.id - b.id);
    return scored.slice(0, Math.min(Math.max(limit, 1), 50)).map((s) => this.toItem(type, s.id)!);
  }

  static isArabicQuery = isArabic;
}
