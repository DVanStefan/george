import fs from "fs";
import path from "path";

function readJsonSafe(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

export function getMetadataPath(filePath) {
  return `${filePath}.meta.json`;
}

export function loadDocumentMetadata(filePath) {
  const metaPath = getMetadataPath(filePath);
  if (!fs.existsSync(metaPath)) {
    return null;
  }
  return readJsonSafe(metaPath);
}

export function assertDocumentAllowedByPolicy({ filePath, metadata, policy }) {
  const clsPolicy = policy.classification || {};
  if (clsPolicy.requireMetadata && !metadata) {
    throw new Error(
      `Missing metadata sidecar for ${path.basename(filePath)}. Expected ${path.basename(getMetadataPath(filePath))}`
    );
  }

  if (!metadata) {
    return;
  }

  const classification = metadata.classification || "Unknown";
  const allowed = new Set(clsPolicy.allowedClassifications || []);
  const blocked = new Set(clsPolicy.blockedClassifications || []);

  if (blocked.has(classification)) {
    throw new Error(
      `Blocked classification for ${path.basename(filePath)}: ${classification}`
    );
  }
  if (allowed.size > 0 && !allowed.has(classification)) {
    throw new Error(
      `Classification not allowed for ${path.basename(filePath)}: ${classification}`
    );
  }

  if (clsPolicy.requireApprovedForTypeB && metadata.approvedForTypeB !== true) {
    throw new Error(
      `Document not approved for Type B tool use: ${path.basename(filePath)}`
    );
  }
}
