import { createHash } from "node:crypto";
import type { RetrievalEvidence } from "./retrievalService.js";

const NAMED_ENTITIES: Record<string, string> = {
  quot: '"',
  amp: "&",
  lt: "<",
  gt: ">",
  apos: "'",
  nbsp: " ",
};

/**
 * Decode only transport encoding (HTML entities). Decoding restores the
 * character the corpus actually stores; it never rewrites wording. A single
 * pass avoids double-decoding cases such as `&amp;lt;`.
 */
function decodeTransportEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,9});/g, (match, body: string) => {
    if (body[0] === "#") {
      const isHex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

/**
 * Remove only markup emitted by Turath's search/page renderer. This is not a
 * linguistic normalizer: Arabic letters, harakat, punctuation, whitespace,
 * and control symbols from the source are preserved byte-for-byte.
 *
 * The raw MCP payload remains in retrieval.pageRaw for audit. The returned
 * display text is therefore clean without pretending the transport payload
 * contained no markup.
 */
export function cleanTurathMarkup(text: string): string {
  // Turath also uses speaker markers such as <s0>, <s1>. Remove all
  // ASCII-tag-shaped transport markup, but keep their inner Arabic content.
  return decodeTransportEntities(text.replace(/<\/?[A-Za-z][A-Za-z0-9]*(?:\s[^>]*)?>/g, ""));
}

/**
 * Final display gate. Source text must be an exact retrieved page payload and
 * must retain its retrieval identity. AI output is intentionally not accepted
 * by this module.
 */
export function validateEvidence(evidence: RetrievalEvidence): {
  valid: boolean;
  reason: string;
} {
  if (!evidence.validation.verified) {
    return { valid: false, reason: "Evidence retrieval identity was not verified." };
  }
  if (!evidence.sourceText.trim()) {
    return { valid: false, reason: "Retrieved source text is empty." };
  }
  if (!evidence.evidenceId.startsWith("turath:")) {
    return { valid: false, reason: "Missing Turath evidence identity." };
  }
  if (!evidence.retrieval.pageRaw.trim() || !evidence.retrieval.searchRaw.trim()) {
    return { valid: false, reason: "Raw retrieval payload is missing." };
  }
  return { valid: true, reason: "Retrieved source is displayable as verified ibarah." };
}

export function sourceTextHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export type DisplayEvidence = RetrievalEvidence & {
  sourceTextHash: string;
};

export function toDisplayEvidence(evidence: RetrievalEvidence): DisplayEvidence | null {
  const check = validateEvidence(evidence);
  if (!check.valid) return null;
  return { ...evidence, sourceTextHash: sourceTextHash(evidence.sourceText) };
}
