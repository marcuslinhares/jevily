/** Text helpers shared by the tokenizer, the extractor and the pipeline. */

/** Lowercase + strip diacritics, so "ciencia" and "ciencia" match. */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function truncate(s: string, max: number, suffix = "…"): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - suffix.length)).trimEnd() + suffix;
}

const WORD_RE = /\p{L}[\p{L}\p{M}\p{N}'’-]*|\p{N}+/gu;

export function words(s: string): string[] {
  return s.match(WORD_RE) ?? [];
}

/** Rough token count. Good enough for budgeting and chunk sizing. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

// Titles and connectives that end in a period without ending a sentence.
const ABBREVIATIONS = "Mr|Mrs|Ms|Dr|Prof|Sr|Sra|vs|etc|e\\.g|i\\.e|Art|Fig";
// A private-use codepoint, so masking can never collide with real content.
const SENTINEL = "\uE000";

/**
 * Splits text into sentences, keeping abbreviations and decimals intact.
 *
 * Used for chunk boundaries, so it favours not splitting over splitting cleanly:
 * an over-long sentence is a smaller problem than a sentence cut in half.
 */
export function splitSentences(text: string): string[] {
  const masked = text
    .replace(new RegExp(`\\b(${ABBREVIATIONS})\\.`, "gi"), `$1${SENTINEL}`)
    .replace(/(\d)\.(\d)/g, `$1${SENTINEL}$2`);

  const out: string[] = [];
  for (const raw of masked.split(/(?<=[.!?])\s+|\n{2,}/)) {
    const sentence = raw.split(SENTINEL).join(".").trim();
    if (sentence) out.push(sentence);
  }
  return out;
}

/** Clamps a number into [min, max]. */
export function clamp(n: number, min: number, max: number): number {
  return n < min ? min : n > max ? max : n;
}

/** Clamps into [0, 1]. */
export function clamp01(n: number): number {
  return clamp(n, 0, 1);
}

export function round(n: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

const STOPWORD_SOURCE = `
a o as os um uma uns umas de do da dos das em no na nos nas por para pelo pela pelos pelas
com sem sobre entre ate apos ante sob este esta estes estas esse essa esses essas aquele
aquela aqueles aquelas isso isto aquilo qual quais quando onde porque como eu tu voce voces
nos nos vos lhe lhes me te se ja nao sim mas ou e ou seja ser estar ter haver fazer muito
mais menos todo toda todos todas outro outra algo algum alguma cada ainda entao apenas como
deve deve-se quero preciso tal vez logo onde desde atraves mesmo assim depois antes agora
aqui ali la sempre nunca so pelo pela ate mesmo the a an and or but if then else of in on
at to for from by with without about into over under between among during before after
above below up down out off again further once here there when where why how all any both
each few most other some such no nor not only own same so than too very can will just should
now is are was were be been being have has had do does did doing would could may might must
shall it its this that these those i me my we our you your he him his she her they them
their what which who whom as because while against through including within upon toward
`;

export const STOPWORDS = new Set(
  STOPWORD_SOURCE.split(/\s+/).filter((w) => w.length > 0),
);

export function isStopword(term: string): boolean {
  return STOPWORDS.has(term);
}

const PT_MARKERS = new Set([
  "de","que","nao","para","com","uma","por","dos","das","como","mais","mas","foi","voce","sao",
  "seu","sua","ou","os","as","um","isso","esta","ele","ela","nos","ja","muito","quando","onde",
  "porque","qual","pelo","pela","ate","entre","sobre","das","se","nao","e","ou","ao","aos","a",
]);

const EN_MARKERS = new Set([
  "the","of","and","to","in","is","you","that","it","for","on","with","as","are","this","from",
  "at","be","have","has","was","were","what","when","where","which","how","why","not","but",
]);

/**
 * Cheap language guess from function-word frequency. Code-only, zero tokens, and
 * good enough to drive the `language` parameter and a strict language filter.
 */
export function detectLanguage(text: string): string {
  const tokens = fold(text).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "und";
  let pt = 0;
  let en = 0;
  for (const token of tokens) {
    if (PT_MARKERS.has(token)) pt++;
    if (EN_MARKERS.has(token)) en++;
  }
  if (pt === 0 && en === 0) return "und";
  if (pt >= en * 1.2) return "pt";
  if (en >= pt * 1.2) return "en";
  return "und";
}
