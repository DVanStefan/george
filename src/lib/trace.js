import path from "path";
import { PATHS } from "../constants.js";
import { readJsonl } from "./fs.js";

export function loadTrace(cwd, sessionId) {
  const runDir = path.join(cwd, PATHS.runsDir, sessionId);
  const events = readJsonl(path.join(runDir, "events.jsonl"));
  const decisions = readJsonl(path.join(runDir, "decisions.jsonl"));
  return { events, decisions };
}

export function formatTrace({ events, decisions }) {
  const lines = [];
  lines.push("=== TRACE ===");
  for (const ev of events) {
    if (ev.type === "run_started") {
      lines.push(`Run started: ${ev.startedAt || ev.at}`);
      lines.push(`User request: ${ev.userRequest}`);
      lines.push(`Memory hits: ${(ev.memoryHits || []).length}`);
      continue;
    }
    if (ev.type === "agent_step") {
      lines.push(``);
      lines.push(`[${ev.stage}] ${ev.agentName} (${ev.agentId})`);
      lines.push(`Input:`);
      lines.push(`${ev.input}`);
      lines.push(`Output:`);
      lines.push(`${ev.output}`);
      if (ev.structured) {
        lines.push(`Structured pass/fail: ${ev.structured.passFail || "N/A"}`);
      }
      continue;
    }
    if (ev.type === "stage_merged") {
      lines.push("");
      lines.push(`Stage merged: ${ev.stage}`);
      lines.push(`Agents: ${(ev.agentIds || []).join(", ")}`);
      continue;
    }
    if (ev.type === "simulation_actions") {
      lines.push("");
      lines.push(`Simulation actions: ${ev.count}`);
      lines.push(`Sim effort hours: ${ev.estimatedHours}`);
      lines.push(`Sim cost CAD: ${ev.estimatedCostCad}`);
      lines.push(`Approvals required: ${ev.approvalsRequired}`);
      continue;
    }
    if (ev.type === "run_completed") {
      lines.push("");
      lines.push(`Run completed: ${ev.at}`);
      lines.push(`Final file: ${ev.finalFile}`);
      if (ev.overallScore !== undefined) {
        lines.push(`Overall score: ${ev.overallScore}`);
      }
    }
  }

  lines.push("");
  lines.push("=== DECISIONS ===");
  for (const d of decisions) {
    lines.push("");
    lines.push(`${d.agentId}`);
    lines.push(`Decision: ${d.decision || "(not extracted)"}`);
    lines.push(`Rationale: ${d.rationale || "(not extracted)"}`);
    lines.push(`Alternatives: ${d.alternatives || "(not extracted)"}`);
    lines.push(`Confidence: ${d.confidence || "(not extracted)"}`);
    lines.push(`Risks: ${d.risks || "(not extracted)"}`);
  }

  return lines.join("\n");
}
