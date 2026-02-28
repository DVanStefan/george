import path from "path";
import { PATHS } from "../constants.js";
import { appendJsonl, readJsonl } from "./fs.js";

function messagesFile(cwd, sessionId) {
  return path.join(cwd, PATHS.runsDir, sessionId, "messages.jsonl");
}

export function loadSessionMessages(cwd, sessionId) {
  return readJsonl(messagesFile(cwd, sessionId));
}

export function appendSessionMessage(cwd, sessionId, role, content) {
  appendJsonl(messagesFile(cwd, sessionId), {
    at: new Date().toISOString(),
    role,
    content,
  });
}
