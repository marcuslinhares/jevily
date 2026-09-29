/**
 * Tokenizer for the lexical index.
 *
 * Folds diacritics and case so "saude" matches "Saúde", drops stopwords, and
 * applies a deliberately shallow suffix stripper. No external stemmer: the index
 * is a recall stage, and the decision engine handles precision.
 */

import { fold, isStopword, detectLanguage } from "../util/text.js";

export { detectLanguage };

export type Tokenizer = (text: string) => string[];

const SPLIT_RE = /[^\p{L}\p{N}+#._-]+/u;

/** Query-side tokens: keeps quoted phrases, drops stopwords, no stemming surprises. */
export const queryTokens: Tokenizer = (text) => {
  const out: string[] = [];
  for (const phrase of extractQuotedPhrases(text)) {
    for (const t of phrase.split(SPLIT_RE)) {
      const term = normalize(t);
      if (term && !isStopword(term)) out.push(term);
    }
  }
  const stripped = text.replace(/"[^"]*"/g, " ");
  for (const raw of stripped.split(SPLIT_RE)) {
    const term = normalize(raw);
    if (term && !isStopword(term)) out.push(term);
  }
  return out;
};

/** Index-side tokens. */
export const docTokens: Tokenizer = (text) => {
  const out: string[] = [];
  for (const raw of text.split(SPLIT_RE)) {
    const term = normalize(raw);
    if (!term) continue;
    if (term.length > 1 && isStopword(term)) continue;
    out.push(term, stem(term));
  }
  return out.filter((t) => t.length > 0 && t.length <= 40);
};

function normalize(raw: string): string | null {
  const t = fold(raw).replace(/^[._-]+|[._-]+$/g, "");
  if (!t) return null;
  if (t.length > 40) return null;
  return t;
}

/** Quoted phrases, used for exact-match boosting and `exact_match` mode. */
export function extractQuotedPhrases(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/"([^"]{2,120})"/g)) {
    const phrase = m[1]?.trim();
    if (phrase) out.push(phrase);
  }
  return out;
}

/**
 * Light suffix stripping, deliberately conservative.
 *
 * This is a recall aid, not a linguistic stemmer. It folds the endings that
 * reliably collide in pt/en inflected forms and leaves everything else alone,
 * because collapsing distinct words (a false match) costs far more than missing
 * a rare inflection that the decision engine can recover from.
 *
 * Folds: ies→y, ing, ed, plural -s, Portuguese -ção/-ções→-c, -mente, -ções→-ção.
 * Does not attempt: -es after a sibilant, -es/-s on words under 5 characters,
 * or any ending it cannot fold without eating a real letter.
 */
export function stem(term: string): string {
  if (term.length < 5) return term;

  // Portuguese nominalizations, folded to a shared root. Operates on the folded
  // (diacritic-free) form, so "publicações" arrives here as "publicacoes".
  if (term.endsWith("coes") && term.length > 6) return `${term.slice(0, -4)}cao`;
  if (term.endsWith("mente") && term.length > 7) return term.slice(0, -5);
  if (term.endsWith("acoes") && term.length > 7) return term.slice(0, -2);

  if (term.endsWith("ies") && term.length > 5) return `${term.slice(0, -3)}y`;
  if (term.endsWith("ing") && term.length > 5) return term.slice(0, -3);
  if (term.endsWith("ed") && term.length > 5) return term.slice(0, -2);

  // Plural, split by the shape of the stem. The same rule runs on the query and on
  // the document, so both sides always collapse the same way ("indexes" and "index"
  // both land on "index"); the raw token is indexed too, so nothing is lost.
  if (/(?:x|z|s|ch|sh)es$/.test(term) && term.length > 5) return term.slice(0, -2);
  if (term.endsWith("s") && !term.endsWith("ss") && !/[aeiou]s$/.test(term) && term.length > 4) {
    return term.slice(0, -1);
  }
  return term;
}
