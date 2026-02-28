import path from "path";
import { PATHS } from "../constants.js";
import { exists, readText } from "./fs.js";

export function loadProfileMemory({ cwd, policy }) {
  if (!policy.memory?.profilesEnabled) {
    return [];
  }
  const files = policy.memory?.profileFiles || [];
  return files
    .map((fileName) => {
      const filePath = path.join(cwd, PATHS.profileDir, fileName);
      if (!exists(filePath)) return null;
      const content = readText(filePath).trim();
      if (!content) return null;
      return {
        file: path.relative(cwd, filePath),
        content,
      };
    })
    .filter(Boolean);
}

