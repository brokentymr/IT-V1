// Add a company from a ticker via Engine 1 (Ingestion/Identity).
// Usage: npm run ingest -- AAPL
import { loadEnv } from "../lib/env";
import { ingestCompany } from "../lib/engines/ingestion";
import { closePool } from "../lib/db/pool";

loadEnv();
const ticker = process.argv[2];
if (!ticker) {
  console.error("usage: npm run ingest -- <TICKER>");
  process.exit(1);
}
try {
  const result = await ingestCompany(ticker);
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await closePool();
}
