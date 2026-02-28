import path from "path";
import { listFilesRecursive, readText } from "./fs.js";

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
  if (current) chunks.push(current.trim());
  return chunks;
}

export function retrieveKnowledge({ cwd, policy, query }) {
  if (!policy.knowledge?.enabled) {
    return [];
  }
  const roots = policy.knowledge?.roots || [];
  const extensions = new Set((policy.knowledge?.includeExtensions || [".md", ".txt"]).map((e) => e.toLowerCase()));
  const allChunks = [];

  for (const root of roots) {
    const fullRoot = path.resolve(cwd, root);
    let files = [];
    try {
      files = listFilesRecursive(fullRoot);
    } catch {
      continue;
    }
    for (const filePath of files) {
      const ext = path.extname(filePath).toLowerCase();
      if (!extensions.has(ext)) continue;
      const rel = path.relative(cwd, filePath);
      const text = readText(filePath);
      const chunks = chunkText(text);
      chunks.forEach((chunk, idx) => {
        allChunks.push({
          id: `${rel}::${idx}`,
          file: rel,
          chunkIndex: idx,
          content: chunk,
          terms: new Set(tokenize(chunk)),
        });
      });
    }
  }

  const queryTerms = new Set(tokenize(query));
  const scored = allChunks
    .map((item) => {
      let score = 0;
      for (const term of item.terms) {
        if (queryTerms.has(term)) score += 1;
      }
      return { ...item, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, policy.knowledge?.maxRetrievedChunks || 4)
    .map((item) => ({
      id: item.id,
      file: item.file,
      chunkIndex: item.chunkIndex,
      content: item.content,
      score: item.score,
    }));

  return scored;
}

