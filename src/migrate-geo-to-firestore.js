import fs from "fs";
import path from "path";
import process from "process";
import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import "dotenv/config";

const cwd = process.cwd();
const geoDir = path.join(cwd, "runs", "geo");
const prefix = process.env.FIRESTORE_NAMESPACE || "dv_agent";
const collectionName = `${prefix}_geo_batches`;

function readLocalBatches() {
  if (!fs.existsSync(geoDir)) return [];
  return fs
    .readdirSync(geoDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(geoDir, entry.name))
    .map((file) => {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      return {
        batchId: data.batchId,
        data,
        file,
      };
    })
    .filter((row) => row.batchId);
}

async function main() {
  const localBatches = readLocalBatches();
  if (localBatches.length === 0) {
    console.log("No local GEO batch files found in runs/geo.");
    return;
  }

  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault() });
  }
  const db = getFirestore();
  const col = db.collection(collectionName);

  let migrated = 0;
  let failed = 0;
  for (const row of localBatches) {
    try {
      await col.doc(row.batchId).set(
        {
          ...row.data,
          updatedAt: row.data.updatedAt || new Date().toISOString(),
          _ts: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      migrated += 1;
      console.log(`Migrated ${row.batchId}`);
    } catch (err) {
      failed += 1;
      console.error(`Failed ${row.batchId}: ${err.message || String(err)}`);
    }
  }

  console.log(
    `Migration complete. Collection=${collectionName}. Local=${localBatches.length}, Migrated=${migrated}, Failed=${failed}`
  );
}

main().catch((err) => {
  console.error(err.message || String(err));
  process.exitCode = 1;
});
