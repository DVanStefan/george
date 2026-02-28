import fs from "fs";
import path from "path";
import { createOpenAIClient } from "./openai-client.js";

const GEO_DIR = path.join("runs", "geo");
const DEFAULT_ORG_ID = String(process.env.DEFAULT_ORG_ID || "vancouver").toLowerCase();

function normalizeOrgId(orgId) {
  return String(orgId || DEFAULT_ORG_ID)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || DEFAULT_ORG_ID;
}

export const DEFAULT_MARKETS = ["Los Angeles", "Seattle", "Mexico City", "Sydney"];

export const DEFAULT_PROVIDERS = ["chatgpt", "gemini"];

export const DEFAULT_PROMPTS = [
  {
    pillarId: "spring",
    pillarName: "Vancouver is an excellent place to come in Spring",
    funnel: "high",
    prompt: "What are the best cities to visit in Spring?",
  },
  {
    pillarId: "spring",
    pillarName: "Vancouver is an excellent place to come in Spring",
    funnel: "high",
    prompt: "What are the best cities to visit in Spring in North America?",
  },
  {
    pillarId: "spring",
    pillarName: "Vancouver is an excellent place to come in Spring",
    funnel: "high",
    prompt: "Where are the best places to see Cherry Blossoms?",
  },
  {
    pillarId: "spring",
    pillarName: "Vancouver is an excellent place to come in Spring",
    funnel: "mid",
    prompt: "Is Vancouver a nice place to visit in Spring?",
  },
  {
    pillarId: "spring",
    pillarName: "Vancouver is an excellent place to come in Spring",
    funnel: "mid",
    prompt: "What is Vancouver like in Spring?",
  },
  {
    pillarId: "spring",
    pillarName: "Vancouver is an excellent place to come in Spring",
    funnel: "low",
    prompt: "What are the best things to do in Vancouver in Spring?",
  },
  {
    pillarId: "relax",
    pillarName: "Vancouver is a city where you can relax and rejuvenate",
    funnel: "high",
    prompt: "Where can I go on a trip to relax and unwind in North America?",
  },
  {
    pillarId: "relax",
    pillarName: "Vancouver is a city where you can relax and rejuvenate",
    funnel: "high",
    prompt: "What cities are relaxing to visit rather than overwhelming?",
  },
  {
    pillarId: "relax",
    pillarName: "Vancouver is a city where you can relax and rejuvenate",
    funnel: "high",
    prompt: "What cities in North America offer a refreshing, energizing experience?",
  },
  {
    pillarId: "relax",
    pillarName: "Vancouver is a city where you can relax and rejuvenate",
    funnel: "mid",
    prompt: "Is Vancouver a relaxing place to visit?",
  },
  {
    pillarId: "relax",
    pillarName: "Vancouver is a city where you can relax and rejuvenate",
    funnel: "mid",
    prompt: "Is Vancouver a good place to relax?",
  },
  {
    pillarId: "relax",
    pillarName: "Vancouver is a city where you can relax and rejuvenate",
    funnel: "low",
    prompt: "What should I do in Vancouver to relax?",
  },
  {
    pillarId: "culinary",
    pillarName: "Vancouver is a world-class culinary destination",
    funnel: "high",
    prompt: "What are the best food cities in North America?",
  },
  {
    pillarId: "culinary",
    pillarName: "Vancouver is a world-class culinary destination",
    funnel: "high",
    prompt: "I love travelling for food, where should I go?",
  },
  {
    pillarId: "culinary",
    pillarName: "Vancouver is a world-class culinary destination",
    funnel: "high",
    prompt: "What cities are best known for high quality food?",
  },
  {
    pillarId: "culinary",
    pillarName: "Vancouver is a world-class culinary destination",
    funnel: "mid",
    prompt: "Is Vancouver a good destination for food lovers?",
  },
  {
    pillarId: "culinary",
    pillarName: "Vancouver is a world-class culinary destination",
    funnel: "mid",
    prompt: "What kind of food is Vancouver known for?",
  },
  {
    pillarId: "culinary",
    pillarName: "Vancouver is a world-class culinary destination",
    funnel: "low",
    prompt: "What are the best places to eat in Vancouver?",
  },
];

function ensureGeoDir(cwd, orgId = DEFAULT_ORG_ID) {
  const org = normalizeOrgId(orgId);
  const dir = org === "vancouver" ? path.join(cwd, GEO_DIR) : path.join(cwd, GEO_DIR, org);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function extractDomains(urls) {
  const out = [];
  for (const raw of urls || []) {
    try {
      const u = new URL(raw);
      out.push(u.hostname.toLowerCase().replace(/^www\./, ""));
    } catch {
      // Ignore invalid URLs from model output.
    }
  }
  return out;
}

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

function extractJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return {};
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const candidate = raw.slice(first, last + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      return {};
    }
  }
  return {};
}

function normalizeVancouverRank(value) {
  const v = String(value || "").toLowerCase().trim();
  if (v === "top") return "top";
  if (v === "included") return "included";
  if (v === "not_listed") return "not_listed";
  return "unknown";
}

function buildEvaluationPrompt({ question, market }) {
  return `You are evaluating destination recommendation visibility.

User market context: ${market}
Question: ${question}

Respond with valid JSON only using this exact shape:
{
  "answer": "string",
  "vancouverMentioned": true,
  "vancouverRank": "top|included|not_listed|unknown",
  "destinations": [{"name": "string", "rank": 1}],
  "sourceUrls": ["https://publisher-domain.com/article"]
}

Rules:
- Assume the traveler is from the market shown above.
- If Vancouver is the first or best recommendation, use "top".
- If Vancouver is listed but not first, use "included".
- If Vancouver is absent, use "not_listed".
- List up to 10 destination names in ranking order if available.
- Include specific source URLs used for the answer. If unavailable, return [].
- JSON only; no markdown.`;
}

async function runChatGptSample({ client, market, question, openaiModel }) {
  const response = await client.chat.completions.create({
    model: openaiModel,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "You are a measurement assistant. Follow JSON schema exactly and avoid commentary outside JSON.",
      },
      {
        role: "user",
        content: buildEvaluationPrompt({ question, market }),
      },
    ],
  });
  const content = response.choices?.[0]?.message?.content || "";
  return extractJson(content);
}

async function runGeminiSample({ geminiApiKey, market, question, geminiModel }) {
  if (!geminiApiKey) {
    throw new Error("Missing GEMINI_API_KEY for gemini provider.");
  }
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    geminiModel
  )}:generateContent?key=${encodeURIComponent(geminiApiKey)}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      generationConfig: {
        temperature: 0.2,
      },
      contents: [
        {
          parts: [
            {
              text: buildEvaluationPrompt({ question, market }),
            },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${text.slice(0, 200)}`);
  }
  const payload = await res.json();
  const text =
    payload?.candidates?.[0]?.content?.parts
      ?.map((p) => p?.text || "")
      .join("\n")
      .trim() || "";
  return extractJson(text);
}

function normalizeSampleResult({
  provider,
  market,
  promptId,
  pillarId,
  pillarName,
  funnel,
  question,
  repeatIndex,
  model,
  json,
  error,
}) {
  const sourceUrls = Array.isArray(json?.sourceUrls)
    ? json.sourceUrls.filter((x) => typeof x === "string" && x.trim() && !isPlaceholderUrl(x))
    : [];
  const sourceDomains = extractDomains(sourceUrls).filter((d) => !isPlaceholderDomain(d));
  const destinations = Array.isArray(json?.destinations) ? json.destinations : [];
  const vancouverMentioned =
    typeof json?.vancouverMentioned === "boolean"
      ? json.vancouverMentioned
      : JSON.stringify(destinations).toLowerCase().includes("vancouver");
  return {
    provider,
    model,
    market,
    promptId,
    pillarId,
    pillarName,
    funnel,
    question,
    repeatIndex,
    at: new Date().toISOString(),
    answer: String(json?.answer || ""),
    vancouverMentioned,
    vancouverRank: normalizeVancouverRank(json?.vancouverRank),
    destinations,
    sourceUrls,
    sourceDomains,
    error: error ? String(error) : "",
  };
}

function domainLeaderboard(samples, excludeDv) {
  const map = new Map();
  for (const sample of samples) {
    const uniq = new Set(sample.sourceDomains || []);
    for (const domain of uniq) {
      if (excludeDv && (domain.includes("destinationvancouver") || domain.includes("vancouver"))) {
        continue;
      }
      map.set(domain, (map.get(domain) || 0) + 1);
    }
  }
  return [...map.entries()]
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);
}

export function summarizeBatch(samples) {
  const completed = samples.filter((s) => !s.error);
  const total = completed.length;
  const mentioned = completed.filter((s) => s.vancouverMentioned).length;
  const top = completed.filter((s) => s.vancouverRank === "top").length;
  const included = completed.filter((s) => s.vancouverRank === "included").length;
  const byKey = (keys) => {
    const map = new Map();
    for (const s of completed) {
      const key = keys.map((k) => s[k]).join("|");
      const cur = map.get(key) || { n: 0, mention: 0, top: 0 };
      cur.n += 1;
      if (s.vancouverMentioned) cur.mention += 1;
      if (s.vancouverRank === "top") cur.top += 1;
      map.set(key, cur);
    }
    return [...map.entries()].map(([key, value]) => ({
      key,
      sampleCount: value.n,
      mentionRate: value.n ? Number((value.mention / value.n).toFixed(3)) : 0,
      topRate: value.n ? Number((value.top / value.n).toFixed(3)) : 0,
    }));
  };
  return {
    sampleCount: total,
    mentionRate: total ? Number((mentioned / total).toFixed(3)) : 0,
    topRate: total ? Number((top / total).toFixed(3)) : 0,
    includedRate: total ? Number(((top + included) / total).toFixed(3)) : 0,
    sourceLeaderboard: domainLeaderboard(completed, false),
    sourceLeaderboardExcludingDv: domainLeaderboard(completed, true),
    breakdowns: {
      byProviderMarket: byKey(["provider", "market"]),
      byPillarFunnel: byKey(["pillarId", "funnel"]),
      byMarket: byKey(["market"]),
      byProvider: byKey(["provider"]),
    },
  };
}

async function withGeoStore(cwd, orgId = DEFAULT_ORG_ID) {
  const org = normalizeOrgId(orgId);
  const backend = (process.env.DATA_BACKEND || "file").toLowerCase();
  const buildFileStore = () => {
    const dir = ensureGeoDir(cwd, org);
    return {
      mode: "file",
      async list() {
        const files = fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isFile() && e.name.endsWith(".json"))
          .map((e) => path.join(dir, e.name));
        return files
          .map((file) => {
            const data = readJson(file);
            return {
              batchId: data.batchId,
              createdAt: data.createdAt,
              status: data.status,
              geoConfigVersionId: data.geoConfigVersionId || data.config?.geoConfigVersionId || "",
              sampleCount: data.summary?.sampleCount || 0,
              mentionRate: data.summary?.mentionRate || 0,
              topRate: data.summary?.topRate || 0,
            };
          })
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      },
      async get(batchId) {
        const file = path.join(dir, `${batchId}.json`);
        if (!fs.existsSync(file)) return null;
        return readJson(file);
      },
      async set(batchId, value) {
        writeJson(path.join(dir, `${batchId}.json`), value);
        return value;
      },
    };
  };

  if (backend !== "firestore") {
    return buildFileStore();
  }

  const initFirestoreStore = async () => {
    const appMod = await import("firebase-admin/app");
    const dbMod = await import("firebase-admin/firestore");
    const { getApps, initializeApp, applicationDefault } = appMod;
    const { getFirestore, FieldValue } = dbMod;
    if (getApps().length === 0) {
      initializeApp({ credential: applicationDefault() });
    }
    const db = getFirestore();
    const prefix = process.env.FIRESTORE_NAMESPACE || "dv_agent";
    const col = org === "vancouver" ? `${prefix}_geo_batches` : `${prefix}_geo_batches_${org}`;
    const ref = (batchId) => db.collection(col).doc(batchId);
    return {
      mode: "firestore",
      async list() {
        const snap = await db.collection(col).orderBy("createdAt", "desc").limit(100).get();
        return snap.docs.map((doc) => {
          const data = doc.data() || {};
          return {
            batchId: doc.id,
            createdAt: data.createdAt || null,
            status: data.status || "unknown",
            geoConfigVersionId: data.geoConfigVersionId || data.config?.geoConfigVersionId || "",
            sampleCount: data.summary?.sampleCount || 0,
            mentionRate: data.summary?.mentionRate || 0,
            topRate: data.summary?.topRate || 0,
          };
        });
      },
      async get(batchId) {
        const doc = await ref(batchId).get();
        if (!doc.exists) return null;
        const data = doc.data() || {};
        return {
          batchId,
          ...data,
        };
      },
      async set(batchId, value) {
        await ref(batchId).set(
          {
            ...value,
            updatedAt: new Date().toISOString(),
            _ts: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        return value;
      },
    };
  };

  const timeoutMs = Number(process.env.GEO_FIRESTORE_INIT_TIMEOUT_MS || 5000);
  try {
    return await Promise.race([
      initFirestoreStore(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`Firestore init timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch (err) {
    if (process.env.DATA_BACKEND_STRICT === "true") {
      throw new Error(`Failed to initialize GEO Firestore store: ${err.message || String(err)}`);
    }
    return buildFileStore();
  }
}

export async function listGeoBatches(cwd, orgId = DEFAULT_ORG_ID) {
  const store = await withGeoStore(cwd, orgId);
  const timeoutMs = Number(process.env.GEO_FIRESTORE_OP_TIMEOUT_MS || 5000);
  try {
    return await Promise.race([
      store.list(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`GEO list timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch (err) {
    if (process.env.DATA_BACKEND_STRICT === "true" && store.mode === "firestore") {
      throw err;
    }
    return listGeoBatchesFileOnly(cwd, orgId);
  }
}

export async function getGeoBatch(cwd, batchId, orgId = DEFAULT_ORG_ID) {
  const store = await withGeoStore(cwd, orgId);
  const timeoutMs = Number(process.env.GEO_FIRESTORE_OP_TIMEOUT_MS || 5000);
  try {
    return await Promise.race([
      store.get(batchId),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`GEO get timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch (err) {
    if (process.env.DATA_BACKEND_STRICT === "true" && store.mode === "firestore") {
      throw err;
    }
    return getGeoBatchFileOnly(cwd, batchId, orgId);
  }
}

export async function initGeoBatch({ cwd, batchId, config, orgId = DEFAULT_ORG_ID }) {
  const store = await withGeoStore(cwd, orgId);
  const createdAt = new Date().toISOString();
  const data = {
    batchId,
    createdAt,
    status: "running",
    config,
    geoConfigVersionId: String(config?.geoConfigVersionId || ""),
    geoConfigHash: String(config?.geoConfigHash || ""),
    geoConfigSnapshot: config?.geoConfigSnapshot || null,
    progress: {
      completed: 0,
      total: 0,
    },
    samples: [],
    summary: null,
  };
  const timeoutMs = Number(process.env.GEO_FIRESTORE_OP_TIMEOUT_MS || 5000);
  try {
    await Promise.race([
      store.set(batchId, data),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`GEO init timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return data;
  } catch (err) {
    if (process.env.DATA_BACKEND_STRICT === "true" && store.mode === "firestore") {
      throw err;
    }
    return initGeoBatchFileOnly({ cwd, batchId, config, orgId });
  }
}

export async function updateGeoBatch({ cwd, batchId, mutate, orgId = DEFAULT_ORG_ID }) {
  const store = await withGeoStore(cwd, orgId);
  const timeoutMs = Number(process.env.GEO_FIRESTORE_OP_TIMEOUT_MS || 5000);
  try {
    const current = (await Promise.race([
      store.get(batchId),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`GEO get-for-update timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ])) || {
      batchId,
      createdAt: new Date().toISOString(),
      status: "running",
      config: {},
      progress: { completed: 0, total: 0 },
      samples: [],
      summary: null,
    };
    const next = mutate(current) || current;
    await Promise.race([
      store.set(batchId, next),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`GEO update timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return next;
  } catch (err) {
    if (process.env.DATA_BACKEND_STRICT === "true" && store.mode === "firestore") {
      throw err;
    }
    return updateGeoBatchFileOnly({ cwd, batchId, mutate, orgId });
  }
}

export async function listGeoBatchesFileOnly(cwd, orgId = DEFAULT_ORG_ID) {
  const dir = ensureGeoDir(cwd, orgId);
  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => path.join(dir, e.name));
  const rows = files
    .map((file) => {
      const data = readJson(file);
      return {
        batchId: data.batchId,
        createdAt: data.createdAt,
        status: data.status,
        geoConfigVersionId: data.geoConfigVersionId || data.config?.geoConfigVersionId || "",
        sampleCount: data.summary?.sampleCount || 0,
        mentionRate: data.summary?.mentionRate || 0,
        topRate: data.summary?.topRate || 0,
      };
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return rows;
}

export function getGeoBatchFileOnly(cwd, batchId, orgId = DEFAULT_ORG_ID) {
  const dir = ensureGeoDir(cwd, orgId);
  const file = path.join(dir, `${batchId}.json`);
  if (!fs.existsSync(file)) return null;
  return readJson(file);
}

export function initGeoBatchFileOnly({ cwd, batchId, config, orgId = DEFAULT_ORG_ID }) {
  const dir = ensureGeoDir(cwd, orgId);
  const createdAt = new Date().toISOString();
  const data = {
    batchId,
    createdAt,
    status: "running",
    config,
    geoConfigVersionId: String(config?.geoConfigVersionId || ""),
    geoConfigHash: String(config?.geoConfigHash || ""),
    geoConfigSnapshot: config?.geoConfigSnapshot || null,
    progress: {
      completed: 0,
      total: 0,
    },
    samples: [],
    summary: null,
  };
  writeJson(path.join(dir, `${batchId}.json`), data);
  return data;
}

export function updateGeoBatchFileOnly({ cwd, batchId, mutate, orgId = DEFAULT_ORG_ID }) {
  const dir = ensureGeoDir(cwd, orgId);
  const file = path.join(dir, `${batchId}.json`);
  const current = readJson(file);
  const next = mutate(current) || current;
  writeJson(file, next);
  return next;
}

export async function runGeoBatch({
  cwd,
  config,
  onProgress = () => {},
}) {
  const providers = Array.isArray(config.providers) && config.providers.length > 0
    ? config.providers
    : DEFAULT_PROVIDERS;
  const markets = Array.isArray(config.markets) && config.markets.length > 0 ? config.markets : DEFAULT_MARKETS;
  const prompts = Array.isArray(config.prompts) && config.prompts.length > 0 ? config.prompts : DEFAULT_PROMPTS;
  const repeats = Math.max(1, Number(config.repeats || 2));
  const openaiModel = String(config.openaiModel || process.env.OPENAI_GEO_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini");
  const geminiModel = String(config.geminiModel || process.env.GEMINI_MODEL || "gemini-2.0-flash");
  const geminiApiKey = process.env.GEMINI_API_KEY || "";
  const useOpenAI = providers.includes("chatgpt");
  const client = useOpenAI ? createOpenAIClient() : null;

  const tasks = [];
  let promptCounter = 0;
  for (const prompt of prompts) {
    promptCounter += 1;
    for (const market of markets) {
      for (const provider of providers) {
        for (let repeatIndex = 1; repeatIndex <= repeats; repeatIndex += 1) {
          tasks.push({
            provider,
            market,
            repeatIndex,
            promptId: `p${String(promptCounter).padStart(2, "0")}`,
            pillarId: prompt.pillarId || "custom",
            pillarName: prompt.pillarName || prompt.pillarId || "custom",
            funnel: prompt.funnel || "unknown",
            question: prompt.prompt || "",
          });
        }
      }
    }
  }

  const samples = [];
  onProgress({ completed: 0, total: tasks.length });
  for (let i = 0; i < tasks.length; i += 1) {
    const task = tasks[i];
    let json = {};
    let error = "";
    try {
      if (task.provider === "chatgpt") {
        json = await runChatGptSample({
          client,
          market: task.market,
          question: task.question,
          openaiModel,
        });
      } else if (task.provider === "gemini") {
        json = await runGeminiSample({
          geminiApiKey,
          market: task.market,
          question: task.question,
          geminiModel,
        });
      } else {
        throw new Error(`Unsupported provider: ${task.provider}`);
      }
    } catch (err) {
      error = err.message || String(err);
    }

    samples.push(
      normalizeSampleResult({
        ...task,
        model: task.provider === "chatgpt" ? openaiModel : geminiModel,
        json,
        error,
      })
    );
    onProgress({ completed: i + 1, total: tasks.length });
  }

  return {
    samples,
    summary: summarizeBatch(samples),
  };
}
