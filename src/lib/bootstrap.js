import path from "path";
import { PATHS } from "../constants.js";
import { ensureDir, exists, writeText } from "./fs.js";

const PROFILE_BRAND_VOICE = `# Brand Voice

Use this file to define desired tone and writing style.
- Confident and practical
- Transparent about uncertainty
- Specific and action oriented
`;

const PROFILE_POSITIONING = `# Positioning

Use this file to define strategic positioning anchors.
- Target audience
- Value proposition
- Differentiators
`;

const KNOWLEDGE_TEMPLATE = `# Internal Knowledge Notes

Add markdown knowledge documents here.
These docs are retrieved at runtime by semantic token overlap.
`;

const PROGRAM_PLAN_SCHEMA = `{
  "run_id": "string",
  "objective": "string",
  "kpis": [
    { "id": "k1", "name": "string", "target": "string", "period": "string" }
  ],
  "strategies": [
    { "id": "s1", "title": "string", "description": "string", "estimatedCost": "string" }
  ],
  "timeline": [
    { "phase": "string", "window": "string", "deliverables": ["string"] }
  ],
  "dependencies": ["string"],
  "assumptions": ["string"]
}
`;

const WBS_SCHEMA = `[
  {
    "taskId": "T1",
    "task": "string",
    "ownerRole": "string",
    "dueWindow": "string",
    "status": "planned",
    "requiresApproval": true
  }
]
`;

const BRAND_ASSET_NOTE = `Place the Destination Vancouver logo file here as:
- assets/destination-vancouver-logo.png

The dashboard loads this file automatically in the header.
`;

function ensureFile(filePath, content, created) {
  if (exists(filePath)) return;
  writeText(filePath, content);
  created.push(filePath);
}

export function bootstrapWorkspace(cwd) {
  const created = [];
  ensureDir(path.join(cwd, "agents"));
  ensureDir(path.join(cwd, "policies"));
  ensureDir(path.join(cwd, "docs"));
  ensureDir(path.join(cwd, "docs", "schemas"));
  ensureDir(path.join(cwd, "assets"));
  ensureDir(path.join(cwd, "data"));
  ensureDir(path.join(cwd, PATHS.memoryDir));
  ensureDir(path.join(cwd, PATHS.profileDir));
  ensureDir(path.join(cwd, PATHS.runsDir));

  ensureFile(path.join(cwd, PATHS.profileDir, "brand_voice.md"), PROFILE_BRAND_VOICE, created);
  ensureFile(path.join(cwd, PATHS.profileDir, "positioning.md"), PROFILE_POSITIONING, created);
  ensureFile(path.join(cwd, "docs", "KNOWLEDGE_NOTES.md"), KNOWLEDGE_TEMPLATE, created);
  ensureFile(path.join(cwd, "docs", "schemas", "program_plan.schema.json"), PROGRAM_PLAN_SCHEMA, created);
  ensureFile(path.join(cwd, "docs", "schemas", "wbs.schema.json"), WBS_SCHEMA, created);
  ensureFile(path.join(cwd, "assets", "README.txt"), BRAND_ASSET_NOTE, created);

  return { created };
}
