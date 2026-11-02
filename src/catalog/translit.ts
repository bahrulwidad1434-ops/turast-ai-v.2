/**
 * Bilingual (Latin <-> Arabic) name matching for the filter autocomplete.
 *
 * Both scripts are reduced to a coarse consonant skeleton so that common
 * Indonesian/English transliterations ("Syafii", "Fathul Qarib", "Fiqih")
 * match the Arabic catalog names. This only ranks entries that exist in
 * Turath's catalog; it never creates names.
 *
 * All Arabic code points are written as \u escapes on purpose: literal
 * Arabic inside regex ranges is easy to corrupt (combining marks, bidi).
 */

// Diacritics only: Quranic marks, harakat, superscript alef, small high marks, tatweel.
const HARAKAT = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;
const ARABIC_CHAR = /[؀-ۿ]/;
const AL = "ال";

export function normalizeArabic(s: string): string {
  return s
    .replace(HARAKAT, "")
    .replace(/[أإآٱ]/g, "ا") // alef variants -> alef
    .replace(/ى/g, "ي") // alef maqsura -> ya
    .replace(/ة/g, "ه") // ta marbuta -> ha
    .replace(/[^؀-ۿ0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const isArabic = (s: string) => ARABIC_CHAR.test(s);

// Arabic letter -> coarse consonant class. Alef, hamza and ain are dropped
// (Latin transliteration rarely writes them consistently).
const AR_MAP: Record<number, string> = {
  0x0628: "B", 0x062a: "T", 0x062b: "S", 0x062c: "J", 0x062d: "H", 0x062e: "K",
  0x062f: "D", 0x0630: "Z", 0x0631: "R", 0x0632: "Z", 0x0633: "S", 0x0634: "S",
  0x0635: "S", 0x0636: "D", 0x0637: "T", 0x0638: "Z", 0x063a: "G", 0x0641: "F",
  0x0642: "K", 0x0643: "K", 0x0644: "L", 0x0645: "M", 0x0646: "N", 0x0647: "H",
  0x0629: "H", 0x0648: "W", 0x064a: "Y", 0x0649: "Y",
};

const collapse = (s: string) => s.replace(/(.)\1+/g, "$1");
const stripWY = (s: string) => collapse(s.replace(/[WY]/g, ""));

export type Skeleton = { full: string; bare: string; words: string[]; shapes?: string[] };

/**
 * Consonant skeleton per word, plus a "shape" that keeps long vowels in order
 * (A for alef/ain, W for waw, Y for ya). Shapes separate words like
 * majmu' vs mu'jam that share the same consonant skeleton.
 */
export function arabicSkeleton(name: string): Skeleton {
  const rawWords = name
    .replace(HARAKAT, "")
    .split(/[^؀-ۿ]+/)
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.startsWith(AL) ? w.slice(2) : w));
  const words: string[] = [];
  const shapes: string[] = [];
  for (const w of rawWords) {
    const cps = [...w].map((c) => c.codePointAt(0)!);
    const sk = collapse(cps.map((c) => AR_MAP[c] ?? "").join(""));
    if (!sk) continue;
    words.push(sk);
    // Shape keeps consonants and long vowels in order; ain/alef become A.
    shapes.push(collapse(cps.map((c) => AR_MAP[c] ?? (c === 0x0627 || c === 0x0639 || c === 0x0622 || c === 0x0623 || c === 0x0625 ? "A" : "")).join("")));
  }
  const full = words.join("");
  return { full, bare: stripWY(full), words, shapes };
}

/** Latin shape: same alphabet as arabicSkeleton shapes (vowels a/i/u -> A/Y/W only when long or initial). */
function latinShape(token: string): string {
  let w = token.replace(/^[aiu]/, "A").replace(/aa|a(?=$)/g, "A").replace(/ii|ee/g, "Y").replace(/uu|oo|u(?=$)/g, "W");
  for (const [re, rep] of DIGRAPHS) w = w.replace(re, rep);
  w = w.replace(/(ah|at)$/, "#");
  return collapse([...w].map((c) => (c === "#" ? "H" : /[A-Z]/.test(c) ? c : SINGLE[c] ?? "")).join(""));
}

const ARTICLES = new Set([
  "al", "el", "as", "asy", "ash", "an", "ar", "at", "ad", "az", "adz", "ats", "ath",
  "ud", "ul", "il", "us", "ush", "usy", "ur", "un", "ut",
]);
const DIGRAPHS: Array<[RegExp, string]> = [
  [/sy|sh|ts/g, "S"], [/th/g, "T"], [/dh/g, "D"], [/dz|zh/g, "Z"], [/kh/g, "K"], [/gh/g, "G"],
];
const SINGLE: Record<string, string> = {
  b: "B", t: "T", j: "J", h: "H", d: "D", z: "Z", r: "R", s: "S", g: "G", f: "F", p: "F", v: "F",
  q: "K", k: "K", c: "K", l: "L", m: "M", n: "N", w: "W", y: "Y", x: "KS",
};

/**
 * Indonesian transliteration glues the article onto a word: "Fathul Qarib",
 * "Tuhfatul Muhtaj", "ulumuddin" (ulum + ad-din). Split those joins so each
 * token maps to one Arabic word.
 */
function splitIdafa(tokens: string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    // word + article + sun-letter-doubled word: ulumuddin -> ulum + din
    const mid = t.length >= 8 ? t.match(/^(.{3,}?)(?:ud|us|ush|usy|ur|un|ut|uz|ad|as)(d|s|sy|sh|r|n|t|z)(.{2,})$/) : null;
    if (mid && mid[3].startsWith(mid[2].slice(-1)) === false) {
      out.push(mid[1], mid[2] + mid[3]);
      continue;
    }
    if (mid) {
      out.push(mid[1], mid[3]);
      continue;
    }
    // word + trailing article: fathul -> fath, tuhfatul -> tuhfat
    const tail = t.length > 4 ? t.match(/^(.{3,}?)(ul|il|us|ush|usy|ud|ur|un)$/) : null;
    out.push(tail ? tail[1] : t);
  }
  return out;
}

/** Skeleton for each Latin token (articles dropped, idafa joins split). */
export function latinTokens(query: string): Skeleton[] {
  const raw = query
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’‘`ʿʾ]/g, "")
    .split(/[^a-z]+/)
    .filter(Boolean);
  const tokens = splitIdafa(raw.filter((t, i) => !(ARTICLES.has(t) && i < raw.length - 1)));
  return tokens
    .map((t) => {
      // Final -ah/-at usually renders ta marbuta.
      let w = t.length > 3 ? t.replace(/(ah|at)$/, "#") : t;
      for (const [re, rep] of DIGRAPHS) w = w.replace(re, rep);
      w = [...w].map((c) => (c === "#" ? "H" : /[A-Z]/.test(c) ? c : SINGLE[c] ?? "")).join("");
      const full = collapse(w);
      return { full, bare: stripWY(full), words: [full], shapes: [latinShape(t)] };
    })
    .filter((s) => s.full.length >= 1);
}

/** Skeleton equality that tolerates final ta marbuta and long-vowel W/Y. */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const ta = a.replace(/H$/, "");
  const tb = b.replace(/H$/, "");
  return ta === tb || stripWY(ta) === stripWY(tb);
}

/**
 * Score how well a query matches a catalog name. 0 = no match.
 * Every query token must match somewhere for a positive score.
 */
export function matchScore(query: string, name: string, nameSk = arabicSkeleton(name)): number {
  const q = query.trim();
  if (!q) return 0;

  if (isArabic(q)) {
    const nq = normalizeArabic(q);
    const nn = normalizeArabic(name);
    if (!nq) return 0;
    if (nn === nq) return 100;
    if (nn.startsWith(nq)) return 80;
    const at = nn.indexOf(nq);
    if (at > 0) return nn[at - 1] === " " ? 60 : 40;
    const noArticle = nq.replace(new RegExp(`(^|\\s)${AL}`, "g"), "$1");
    if (noArticle !== nq && nn.includes(noArticle)) return 35;
    return 0;
  }

  const tokens = latinTokens(q);
  if (!tokens.length) return 0;
  let score = 0;
  let lastIdx = -1;
  let ordered = true;
  for (const t of tokens) {
    const exactIdx = nameSk.words.findIndex((w) => sameWord(w, t.full));
    const idx =
      exactIdx >= 0
        ? exactIdx
        : nameSk.words.findIndex((w) => w.startsWith(t.full) || (t.bare.length >= 2 && stripWY(w).startsWith(t.bare)));
    // A bare consonant match (long vowels ignored) on a whole word counts as exact.
    const bareExact = exactIdx < 0 && idx >= 0 && t.bare.length >= 3 && stripWY(nameSk.words[idx]) === t.bare;
    if (exactIdx >= 0 || bareExact) score += 20;
    else if (idx >= 0) score += 10;
    else if (t.full.length >= 2 && (nameSk.full.includes(t.full) || (t.bare.length >= 2 && nameSk.bare.includes(t.bare)))) score += 3;
    else return 0;
    // Tiebreaker: same vowel/consonant order (majmu -> مجموع, not معجم).
    if (idx >= 0 && t.shapes?.[0] && nameSk.shapes?.[idx]) {
      const ls = t.shapes[0].replace(/A/g, "");
      const as = nameSk.shapes[idx].replace(/A/g, "");
      if (ls === as || as.startsWith(ls)) score += 3;
    }
    if (idx >= 0) {
      if (idx < lastIdx) ordered = false;
      lastIdx = idx;
    }
  }
  if (ordered) score += 4;
  // Prefer names mostly covered by the query (short exact titles first).
  score += Math.max(0, 6 - Math.max(0, nameSk.words.length - tokens.length));
  return score;
}
