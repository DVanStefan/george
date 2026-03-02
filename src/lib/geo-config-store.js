import crypto from "crypto";
import fs from "fs";
import path from "path";
import { DEFAULT_PROMPTS } from "./geo-measurement.js";

const DEFAULT_ORG_ID = String(process.env.DEFAULT_ORG_ID || "vancouver").toLowerCase();

function normalizeOrgId(orgId) {
  return String(orgId || DEFAULT_ORG_ID)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || DEFAULT_ORG_ID;
}

function uniq(arr) {
  return [...new Set(arr)];
}

function parseKeywords(value) {
  if (Array.isArray(value)) return uniq(value.map((v) => String(v || "").trim().toLowerCase()).filter(Boolean));
  return uniq(
    String(value || "")
      .split(/[\n,]/g)
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean)
  );
}

function normalizeScoreGuidance(value, fallback = {}) {
  const src = value && typeof value === "object" ? value : fallback;
  const out = {};
  for (const key of ["1", "2", "3", "4", "5"]) {
    const text = String(src?.[key] || "").trim();
    if (text) out[key] = text;
  }
  return out;
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return uniq(
    value
      .map((v) => String(v || "").trim())
      .filter(Boolean)
  );
}

function normalizeCriterionDefinition(rawDefinition, rawDescription, fallbackDefinition, legacyDescription) {
  const def = String(rawDefinition || "").trim();
  const desc = String(rawDescription || "").trim();
  if (def) return def;
  if (desc && desc !== String(legacyDescription || "").trim()) return desc;
  return String(fallbackDefinition || "").trim();
}

function slug(text, fallback = "category") {
  return (
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || fallback
  );
}

function defaultCategoriesFromPrompts() {
  const byId = new Map();
  for (const p of DEFAULT_PROMPTS) {
    const id = slug(p.pillarId || "category");
    const name = String(p.pillarName || p.pillarId || id);
    if (!byId.has(id)) byId.set(id, { id, name });
  }
  return [...byId.values()];
}

function defaultQuestionsFromPrompts() {
  return DEFAULT_PROMPTS.map((p, i) => ({
    id: `q${String(i + 1).padStart(2, "0")}`,
    categoryId: slug(p.pillarId || "category"),
    funnel: ["high", "mid", "low"].includes(String(p.funnel || "").toLowerCase()) ? String(p.funnel).toLowerCase() : "unknown",
    prompt: String(p.prompt || "").trim(),
  }));
}

export const DEFAULT_GEO_CONFIG = {
  version: 1,
  scoringScale: {
    min: 1,
    max: 5,
    rule: "All criteria are scored on a 1-5 scale. Score 1 when Vancouver is not mentioned.",
  },
  qualityCriteria: {
    sentiment: {
      label: "Sentiment",
      description: "How warm, compelling, and emotionally positive is the tone when Vancouver is mentioned?",
      definition: "How warm, compelling, and emotionally positive is the tone when Vancouver is mentioned?",
      scoreGuidance: {
        "5": "Vancouver is mentioned and tone is very warm, vivid, and inviting. Vancouver is framed as inspiring, refreshing, or energizing.",
        "4": "Vancouver is mentioned and tone is positive; Vancouver is recommended but framed more functionally or grouped with peers.",
        "3": "Vancouver is mentioned and tone is neutral or factual; Vancouver is mentioned without emotional pull.",
        "2": "Vancouver is mentioned, but described inaccurately, dismissively, or in a way that conflicts with brand values.",
        "1": "Vancouver is not mentioned.",
      },
      positiveKeywords: ["inspiring", "refreshing", "energizing", "vibrant", "stunning", "excellent", "must-visit"],
      negativeKeywords: ["overrated", "avoid", "boring", "unsafe", "not worth"],
    },
    specificity: {
      label: "Specificity",
      description: "Does the response reference real, specific Vancouver places, neighbourhoods, events, or experiences?",
      definition: "Does the response reference real, specific Vancouver places, neighbourhoods, events, or experiences?",
      scoreGuidance: {
        "5": "Vancouver is mentioned and there are multiple specific and accurate Vancouver references.",
        "4": "Vancouver is mentioned and at least one specific Vancouver place, experience, or neighbourhood is named.",
        "3": "Vancouver is mentioned generally, without concrete detail.",
        "2": "Vancouver is mentioned but information is inaccurate.",
        "1": "Vancouver is not mentioned.",
      },
      knownPlaceKeywords: ["stanley park", "queen elizabeth park", "granville island", "gastown", "yaletown", "kitsilano", "michelin", "capilano"],
    },
    brand_alignment: {
      label: "Brand Alignment",
      description: "How well does the response reflect Destination Vancouver's brand?",
      definition: "How well does the response reflect Destination Vancouver's brand?",
      scoreGuidance: {
        "5": "Vancouver is mentioned and one or more Destination Vancouver brand pillars are clearly reflected.",
        "4": "Vancouver is mentioned and brand themes are touched indirectly.",
        "3": "Vancouver is mentioned, but brand pillars are not evident.",
        "2": "Vancouver is mentioned but themes are misaligned with the brand.",
        "1": "Vancouver is not mentioned.",
      },
      pillarKeywords: ["wellness", "wellbeing", "outdoors", "nature", "culinary", "culture", "arts", "events", "neighbourhood", "fresh"],
    },
  },
  categories: defaultCategoriesFromPrompts(),
  questions: defaultQuestionsFromPrompts(),
};

export function normalizeGeoConfig(input) {
  const raw = input && typeof input === "object" ? input : {};
  const base = JSON.parse(JSON.stringify(DEFAULT_GEO_CONFIG));
  const categoriesRaw = Array.isArray(raw.categories) ? raw.categories : base.categories;
  const categories = [];
  const seenCategoryIds = new Set();
  for (const c of categoriesRaw) {
    const id = slug(c?.id || c?.name || "category");
    const name = String(c?.name || id).trim();
    if (!id || !name || seenCategoryIds.has(id)) continue;
    seenCategoryIds.add(id);
    categories.push({ id, name });
  }
  if (!categories.length) categories.push(...base.categories);
  const categoryIds = new Set(categories.map((c) => c.id));

  const questionsRaw = Array.isArray(raw.questions) ? raw.questions : base.questions;
  const questions = [];
  const seenQuestionIds = new Set();
  let seq = 0;
  for (const q of questionsRaw) {
    const prompt = String(q?.prompt || "").trim();
    if (!prompt) continue;
    seq += 1;
    const id = slug(q?.id || `q${seq}`, `q${seq}`);
    if (seenQuestionIds.has(id)) continue;
    seenQuestionIds.add(id);
    const categoryIdCandidate = slug(q?.categoryId || "");
    const categoryId = categoryIds.has(categoryIdCandidate) ? categoryIdCandidate : categories[0].id;
    const funnel = ["high", "mid", "low"].includes(String(q?.funnel || "").toLowerCase())
      ? String(q.funnel).toLowerCase()
      : "unknown";
    questions.push({ id, categoryId, funnel, prompt });
  }
  if (!questions.length) questions.push(...base.questions);

  const qcRaw = raw.qualityCriteria && typeof raw.qualityCriteria === "object" ? raw.qualityCriteria : {};
  const baseQc = base.qualityCriteria || {};
  const scoringScaleRaw = raw.scoringScale && typeof raw.scoringScale === "object" ? raw.scoringScale : base.scoringScale;
  const scoringScale = {
    min: Math.max(1, Math.min(5, Number(scoringScaleRaw?.min || 1))),
    max: Math.max(1, Math.min(5, Number(scoringScaleRaw?.max || 5))),
    rule: String(scoringScaleRaw?.rule || base.scoringScale.rule || "").trim(),
  };
  const qualityCriteria = {
    sentiment: {
      label: String(qcRaw?.sentiment?.label || baseQc.sentiment.label),
      description: normalizeCriterionDefinition(
        qcRaw?.sentiment?.definition,
        qcRaw?.sentiment?.description,
        baseQc.sentiment.definition || baseQc.sentiment.description,
        "Tone quality when Vancouver is mentioned."
      ),
      definition: normalizeCriterionDefinition(
        qcRaw?.sentiment?.definition,
        qcRaw?.sentiment?.description,
        baseQc.sentiment.definition || baseQc.sentiment.description,
        "Tone quality when Vancouver is mentioned."
      ),
      positiveKeywords: parseKeywords(qcRaw?.sentiment?.positiveKeywords ?? baseQc.sentiment.positiveKeywords),
      negativeKeywords: parseKeywords(qcRaw?.sentiment?.negativeKeywords ?? baseQc.sentiment.negativeKeywords),
      scoreGuidance: normalizeScoreGuidance(qcRaw?.sentiment?.scoreGuidance, baseQc?.sentiment?.scoreGuidance),
      strongPhraseExamples: normalizeStringList(qcRaw?.sentiment?.strongPhraseExamples),
    },
    specificity: {
      label: String(qcRaw?.specificity?.label || baseQc.specificity.label),
      description: normalizeCriterionDefinition(
        qcRaw?.specificity?.definition,
        qcRaw?.specificity?.description,
        baseQc.specificity.definition || baseQc.specificity.description,
        "Presence of specific places/details in response."
      ),
      definition: normalizeCriterionDefinition(
        qcRaw?.specificity?.definition,
        qcRaw?.specificity?.description,
        baseQc.specificity.definition || baseQc.specificity.description,
        "Presence of specific places/details in response."
      ),
      knownPlaceKeywords: parseKeywords(qcRaw?.specificity?.knownPlaceKeywords ?? baseQc.specificity.knownPlaceKeywords),
      scoreGuidance: normalizeScoreGuidance(qcRaw?.specificity?.scoreGuidance, baseQc?.specificity?.scoreGuidance),
    },
    brand_alignment: {
      label: String(qcRaw?.brand_alignment?.label || baseQc.brand_alignment.label),
      description: normalizeCriterionDefinition(
        qcRaw?.brand_alignment?.definition,
        qcRaw?.brand_alignment?.description,
        baseQc.brand_alignment.definition || baseQc.brand_alignment.description,
        "Alignment with strategic brand pillars."
      ),
      definition: normalizeCriterionDefinition(
        qcRaw?.brand_alignment?.definition,
        qcRaw?.brand_alignment?.description,
        baseQc.brand_alignment.definition || baseQc.brand_alignment.description,
        "Alignment with strategic brand pillars."
      ),
      pillarKeywords: parseKeywords(qcRaw?.brand_alignment?.pillarKeywords ?? baseQc.brand_alignment.pillarKeywords),
      brandPillars: normalizeStringList(qcRaw?.brand_alignment?.brandPillars),
      scoreGuidance: normalizeScoreGuidance(qcRaw?.brand_alignment?.scoreGuidance, baseQc?.brand_alignment?.scoreGuidance),
    },
  };

  return {
    version: 1,
    scoringScale,
    qualityCriteria,
    categories,
    questions,
  };
}

function stableOrder(value) {
  if (Array.isArray(value)) return value.map((item) => stableOrder(item));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = stableOrder(value[key]);
  }
  return out;
}

function configHash(config) {
  const canonical = normalizeGeoConfig(config);
  const stable = JSON.stringify(stableOrder(canonical));
  return crypto.createHash("sha256").update(stable).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function versionIdFrom(hash, atIso) {
  const compactTs = String(atIso || nowIso()).replace(/[-:.]/g, "").replace("Z", "Z");
  return `cfg-${compactTs}-${String(hash || "").slice(0, 8)}`;
}

function filePaths(cwd, orgId) {
  const org = normalizeOrgId(orgId || DEFAULT_ORG_ID);
  const dir = org === "vancouver" ? path.join(cwd, "runs", "geo") : path.join(cwd, "runs", "geo", org);
  fs.mkdirSync(dir, { recursive: true });
  return {
    current: path.join(dir, "config.json"),
    versions: path.join(dir, "config.versions.json"),
  };
}

function enrichConfig(raw, orgId) {
  const canonical = normalizeGeoConfig(raw);
  const hash = String(raw?.configHash || "").trim() || configHash(canonical);
  const versionId = String(raw?.configVersionId || "").trim() || "unversioned";
  return {
    ...canonical,
    orgId: normalizeOrgId(orgId),
    configVersionId: versionId,
    configHash: hash,
    updatedAt: String(raw?.updatedAt || raw?.createdAt || ""),
    updatedBy: String(raw?.updatedBy || raw?.createdBy || ""),
  };
}

async function loadFromFirestore(org) {
  const appMod = await import("firebase-admin/app");
  const dbMod = await import("firebase-admin/firestore");
  const { getApps, initializeApp, applicationDefault } = appMod;
  const { getFirestore } = dbMod;
  if (getApps().length === 0) initializeApp({ credential: applicationDefault() });
  const db = getFirestore();
  const prefix = process.env.FIRESTORE_NAMESPACE || "dv_agent";
  const currentCol = `${prefix}_geo_config`;
  const versionsCol = `${prefix}_geo_config_versions`;
  const snap = await db.collection(currentCol).doc(org).get();
  const current = snap.exists ? (snap.data() || null) : null;
  return { db, current, currentCol, versionsCol };
}

function loadFromFile(cwd, org) {
  const fp = filePaths(cwd, org);
  const current = fs.existsSync(fp.current)
    ? JSON.parse(fs.readFileSync(fp.current, "utf8"))
    : null;
  const versions = fs.existsSync(fp.versions)
    ? JSON.parse(fs.readFileSync(fp.versions, "utf8"))
    : [];
  return { ...fp, current, versions: Array.isArray(versions) ? versions : [] };
}

export function promptsFromGeoConfig(cfg) {
  const config = normalizeGeoConfig(cfg);
  const byCategory = new Map(config.categories.map((c) => [c.id, c.name]));
  return config.questions.map((q) => ({
    pillarId: q.categoryId,
    pillarName: byCategory.get(q.categoryId) || q.categoryId,
    funnel: q.funnel || "unknown",
    prompt: q.prompt,
  }));
}

export async function getGeoConfig({ cwd, orgId = DEFAULT_ORG_ID }) {
  const org = normalizeOrgId(orgId);
  const backend = (process.env.DATA_BACKEND || "file").toLowerCase();
  if (backend === "firestore") {
    try {
      const { current } = await loadFromFirestore(org);
      if (current) return enrichConfig(current, org);
    } catch {
      // Fall back to file.
    }
  }
  try {
    const { current } = loadFromFile(cwd, org);
    if (current) return enrichConfig(current, org);
  } catch {
    // Ignore parse/read failures and return defaults.
  }
  return enrichConfig(DEFAULT_GEO_CONFIG, org);
}

export async function listGeoConfigVersions({ cwd, orgId = DEFAULT_ORG_ID, limit = 50 }) {
  const org = normalizeOrgId(orgId);
  const max = Math.max(1, Math.min(200, Number(limit || 50)));
  const backend = (process.env.DATA_BACKEND || "file").toLowerCase();
  if (backend === "firestore") {
    try {
      const { db, versionsCol } = await loadFromFirestore(org);
      const snap = await db.collection(versionsCol).where("orgId", "==", org).orderBy("createdAt", "desc").limit(max).get();
      return snap.docs.map((d) => {
        const v = d.data() || {};
        return {
          versionId: String(v.versionId || d.id),
          configHash: String(v.configHash || ""),
          createdAt: String(v.createdAt || ""),
          createdBy: String(v.createdBy || ""),
        };
      });
    } catch {
      // Fall through to file.
    }
  }
  try {
    const { versions } = loadFromFile(cwd, org);
    return versions
      .slice()
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
      .slice(0, max)
      .map((v) => ({
        versionId: String(v.versionId || ""),
        configHash: String(v.configHash || ""),
        createdAt: String(v.createdAt || ""),
        createdBy: String(v.createdBy || ""),
      }));
  } catch {
    return [];
  }
}

export async function saveGeoConfig({ cwd, orgId = DEFAULT_ORG_ID, config, actor = {} }) {
  const org = normalizeOrgId(orgId);
  const canonical = normalizeGeoConfig(config);
  const nextHash = configHash(canonical);
  const actorLabel = String(actor?.email || actor?.userId || "system");
  const at = nowIso();
  const backend = (process.env.DATA_BACKEND || "file").toLowerCase();

  const current = await getGeoConfig({ cwd, orgId: org });
  const currentHash = String(current?.configHash || "").trim() || configHash(current || DEFAULT_GEO_CONFIG);
  if (currentHash === nextHash) {
    return {
      ...enrichConfig(canonical, org),
      configVersionId: String(current.configVersionId || "unversioned"),
      configHash: nextHash,
      updatedAt: String(current.updatedAt || at),
      updatedBy: String(current.updatedBy || actorLabel),
    };
  }

  const versionId = versionIdFrom(nextHash, at);
  const stored = {
    ...canonical,
    orgId: org,
    configVersionId: versionId,
    configHash: nextHash,
    updatedAt: at,
    updatedBy: actorLabel,
  };
  const versionEntry = {
    versionId,
    orgId: org,
    configHash: nextHash,
    createdAt: at,
    createdBy: actorLabel,
    config: canonical,
  };

  if (backend === "firestore") {
    try {
      const appMod = await import("firebase-admin/app");
      const dbMod = await import("firebase-admin/firestore");
      const { getApps, initializeApp, applicationDefault } = appMod;
      const { getFirestore, FieldValue } = dbMod;
      if (getApps().length === 0) initializeApp({ credential: applicationDefault() });
      const db = getFirestore();
      const prefix = process.env.FIRESTORE_NAMESPACE || "dv_agent";
      const currentCol = `${prefix}_geo_config`;
      const versionsCol = `${prefix}_geo_config_versions`;
      await db.collection(currentCol).doc(org).set(
        {
          ...stored,
          _ts: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      await db.collection(versionsCol).doc(`${org}__${versionId}`).set(
        {
          ...versionEntry,
          _ts: FieldValue.serverTimestamp(),
        },
        { merge: false }
      );
      return stored;
    } catch {
      // Fall back to file.
    }
  }

  const fp = filePaths(cwd, org);
  fs.writeFileSync(fp.current, JSON.stringify(stored, null, 2), "utf8");
  let versions = [];
  if (fs.existsSync(fp.versions)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(fp.versions, "utf8"));
      if (Array.isArray(parsed)) versions = parsed;
    } catch {
      versions = [];
    }
  }
  versions.unshift(versionEntry);
  versions = versions.slice(0, 500);
  fs.writeFileSync(fp.versions, JSON.stringify(versions, null, 2), "utf8");
  return stored;
}
