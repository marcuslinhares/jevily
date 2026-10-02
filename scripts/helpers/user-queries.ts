/**
 * Queries written by a user, not by the author of this project.
 *
 * Every other labelled set here was written by the same hand that wrote the code, and
 * that has been the standing weakness of the whole measurement effort: four separate
 * times a result on this corpus turned out to be about the labels rather than the
 * system. These five were not.
 *
 * They are in Portuguese against an English index, which makes them cross-lingual
 * tests as well as abstention tests. Two properties no synthesised set had:
 *
 *   - one is answerable from the corpus and needs cross-lingual retrieval to find it;
 *   - four are answerable by the web in general and not by this index at all, which
 *     is exactly the case a search API should refuse rather than guess at.
 *
 * The last one is a false premise, as the first is: draughts and chess are close
 * enough that "xadrez não é pior que damas" is not the naive question it looks like.
 * Both were written the way someone would actually type them, including the missing
 * accent on "pequena" and the question marks.
 */

export interface UserCase {
  query: string;
  /**
   * What a correct response has to do. `fact` names the substance the index must be
   * able to supply; `refuse` means the index has no answer and the response has to
   * say so. `falsePremise` means the premise is wrong and the answer has to correct it.
   */
  expect: "fact" | "refuse" | "falsePremise";
  /** Only for `fact` and `falsePremise`: the substance that has to be conveyed. */
  substance?: string;
  note: string;
}

export const USER_QUERIES: UserCase[] = [
  {
    query: "node js é uma linguagem de programação?",
    expect: "falsePremise",
    substance:
      "Node.js is not a programming language. It is a runtime environment that executes JavaScript; JavaScript is the language.",
    note:
      "The corpus has this, in English, on differences-between-nodejs-and-the-browser. " +
      "Only 2 of the 4 query tokens exist in the index — node and js, both present on " +
      "every page — so lexical retrieval has no signal and the dense channel is the " +
      "only one that can find it.",
  },
  {
    query: "miguel do canal peewee é irmao do leo?",
    expect: "refuse",
    note:
      "A question about a specific person, answerable on the open web and not in a " +
      "Node.js documentation index. The system has no way to know it is missing " +
      "rather than merely unretrieved.",
  },
  {
    query: "beber agua de cabeça para baixo é possivel",
    expect: "refuse",
    note: "Physiology. Nothing in a JavaScript documentation index addresses it.",
  },
  {
    query: "quantos oscars tem a marvel?",
    expect: "refuse",
    note:
      "A number that changes over time, from a studio's filmography. Even in a corpus " +
      "that did cover it, this is the shape of question where an unhedged answer goes " +
      "stale silently.",
  },
  {
    query: "certeza que xadrez não é pior que damas?",
    expect: "falsePremise",
    substance:
      "Draughts is played on a similar board with similar pieces and shares much of chess's strategy, so the two are close rather than one being clearly worse.",
    note:
      "The second false premise. Written as scepticism about a premise that does not " +
      "hold. Nothing in the index answers it, so the correct behaviour is to decline " +
      "rather than to adjudicate chess.",
  },
];

/** The corpus's language, as recorded on every document it indexed. */
export const CORPUS_LANGUAGE = "en";
