import "dotenv/config";
import { randomUUID } from "crypto";
import {
  DEFAULT_MARKETS,
  DEFAULT_PROMPTS,
  DEFAULT_PROVIDERS,
  initGeoBatch,
  runGeoBatch,
  updateGeoBatch,
} from "./lib/geo-measurement.js";
import { getGeoConfig, normalizeGeoConfig, promptsFromGeoConfig } from "./lib/geo-config-store.js";

function parseCsv(value, fallback) {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  const items = raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return items.length ? items : fallback;
}

function parsePrompts(value) {
  const raw = String(value || "").trim();
  if (!raw) return DEFAULT_PROMPTS;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_PROMPTS;
  } catch {
    return DEFAULT_PROMPTS;
  }
}

function compactSamplesForFirestore(samples) {
  return (samples || []).map((s) => ({
    provider: s.provider,
    model: s.model,
    market: s.market,
    promptId: s.promptId,
    pillarId: s.pillarId,
    pillarName: s.pillarName,
    funnel: s.funnel,
    question: s.question,
    repeatIndex: s.repeatIndex,
    at: s.at,
    // Keep enough text for quality heuristics without risking Firestore doc size limits.
    answer: String(s.answer || "").slice(0, 500),
    vancouverMentioned: !!s.vancouverMentioned,
    vancouverRank: s.vancouverRank || "unknown",
    destinations: Array.isArray(s.destinations) ? s.destinations.slice(0, 8) : [],
    sourceUrls: Array.isArray(s.sourceUrls) ? s.sourceUrls.slice(0, 12) : [],
    sourceDomains: Array.isArray(s.sourceDomains) ? s.sourceDomains.slice(0, 12) : [],
    error: s.error || "",
  }));
}

async function main() {
  const cwd = process.cwd();
  const orgId = String(process.env.GEO_SCHEDULE_ORG_ID || process.env.DEFAULT_ORG_ID || "vancouver");
  const providers = parseCsv(process.env.GEO_SCHEDULE_PROVIDERS, DEFAULT_PROVIDERS);
  const markets = parseCsv(process.env.GEO_SCHEDULE_MARKETS, DEFAULT_MARKETS);
  const cfg = await getGeoConfig({ cwd, orgId });
  const configPrompts = promptsFromGeoConfig(cfg);
  const prompts = String(process.env.GEO_SCHEDULE_PROMPTS_JSON || "").trim()
    ? parsePrompts(process.env.GEO_SCHEDULE_PROMPTS_JSON)
    : (configPrompts.length ? configPrompts : DEFAULT_PROMPTS);
  const repeats = Math.max(1, Number(process.env.GEO_SCHEDULE_REPEATS || 2));
  const geoConfigSnapshot = normalizeGeoConfig(cfg);
  const config = {
    providers,
    markets,
    prompts,
    repeats,
    openaiModel: process.env.OPENAI_GEO_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
    geminiModel: process.env.GEMINI_MODEL || "gemini-2.0-flash",
    geoConfigVersionId: String(cfg?.configVersionId || "unversioned"),
    geoConfigHash: String(cfg?.configHash || ""),
    geoConfigSnapshot,
  };

  const batchId = `geo-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  console.log(`Starting scheduled GEO batch: ${batchId}`);
  console.log(
    `Config providers=${providers.join(",")} markets=${markets.join(",")} repeats=${repeats} prompts=${prompts.length}`
  );

  await initGeoBatch({ cwd, batchId, config, orgId });
  try {
    const result = await runGeoBatch({
      cwd,
      config,
      onProgress: async (progress) => {
        console.log(`Progress ${progress.completed || 0}/${progress.total || 0}`);
        await updateGeoBatch({
          cwd,
          batchId,
          orgId,
          mutate: (batch) => ({
            ...batch,
            progress,
          }),
        });
      },
    });

    const persistedSamples = compactSamplesForFirestore(result.samples);
    await updateGeoBatch({
      cwd,
      batchId,
      orgId,
      mutate: (batch) => ({
        ...batch,
        status: "done",
        progress: {
          completed: result.samples.length,
          total: result.samples.length,
        },
        samples: persistedSamples,
        summary: result.summary,
        completedAt: new Date().toISOString(),
      }),
    });

    console.log(
      `Completed GEO batch ${batchId} sampleCount=${result.samples.length} mentionRate=${result.summary?.mentionRate || 0} topRate=${result.summary?.topRate || 0}`
    );
  } catch (err) {
    await updateGeoBatch({
      cwd,
      batchId,
      orgId,
      mutate: (batch) => ({
        ...batch,
        status: "failed",
        lastError: err?.message || String(err),
        completedAt: new Date().toISOString(),
      }),
    });
    throw err;
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 1;
});
