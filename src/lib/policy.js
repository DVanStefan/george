import path from "path";
import { PATHS } from "../constants.js";
import { exists, readJson, writeJson } from "./fs.js";

const DEFAULT_POLICY = {
  mode: "local_controlled",
  toolType: "TypeB",
  ingestion: {
    enabled: true,
    allowedRoots: ["data"],
    maxBytesPerFile: 600000,
  },
  classification: {
    requireMetadata: true,
    requireApprovedForTypeB: true,
    allowedClassifications: ["Public", "Internal or Confidential"],
    blockedClassifications: [
      "Restricted",
    ],
  },
  prohibitedUseCases: [
    "illegal_activity",
    "rights_infringement",
    "bullying_harassment_discrimination",
    "deception_or_manipulation",
    "professional_judgment_decisions",
    "employment_decisions",
  ],
  memory: {
    enabled: true,
    maxRetrievedChunks: 6,
    profilesEnabled: true,
    profileFiles: ["brand_voice.md", "positioning.md"],
  },
  knowledge: {
    enabled: true,
    roots: ["docs", "data"],
    includeExtensions: [".md", ".txt"],
    maxRetrievedChunks: 4,
  },
  webResearch: {
    enabled: false,
    model: "gpt-4.1-mini",
    citationRequired: true,
    allowedDomains: [],
  },
  workflow: {
    qaGateEnabled: true,
    maxQaRevisionLoops: 1,
    parallelStages: ["research", "marketing", "media", "operations", "finance", "measurement"],
    revisionStages: [
      "marketing",
      "media",
      "program",
      "operations",
      "finance",
      "measurement",
      "synthesis",
      "risk",
      "qa",
    ],
  },
  agentGuardrails: {
    intake: [
      "Do not skip explicit constraints and assumptions in intake output.",
    ],
    strategy: [
      "Propose at least two viable strategy options with KPI implications.",
    ],
    plan: [
      "Do not invent decisions that imply real-world approvals.",
    ],
    research: [
      "Every external factual claim must include a source citation id when sources are available.",
      "If evidence is missing, mark Unknown - needs verification.",
    ],
    marketing: [
      "Tie campaign recommendations to target audience and measurable outcomes.",
    ],
    media: [
      "Media plans must include channel rationale, budget assumptions, and KPI mapping.",
    ],
    program: [
      "Translate strategy into concrete work breakdown tasks and action objects.",
    ],
    operations: [
      "Actions must stay simulation-only and never imply external outreach happened.",
    ],
    finance: [
      "Budget estimates must include assumptions and uncertainty notes.",
    ],
    measurement: [
      "Metrics must include owner role and reporting cadence.",
    ],
    synthesis: [
      "Produce a cohesive executable package with clear next checkpoints.",
    ],
    risk: [
      "Highlight compliance, legal, and data handling risk clearly.",
    ],
    draft: [
      "Do not present uncertain claims as facts.",
    ],
    edit: [
      "Preserve citations and uncertainty notes.",
    ],
    qa: [
      "Return Fail when uncited material facts are present.",
    ],
  },
  evaluation: {
    enabled: true,
    minOverallScoreToPass: 70,
  },
  trace: {
    logInputs: true,
    logOutputs: true,
  },
};

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isObject(base)) return override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (Array.isArray(value)) {
      out[key] = value.slice();
      continue;
    }
    if (isObject(value) && isObject(out[key])) {
      out[key] = deepMerge(out[key], value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function loadPolicy(cwd) {
  const policyPath = path.join(cwd, PATHS.policyFile);
  if (!exists(policyPath)) {
    writeJson(policyPath, DEFAULT_POLICY);
  }
  const loaded = readJson(policyPath);
  const merged = deepMerge(DEFAULT_POLICY, loaded);
  writeJson(policyPath, merged);
  return merged;
}

export function assertIngestionAllowed({ cwd, policy, targetPath }) {
  if (!policy.ingestion?.enabled) {
    throw new Error("Ingestion blocked by policy (ingestion.enabled=false).");
  }
  const normalized = path.resolve(cwd, targetPath).toLowerCase();
  const allowed = (policy.ingestion.allowedRoots || []).some((root) => {
    const full = path.resolve(cwd, root).toLowerCase();
    return normalized.startsWith(full);
  });
  if (!allowed) {
    throw new Error(
      `Ingestion path not allowed by policy. Allowed roots: ${(policy.ingestion.allowedRoots || []).join(", ")}`
    );
  }
}
