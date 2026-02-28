import fs from "fs";
import path from "path";
import { PATHS } from "../constants.js";
import { appendJsonl, ensureDir, listFilesRecursive, readJsonl, readText } from "./fs.js";
import {
  assertDocumentAllowedByPolicy,
  loadDocumentMetadata,
} from "./classification.js";
import { extractPdfText } from "./pdf-extract.js";

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function chunkText(text, maxChars = 1200) {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = "";
  for (const p of paragraphs) {
    if ((current + "\n\n" + p).length > maxChars) {
      if (current) chunks.push(current.trim());
      current = p;
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
  }
  if (current) {
    chunks.push(current.trim());
  }
  return chunks;
}

function isSupportedFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return [".txt", ".md", ".json", ".csv", ".pdf"].includes(ext);
}

function loadTextForFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pdf") {
    return extractPdfText(filePath);
  }
  return readText(filePath);
}

export function ingestPath({ cwd, policy, inputPath, defaultClassification, approvedForTypeB }) {
  const fullInput = path.resolve(cwd, inputPath);
  const stat = fs.statSync(fullInput);
  const files = stat.isDirectory()
    ? listFilesRecursive(fullInput).filter(isSupportedFile)
    : [fullInput];

  ensureDir(path.join(cwd, PATHS.memoryDir));
  const outputFile = path.join(cwd, PATHS.memoryIndexFile);
  let filesIngested = 0;
  let chunksIngested = 0;
  const failures = [];

  for (const filePath of files) {
    try {
      const size = fs.statSync(filePath).size;
      if (size > (policy.ingestion?.maxBytesPerFile || 600000)) {
        failures.push({
          file: path.relative(cwd, filePath),
          reason: "File exceeds maxBytesPerFile.",
        });
        continue;
      }

      const sidecar = loadDocumentMetadata(filePath);
      const metadata =
        sidecar ||
        (defaultClassification
          ? {
              classification: defaultClassification,
              approvedForTypeB: approvedForTypeB === true,
            }
          : null);

      assertDocumentAllowedByPolicy({ filePath, metadata, policy });

      const text = loadTextForFile(filePath);
      const chunks = chunkText(text);
      const rel = path.relative(cwd, filePath);
      let idx = 0;
      for (const chunk of chunks) {
        const terms = Array.from(new Set(tokenize(chunk))).slice(0, 200);
        appendJsonl(outputFile, {
          id: `${rel}::${idx}`,
          file: rel,
          chunkIndex: idx,
          classification: metadata?.classification || "Unknown",
          content: chunk,
          terms,
          createdAt: new Date().toISOString(),
        });
        idx += 1;
        chunksIngested += 1;
      }
      filesIngested += 1;
    } catch (err) {
      failures.push({
        file: path.relative(cwd, filePath),
        reason: err.message,
      });
    }
  }

  return { filesIngested, chunksIngested, indexFile: PATHS.memoryIndexFile, failures };
}

export function retrieveMemory({ cwd, query, limit = 6 }) {
  const indexFile = path.join(cwd, PATHS.memoryIndexFile);
  const items = readJsonl(indexFile);
  if (items.length === 0) {
    return [];
  }
  const qTokens = new Set(tokenize(query));
  const scored = items
    .map((item) => {
      let score = 0;
      for (const term of item.terms || []) {
        if (qTokens.has(term)) score += 1;
      }
      return { ...item, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored;
}
