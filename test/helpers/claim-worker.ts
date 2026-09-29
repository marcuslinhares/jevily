/**
 * Claims crawl-queue rows in a separate process, for the concurrency test.
 *
 *   npx tsx test/helpers/claim-worker.ts <dbPath> <batch> <iterations>
 *
 * Prints one claimed url per line on stdout. Exists because node:sqlite calls are
 * synchronous, so a race between two claimants cannot be reproduced inside one
 * process: real parallelism is the only way to open the window between the SELECT
 * and the UPDATE in `claimQueue`.
 */

import { Store } from "../../src/store/db.js";

const [dbPath, batch, iterations] = process.argv.slice(2);
if (!dbPath) {
  process.stderr.write("usage: claim-worker <dbPath> <batch> <iterations>\n");
  process.exit(2);
}

const store = new Store(dbPath);
const claimed: string[] = [];
for (let i = 0; i < Number(iterations ?? 1); i++) {
  for (const item of store.claimQueue(Number(batch ?? 1))) claimed.push(item.url);
}
store.close();

process.stdout.write(claimed.join("\n"));
