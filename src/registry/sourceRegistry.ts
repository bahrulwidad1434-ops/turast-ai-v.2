import { z } from "zod";

export const SourceStatus = z.enum(["approved", "pending_review", "excluded"]);
export type SourceStatus = z.infer<typeof SourceStatus>;

export const SourceRecord = z.object({
  bookId: z.number().int().positive(),
  title: z.string().optional(),
  author: z.string().optional(),
  status: SourceStatus,
  reviewNote: z.string().optional(),
  reviewedAt: z.string().optional(),
  reviewedBy: z.string().optional(),
});
export type SourceRecord = z.infer<typeof SourceRecord>;

/**
 * Explicit registry gate. Unknown sources are pending, never approved by AI.
 */
export class SourceRegistry {
  private readonly records = new Map<number, SourceRecord>();

  constructor(records: SourceRecord[] = []) {
    for (const record of records) this.records.set(record.bookId, record);
  }

  get(bookId: number): SourceRecord | undefined {
    return this.records.get(bookId);
  }

  set(record: SourceRecord): void {
    this.records.set(record.bookId, record);
  }

  isApproved(bookId: number): boolean {
    return this.records.get(bookId)?.status === "approved";
  }

  /** Research mode uses only human-approved books. */
  filterApproved<T extends { bookId: number }>(items: T[]): T[] {
    return items.filter((item) => this.isApproved(item.bookId));
  }

  list(): SourceRecord[] {
    return [...this.records.values()];
  }
}
