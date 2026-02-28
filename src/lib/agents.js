import path from "path";
import { PATHS, ROOT_GUARDRAILS, DECISION_TEMPLATE, STAGE_ORDER } from "../constants.js";
import { exists, readJson, writeJson } from "./fs.js";

const BROAD_TEAM_AGENTS = [
  {
    id: "intake_orchestrator",
    name: "Intake Orchestrator",
    stage: "intake",
    enabled: true,
    temperature: 0.2,
    roleGuardrails: ["Convert requests into scoped program briefs with explicit constraints."],
    systemPrompt: `${ROOT_GUARDRAILS}
Role: Intake Orchestrator.
Task:
- Translate user goals into a scoped execution brief.
- Define constraints: timeline, budget, stakeholders, dependencies.
- Identify missing inputs as assumptions.
${DECISION_TEMPLATE}`,
  },
  {
    id: "strategy_lead",
    name: "Strategy Lead",
    stage: "strategy",
    enabled: true,
    temperature: 0.3,
    roleGuardrails: ["Propose practical strategies with measurable outcomes."],
    systemPrompt: `${ROOT_GUARDRAILS}
Role: Strategy Lead.
Task:
- Produce a 6-12 month strategic program direction.
- Define objective, KPIs, candidate strategies, and tradeoffs.
- Populate programPlan fields with concrete options.
${DECISION_TEMPLATE}`,
  },
  {
    id: "research_analyst",
    name: "Research Analyst",
    stage: "research",
    enabled: true,
    temperature: 0.2,
    roleGuardrails: [
      "Attach citations for material external claims when sources are available.",
      "Mark unknown facts as needs verification.",
    ],
    systemPrompt: `${ROOT_GUARDRAILS}
Role: Research Analyst.
Task:
- Build a fact base and evidence notes for program decisions.
- Avoid invented statistics; use unknown markers when evidence is missing.
${DECISION_TEMPLATE}`,
  },
  {
    id: "marketing_lead",
    name: "Marketing Strategy Lead",
    stage: "marketing",
    enabled: true,
    temperature: 0.4,
    roleGuardrails: [
      "Produce channel strategy and audience segmentation tied to measurable outcomes.",
    ],
    systemPrompt: `${ROOT_GUARDRAILS}
Role: Marketing Strategy Lead.
Task:
- Convert strategic objectives into market-facing positioning and campaign priorities.
- Define target audiences, messaging pillars, and go-to-market sequencing.
- Populate programPlan, actions, and metricsSpec fields relevant to marketing execution.
${DECISION_TEMPLATE}`,
  },
  {
    id: "media_planner",
    name: "Media Planning Specialist",
    stage: "media",
    enabled: true,
    temperature: 0.3,
    roleGuardrails: [
      "Provide realistic paid/owned/earned media plans with budget assumptions.",
      "Flag any data or vendor dependencies needed before activation.",
    ],
    systemPrompt: `${ROOT_GUARDRAILS}
Role: Media Planning Specialist.
Task:
- Build practical media plans (channel mix, budget ranges, phasing, measurement).
- Provide a flighting framework and KPI mapping by channel.
- Add executable simulation actions for launch prep and optimization cycles.
${DECISION_TEMPLATE}`,
  },
  {
    id: "program_manager",
    name: "Program Manager",
    stage: "program",
    enabled: true,
    temperature: 0.3,
    roleGuardrails: ["Convert strategy into executable work packages and milestones."],
    systemPrompt: `${ROOT_GUARDRAILS}
Role: Program Manager.
Task:
- Create workBreakdown tasks, milestones, dependencies, and execution actions.
- Mark any task requiring real-world commitment as requiresApproval=true and simulationOnly=true.
${DECISION_TEMPLATE}`,
  },
  {
    id: "partnership_ops",
    name: "Partnership Operations",
    stage: "operations",
    enabled: true,
    temperature: 0.4,
    roleGuardrails: ["Simulate partner outreach actions; never claim outreach was actually sent."],
    systemPrompt: `${ROOT_GUARDRAILS}
Role: Partnerships Operations.
Task:
- Design outreach and operational handoff actions.
- Provide simulation actions for partner communications, coordination, and follow-up.
${DECISION_TEMPLATE}`,
  },
  {
    id: "finance_planner",
    name: "Finance Planner",
    stage: "finance",
    enabled: true,
    temperature: 0.2,
    roleGuardrails: ["Provide budget estimates with assumptions and confidence notes."],
    systemPrompt: `${ROOT_GUARDRAILS}
Role: Finance Planner.
Task:
- Produce budgetEstimate line items with assumptions and risk flags.
- Highlight cost drivers and potential savings.
${DECISION_TEMPLATE}`,
  },
  {
    id: "measurement_analyst",
    name: "Measurement Analyst",
    stage: "measurement",
    enabled: true,
    temperature: 0.2,
    roleGuardrails: ["Define measurable KPIs and reporting cadence."],
    systemPrompt: `${ROOT_GUARDRAILS}
Role: Measurement Analyst.
Task:
- Define metricsSpec, baselines, and reporting cadence.
- Provide practical measurement plan and ownership.
${DECISION_TEMPLATE}`,
  },
  {
    id: "synthesis_lead",
    name: "Synthesis Lead",
    stage: "synthesis",
    enabled: true,
    temperature: 0.4,
    roleGuardrails: ["Produce a clear executable program package, not just prose."],
    systemPrompt: `${ROOT_GUARDRAILS}
Role: Synthesis Lead.
Task:
- Combine strategy, program, operations, finance, and measurement into one coherent execution package.
- Keep all actions simulation-only and clearly marked.
${DECISION_TEMPLATE}`,
  },
  {
    id: "risk_reviewer",
    name: "Risk and Compliance Reviewer",
    stage: "risk",
    enabled: true,
    temperature: 0.2,
    roleGuardrails: ["Block policy, legal, and safety risks; propose mitigations."],
    systemPrompt: `${ROOT_GUARDRAILS}
Role: Risk and Compliance Reviewer.
Task:
- Identify legal/compliance/safety risks and mitigations.
- Return pass/fail for risk posture and required fixes.
${DECISION_TEMPLATE}`,
  },
  {
    id: "qa_reviewer",
    name: "QA Gate",
    stage: "qa",
    enabled: true,
    temperature: 0.1,
    roleGuardrails: ["Fail only for hard-risk policy or safety issues; treat minor improvements as advisory."],
    systemPrompt: `${ROOT_GUARDRAILS}
Role: QA Gate.
Task:
- Validate execution readiness, clarity, traceability, and policy safety.
- Return pass/fail with required fixes only for hard blockers.
${DECISION_TEMPLATE}`,
  },
];

export function loadAgents(cwd) {
  const agentsPath = path.join(cwd, PATHS.agentsFile);
  if (!exists(agentsPath)) {
    writeJson(agentsPath, BROAD_TEAM_AGENTS);
  }
  return readJson(agentsPath).map((agent) => ({
    ...agent,
    roleGuardrails: Array.isArray(agent.roleGuardrails) ? agent.roleGuardrails : [],
  }));
}

export function listAgents(cwd) {
  return loadAgents(cwd);
}

export function addAgent(cwd, { id, name, stage, systemPrompt, temperature = 0.5 }) {
  if (!id || !name || !stage || !systemPrompt) {
    throw new Error("Missing required fields. Required: id, name, stage, systemPrompt.");
  }
  const agents = loadAgents(cwd);
  if (agents.some((a) => a.id === id)) {
    throw new Error(`Agent id already exists: ${id}`);
  }
  const next = [...agents, { id, name, stage, enabled: true, systemPrompt, temperature, roleGuardrails: [] }];
  writeJson(path.join(cwd, PATHS.agentsFile), next);
}

export function setAgentEnabled(cwd, id, enabled) {
  const agents = loadAgents(cwd);
  const idx = agents.findIndex((a) => a.id === id);
  if (idx < 0) {
    throw new Error(`Agent not found: ${id}`);
  }
  agents[idx].enabled = enabled;
  writeJson(path.join(cwd, PATHS.agentsFile), agents);
}

export function removeAgent(cwd, id) {
  const agents = loadAgents(cwd);
  if (id === "intake_orchestrator") {
    throw new Error("Cannot remove required agent: intake_orchestrator");
  }
  const next = agents.filter((a) => a.id !== id);
  if (next.length === agents.length) {
    throw new Error(`Agent not found: ${id}`);
  }
  writeJson(path.join(cwd, PATHS.agentsFile), next);
}

export function bootstrapBroadAgentTeam(cwd, { replace = true } = {}) {
  const file = path.join(cwd, PATHS.agentsFile);
  if (replace || !exists(file)) {
    writeJson(file, BROAD_TEAM_AGENTS);
    return { mode: "replaced", count: BROAD_TEAM_AGENTS.length };
  }
  const existing = loadAgents(cwd);
  const byId = new Map(existing.map((agent) => [agent.id, agent]));
  for (const agent of BROAD_TEAM_AGENTS) {
    if (!byId.has(agent.id)) {
      byId.set(agent.id, agent);
    }
  }
  const order = new Map(STAGE_ORDER.map((s, i) => [s, i]));
  const merged = Array.from(byId.values()).sort(
    (a, b) => (order.get(a.stage) ?? 999) - (order.get(b.stage) ?? 999)
  );
  writeJson(file, merged);
  return { mode: "merged", count: merged.length };
}

export function getEnabledAgentsInOrder(cwd) {
  const agents = loadAgents(cwd).filter((a) => a.enabled);
  const order = new Map(STAGE_ORDER.map((s, i) => [s, i]));
  return agents.sort((a, b) => (order.get(a.stage) ?? 999) - (order.get(b.stage) ?? 999));
}
