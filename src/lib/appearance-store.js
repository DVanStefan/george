import fs from "fs";
import path from "path";

const DEFAULT_ORG_ID = String(process.env.DEFAULT_ORG_ID || "vancouver").toLowerCase();

function normalizeOrgId(orgId) {
  return String(orgId || DEFAULT_ORG_ID)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || DEFAULT_ORG_ID;
}

function sanitizeHex(value, fallback) {
  const raw = String(value || "").trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(raw)) return raw;
  if (/^[0-9a-f]{6}$/.test(raw)) return `#${raw}`;
  return fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function filePath(cwd, orgId) {
  const org = normalizeOrgId(orgId);
  const dir = org === "vancouver" ? path.join(cwd, "runs", "geo") : path.join(cwd, "runs", "geo", org);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "appearance.json");
}

export const DEFAULT_APPEARANCE = {
  palette: {
    bg: "#f2f6f4",
    card: "#ffffff",
    ink: "#17241d",
    muted: "#5e6f65",
    line: "#d4dfd8",
    accent: "#0f766e",
    accent2: "#1ea399",
    err: "#7f1d1d",
  },
};

export function normalizeAppearance(input) {
  const raw = input && typeof input === "object" ? input : {};
  const base = DEFAULT_APPEARANCE.palette;
  const paletteRaw = raw.palette && typeof raw.palette === "object" ? raw.palette : {};
  return {
    palette: {
      bg: sanitizeHex(paletteRaw.bg, base.bg),
      card: sanitizeHex(paletteRaw.card, base.card),
      ink: sanitizeHex(paletteRaw.ink, base.ink),
      muted: sanitizeHex(paletteRaw.muted, base.muted),
      line: sanitizeHex(paletteRaw.line, base.line),
      accent: sanitizeHex(paletteRaw.accent, base.accent),
      accent2: sanitizeHex(paletteRaw.accent2, base.accent2),
      err: sanitizeHex(paletteRaw.err, base.err),
    },
  };
}

export async function suggestAppearance({ orgId = DEFAULT_ORG_ID, orgName = "" }) {
  const org = normalizeOrgId(orgId);
  const name = String(orgName || org).toLowerCase();
  // Deterministic seed so suggestions are stable per org.
  let seed = 0;
  for (let i = 0; i < name.length; i += 1) seed = (seed * 31 + name.charCodeAt(i)) % 360;
  // Bias Vancouver to brand-adjacent teal.
  const hue = org === "vancouver" ? 173 : seed;
  const accent = `hsl(${hue}, 72%, 31%)`;
  const accent2 = `hsl(${(hue + 14) % 360}, 64%, 45%)`;
  const bg = `hsl(${hue}, 30%, 96%)`;
  const card = "#ffffff";
  const ink = `hsl(${(hue + 170) % 360}, 28%, 14%)`;
  const muted = `hsl(${(hue + 150) % 360}, 12%, 42%)`;
  const line = `hsl(${hue}, 18%, 85%)`;
  const err = "#7f1d1d";
  // Convert HSL strings using browser support fallback is not available server-side,
  // so we map known Vancouver palette directly and use defaults for other orgs.
  if (org === "vancouver") {
    return normalizeAppearance({
      palette: {
        bg: "#eef6f4",
        card: "#ffffff",
        ink: "#10261f",
        muted: "#4f6b60",
        line: "#cfe2da",
        accent: "#006e6d",
        accent2: "#1b9e9a",
        err: "#8a1f1f",
      },
    });
  }
  return normalizeAppearance({
    palette: {
      bg: "#f2f6f4",
      card,
      ink: "#17241d",
      muted: "#5e6f65",
      line: "#d4dfd8",
      accent: "#0f766e",
      accent2: "#1ea399",
      err,
      _debug: { accent, accent2, bg, ink, muted, line },
    },
  });
}

export async function getAppearance({ cwd, orgId = DEFAULT_ORG_ID }) {
  const org = normalizeOrgId(orgId);
  const backend = (process.env.DATA_BACKEND || "file").toLowerCase();
  if (backend === "firestore") {
    try {
      const appMod = await import("firebase-admin/app");
      const dbMod = await import("firebase-admin/firestore");
      const { getApps, initializeApp, applicationDefault } = appMod;
      const { getFirestore } = dbMod;
      if (getApps().length === 0) initializeApp({ credential: applicationDefault() });
      const db = getFirestore();
      const prefix = process.env.FIRESTORE_NAMESPACE || "dv_agent";
      const col = `${prefix}_appearance`;
      const snap = await db.collection(col).doc(org).get();
      if (snap.exists) return { ...normalizeAppearance(snap.data() || {}), orgId: org };
    } catch {
      // Fall through to file.
    }
  }
  const fp = filePath(cwd, org);
  if (fs.existsSync(fp)) {
    try {
      return { ...normalizeAppearance(JSON.parse(fs.readFileSync(fp, "utf8"))), orgId: org };
    } catch {
      // Ignore parse failures and return default.
    }
  }
  return { ...normalizeAppearance(DEFAULT_APPEARANCE), orgId: org };
}

export async function saveAppearance({ cwd, orgId = DEFAULT_ORG_ID, appearance, actor = {} }) {
  const org = normalizeOrgId(orgId);
  const normalized = normalizeAppearance(appearance);
  const stored = {
    ...normalized,
    orgId: org,
    updatedAt: nowIso(),
    updatedBy: String(actor?.email || actor?.userId || "system"),
  };
  const backend = (process.env.DATA_BACKEND || "file").toLowerCase();
  if (backend === "firestore") {
    try {
      const appMod = await import("firebase-admin/app");
      const dbMod = await import("firebase-admin/firestore");
      const { getApps, initializeApp, applicationDefault } = appMod;
      const { getFirestore, FieldValue } = dbMod;
      if (getApps().length === 0) initializeApp({ credential: applicationDefault() });
      const db = getFirestore();
      const prefix = process.env.FIRESTORE_NAMESPACE || "dv_agent";
      const col = `${prefix}_appearance`;
      await db.collection(col).doc(org).set({ ...stored, _ts: FieldValue.serverTimestamp() }, { merge: true });
      return stored;
    } catch {
      // Fall through to file.
    }
  }
  fs.writeFileSync(filePath(cwd, org), JSON.stringify(stored, null, 2), "utf8");
  return stored;
}
