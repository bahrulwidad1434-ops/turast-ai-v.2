import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { SourceRecord, SourceRegistry } from "./sourceRegistry.js";

const FileSchema = z.object({
  version: z.literal(1),
  sources: z.array(SourceRecord),
});

/**
 * Persisted, human-edited registry. The file is the source of truth; no code
 * path may auto-approve a book. Missing file means an empty registry.
 */
export class RegistryStore {
  private readonly registry = new SourceRegistry();

  constructor(private readonly filePath: string) {
    if (!existsSync(filePath)) return;
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    const parsed = FileSchema.parse(raw);
    for (const record of parsed.sources) this.registry.set(record);
  }

  get(): SourceRegistry {
    return this.registry;
  }

  save(): void {
    const payload = { version: 1 as const, sources: this.registry.list() };
    writeFileSync(this.filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  }
}
