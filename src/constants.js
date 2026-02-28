export const APP_NAME = "Destination Vancouver Sim Team";

export const ROOT_GUARDRAILS = `
You are part of a Destination Vancouver simulation team.

Hard constraints:
- Simulation only. Never claim real-world actions were taken.
- Never contact real people, vendors, venues, or organizations.
- Never commit money, contracts, or bookings.
- Label outputs clearly as draft/simulation.
- If a claim may be time-sensitive, mark it as "Needs verification" and include date assumptions.
- Tool classification: Type B AI tool behavior only (data not shared for training).
- Data classification allowed: Public, Internal or Confidential.
- Restricted data is prohibited.
- Do not produce or support illegal activity, rights infringement, discrimination, harassment, deception, or impersonation.
- Do not make employment decisions or recommendations on hiring, retention, promotion, discipline, or termination.
- Outputs must be reviewed critically for bias, inaccuracy, and sensitive-data leakage.
`;

export const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

export const PATHS = {
  agentsFile: "agents/registry.json",
  policyFile: "policies/policy.json",
  runsDir: "runs",
  memoryDir: "memory",
  memoryIndexFile: "memory/index.jsonl",
  profileDir: "memory/profiles",
};

export const DECISION_TEMPLATE = `
Return this section at the end:
Decision:
Rationale:
Alternatives considered:
Confidence: low|medium|high
Risks:
`;

export const STAGE_ORDER = [
  "intake",
  "strategy",
  "research",
  "marketing",
  "media",
  "program",
  "operations",
  "finance",
  "measurement",
  "synthesis",
  "risk",
  "qa",
  "plan",
  "draft",
  "edit",
];

export const AGENT_OUTPUT_SCHEMA_GUIDE = `
Return JSON only with this shape:
{
  "agentId": string,
  "stage": string,
  "summary": string,
  "draftResponse": string,
  "programPlan": {
    "objective": string,
    "kpis": [{"id": string, "name": string, "target": string, "period": string}],
    "strategies": [{"id": string, "title": string, "description": string, "estimatedCost": string}],
    "timeline": [{"phase": string, "window": string, "deliverables": string[]}],
    "dependencies": string[],
    "assumptions": string[]
  },
  "workBreakdown": [
    {
      "taskId": string,
      "task": string,
      "ownerRole": string,
      "dueWindow": string,
      "status": "planned" | "blocked" | "ready",
      "requiresApproval": boolean
    }
  ],
  "actions": [
    {
      "action": string,
      "description": string,
      "ownerRole": string,
      "requiresApproval": boolean,
      "simulationOnly": boolean,
      "dueWindow": string
    }
  ],
  "budgetEstimate": [{"lineItem": string, "amountCad": string, "notes": string}],
  "metricsSpec": [{"metric": string, "definition": string, "cadence": string, "ownerRole": string}],
  "claims": [
    {
      "claim": string,
      "citationIds": string[],
      "confidence": "low" | "medium" | "high"
    }
  ],
  "requiredFixes": string[],
  "passFail": "Pass" | "Fail" | "N/A",
  "decision": {
    "decision": string,
    "rationale": string,
    "alternatives": string,
    "confidence": "low" | "medium" | "high",
    "risks": string
  }
}
If a field is unknown, return an empty string, empty array, or "N/A".
`;
