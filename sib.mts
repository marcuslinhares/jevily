import { Store } from "./src/store/db.js";
import { IndexManager } from "./src/store/indexer.js";
import { createDecisionService } from "./src/decision/service.js";
import { createEngine } from "./src/decision/index.js";
import { createGenerator } from "./src/llm/generator.js";
import { runSearch } from "./src/pipeline/search.js";
import { citationQuestions } from "./src/decision/questions.js";
import { CORPUS_FACTS } from "./scripts/helpers/corpus-facts.js";
const store = new Store("/tmp/opencode/jevily-corpus");
const index = new IndexManager(store); await index.rebuild();
const decisions = createDecisionService(createEngine());
const generator = createGenerator();
const STATED = 0.6;
let inReturned = 0, inSibling = 0, inPage = 0, nowhere = 0;
const detail: string[] = [];
for (const c of CORPUS_FACTS) {
  const { response } = await runSearch({ store, index, embedder: null, decisions, generator },
    { query:c.query, search_depth:"advanced", max_results:20, topic:"general", time_range:null,
      include_answer:"basic", include_raw_content:false, include_published_date:false,
      filter_by_published_date:false, filter_by_language:false, exact_match:false,
      auto_parameters:false, safe_search:false } as never);
  const best = async (text: string) => {
    const a = await decisions.evaluate("citation", { claim:c.fact, source:{title:"t",text:text.slice(0,1600)} }, citationQuestions());
    return decisions.noul(a, "supported");
  };
  // 1. in the returned chunks
  let b1 = 0; for (const r of response.results) b1 = Math.max(b1, await best(r.content));
  // 2. in a sibling chunk of the same documents (chunks NOT returned)
  const returnedUrls = new Set(response.results.map(r => r.url));
  const sibTexts = store.allDocs().filter(d => returnedUrls.has(d.url))
    .flatMap(d => store.chunksOf(d.url).filter(ch => !response.results.some(r => r.content.includes(ch.text.slice(0,40)))).map(ch => ch.text));
  let b2 = 0; for (const t of sibTexts) b2 = Math.max(b2, await best(t));
  // 3. anywhere in the whole corpus
  let b3 = 0;
  for (const d of store.allDocs()) for (const ch of store.chunksOf(d.url)) {
    b3 = Math.max(b3, await best(ch.text));
    if (b3 >= STATED) break;
  }
  const where = b1 >= STATED ? "returned" : b2 >= STATED ? "SIBLING" : b3 >= STATED ? "elsewhere in corpus" : "NOT IN CORPUS";
  if (b1 >= STATED) inReturned++; else if (b2 >= STATED) inSibling++; else if (b3 >= STATED) inPage++; else nowhere++;
  detail.push(`  ${where.padEnd(20)} ${c.query.slice(0,54)}`);
}
console.log(`\n  fact stated in a RETURNED chunk:      ${inReturned}/${CORPUS_FACTS.length}`);
console.log(`  fact stated in a SIBLING chunk:       ${inSibling}/${CORPUS_FACTS.length}   <- chunk expansion would fix these`);
console.log(`  fact stated elsewhere in the corpus:  ${inPage}/${CORPUS_FACTS.length}`);
console.log(`  fact not in the corpus at all:        ${nowhere}/${CORPUS_FACTS.length}\n`);
for (const d of detail) console.log(d);
store.close();
