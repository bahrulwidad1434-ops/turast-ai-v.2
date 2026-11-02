/**
 * Typed schema for the Turath MCP server responses.
 *
 * IMPORTANT: these shapes were verified against turath-mcp-server v1.2.0 by
 * live probing (see docs/MCP-AUDIT.md). They are parsed defensively because the
 * upstream API is undocumented and can drift. Parsing failures become explicit
 * errors -- never silently substituted defaults.
 */
import { z } from "zod";

/** Meta block present on search hits and on read_page responses. */
export const TurathPageMeta = z.object({
  headings: z.array(z.string()).default([]),
  /** Internal running page index. This is what read_page expects. */
  page_id: z.number(),
  /** Printed page number as it appears in the physical volume. */
  page: z.union([z.number(), z.string()]).nullish(),
  /** Printed volume, as a string upstream ("1", "70"). */
  vol: z.union([z.string(), z.number()]).nullish(),
  book_name: z.string(),
  author_name: z.string().nullish(),
});
export type TurathPageMeta = z.infer<typeof TurathPageMeta>;

export const TurathSearchHit = z.object({
  book_id: z.number(),
  cat_id: z.number().nullish(),
  author_id: z.number().nullish(),
  meta: TurathPageMeta,
  /** Highlighted snippet; contains <em> markers. */
  snip: z.string().nullish(),
  /** Result text; may contain <em> markers. Not guaranteed to equal the full page. */
  text: z.string().nullish(),
});
export type TurathSearchHit = z.infer<typeof TurathSearchHit>;

export const TurathSearchResponse = z.object({
  count: z.number().nullish(),
  data: z.array(TurathSearchHit).default([]),
});
export type TurathSearchResponse = z.infer<typeof TurathSearchResponse>;

export const TurathPageResponse = z.object({
  meta: TurathPageMeta,
  text: z.string().nullish(),
});
export type TurathPageResponse = z.infer<typeof TurathPageResponse>;

export const TurathBookInfo = z.object({
  meta: z.object({
    id: z.number(),
    name: z.string(),
    type: z.number().nullish(),
    printed: z.number().nullish(),
    /** Short bibliographic description written in Arabic by the corpus. */
    info: z.string().nullish(),
    info_long: z.string().nullish(),
    author_id: z.number().nullish(),
    cat_id: z.number().nullish(),
  }),
  indexes: z
    .object({
      volumes: z.array(z.string()).default([]),
      headings: z
        .array(
          z.object({
            title: z.string(),
            level: z.number().nullish(),
            page: z.number().nullish(),
          }),
        )
        .default([]),
    })
    .default({ volumes: [], headings: [] }),
});
export type TurathBookInfo = z.infer<typeof TurathBookInfo>;
