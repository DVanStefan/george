import { getApps, initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { summarizeBatch } from "./lib/geo-measurement.js";

function isPlaceholderDomain(domain) {
  const d = String(domain || "").toLowerCase().trim();
  return (
    d === "example.com" ||
    d.endsWith(".example.com") ||
    d === "localhost" ||
    d.endsWith(".local")
  );
}

function isPlaceholderUrl(url) {
  try {
    const u = new URL(String(url || ""));
    return isPlaceholderDomain(u.hostname.toLowerCase().replace(/^www\./, ""));
  } catch {
    return false;
  }
}

function cleanSample(sample) {
  const sourceUrls = (Array.isArray(sample?.sourceUrls) ? sample.sourceUrls : [])
    .filter((u) => typeof u === "string" && u.trim() && !isPlaceholderUrl(u));
  const sourceDomains = (Array.isArray(sample?.sourceDomains) ? sample.sourceDomains : [])
    .filter((d) => !isPlaceholderDomain(d));
  return {
    ...sample,
    sourceUrls,
    sourceDomains,
  };
}

async function scrubCollection(db, collectionName) {
  const snap = await db.collection(collectionName).get();
  if (snap.empty) {
    return { collectionName, docsSeen: 0, docsUpdated: 0, samplesChanged: 0 };
  }
  let docsUpdated = 0;
  let samplesChanged = 0;
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const samples = Array.isArray(data.samples) ? data.samples : [];
    if (!samples.length) continue;
    const cleaned = samples.map(cleanSample);
    let changed = false;
    for (let i = 0; i < samples.length; i += 1) {
      const before = JSON.stringify({
        sourceUrls: samples[i]?.sourceUrls || [],
        sourceDomains: samples[i]?.sourceDomains || [],
      });
      const after = JSON.stringify({
        sourceUrls: cleaned[i]?.sourceUrls || [],
        sourceDomains: cleaned[i]?.sourceDomains || [],
      });
      if (before !== after) {
        changed = true;
        samplesChanged += 1;
      }
    }
    if (!changed) continue;
    await doc.ref.set(
      {
        samples: cleaned,
        summary: summarizeBatch(cleaned),
        updatedAt: new Date().toISOString(),
        _ts: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    docsUpdated += 1;
  }
  return { collectionName, docsSeen: snap.size, docsUpdated, samplesChanged };
}

async function main() {
  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault() });
  }
  const db = getFirestore();
  const prefix = process.env.FIRESTORE_NAMESPACE || "dv_agent";
  const collections = [`${prefix}_geo_batches`];
  const allCollections = await db.listCollections();
  for (const c of allCollections) {
    if (c.id.startsWith(`${prefix}_geo_batches_`) && !collections.includes(c.id)) {
      collections.push(c.id);
    }
  }
  const results = [];
  for (const name of collections) {
    results.push(await scrubCollection(db, name));
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ok: true, results }, null, 2));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
