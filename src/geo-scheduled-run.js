import "dotenv/config";
import { runScheduledGeoBatch } from "./lib/geo-scheduled-exec.js";

async function main() {
  await runScheduledGeoBatch({ trigger: "daily" });
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 1;
});
