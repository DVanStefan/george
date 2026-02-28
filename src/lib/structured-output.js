function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeString(value) {
  return typeof value === "string" ? value : "";
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeBoolean(value) {
  return value === true;
}

function normalizeConfidence(value) {
  const normalized = safeString(value).toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high") {
    return normalized;
  }
  return "medium";
}

function normalizePassFail(value) {
  const normalized = safeString(value).toLowerCase();
  if (normalized === "pass") return "Pass";
  if (normalized === "fail") return "Fail";
  return "N/A";
}

function extractFirstJsonObject(text) {
  const raw = safeString(text).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  return raw.slice(start, end + 1);
}

export function coerceStructuredOutput({ rawText, agent }) {
  const fallback = {
    agentId: agent.id,
    stage: agent.stage,
    summary: safeString(rawText).trim().slice(0, 1000),
    draftResponse: safeString(rawText).trim(),
    programPlan: {
      objective: "",
      kpis: [],
      strategies: [],
      timeline: [],
      dependencies: [],
      assumptions: [],
    },
    workBreakdown: [],
    actions: [],
    budgetEstimate: [],
    metricsSpec: [],
    claims: [],
    requiredFixes: [],
    passFail: "N/A",
    decision: {
      decision: "",
      rationale: "",
      alternatives: "",
      confidence: "medium",
      risks: "",
    },
  };

  const block = extractFirstJsonObject(rawText);
  if (!block) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(block);
    const programPlan = safeObject(parsed.programPlan);
    return {
      agentId: safeString(parsed.agentId) || agent.id,
      stage: safeString(parsed.stage) || agent.stage,
      summary: safeString(parsed.summary),
      draftResponse: safeString(parsed.draftResponse),
      programPlan: {
        objective: safeString(programPlan.objective),
        kpis: safeArray(programPlan.kpis).map((item) => ({
          id: safeString(item?.id),
          name: safeString(item?.name),
          target: safeString(item?.target),
          period: safeString(item?.period),
        })),
        strategies: safeArray(programPlan.strategies).map((item) => ({
          id: safeString(item?.id),
          title: safeString(item?.title),
          description: safeString(item?.description),
          estimatedCost: safeString(item?.estimatedCost),
        })),
        timeline: safeArray(programPlan.timeline).map((item) => ({
          phase: safeString(item?.phase),
          window: safeString(item?.window),
          deliverables: safeArray(item?.deliverables).map((x) => safeString(x)).filter(Boolean),
        })),
        dependencies: safeArray(programPlan.dependencies).map((x) => safeString(x)).filter(Boolean),
        assumptions: safeArray(programPlan.assumptions).map((x) => safeString(x)).filter(Boolean),
      },
      workBreakdown: safeArray(parsed.workBreakdown).map((item) => ({
        taskId: safeString(item?.taskId),
        task: safeString(item?.task),
        ownerRole: safeString(item?.ownerRole),
        dueWindow: safeString(item?.dueWindow),
        status: safeString(item?.status) || "planned",
        requiresApproval: safeBoolean(item?.requiresApproval),
      })),
      actions: safeArray(parsed.actions).map((item) => ({
        action: safeString(item?.action),
        description: safeString(item?.description),
        ownerRole: safeString(item?.ownerRole),
        requiresApproval: safeBoolean(item?.requiresApproval),
        simulationOnly: item?.simulationOnly !== false,
        dueWindow: safeString(item?.dueWindow),
      })),
      budgetEstimate: safeArray(parsed.budgetEstimate).map((item) => ({
        lineItem: safeString(item?.lineItem),
        amountCad: safeString(item?.amountCad),
        notes: safeString(item?.notes),
      })),
      metricsSpec: safeArray(parsed.metricsSpec).map((item) => ({
        metric: safeString(item?.metric),
        definition: safeString(item?.definition),
        cadence: safeString(item?.cadence),
        ownerRole: safeString(item?.ownerRole),
      })),
      claims: safeArray(parsed.claims).map((item) => ({
        claim: safeString(item?.claim),
        citationIds: safeArray(item?.citationIds).map((id) => safeString(id)).filter(Boolean),
        confidence: normalizeConfidence(item?.confidence),
      })),
      requiredFixes: safeArray(parsed.requiredFixes).map((x) => safeString(x)).filter(Boolean),
      passFail: normalizePassFail(parsed.passFail),
      decision: {
        decision: safeString(parsed.decision?.decision),
        rationale: safeString(parsed.decision?.rationale),
        alternatives: safeString(parsed.decision?.alternatives),
        confidence: normalizeConfidence(parsed.decision?.confidence),
        risks: safeString(parsed.decision?.risks),
      },
    };
  } catch {
    return fallback;
  }
}

export function mergeStageSteps(steps, stage) {
  const mergedText = steps
    .map((step) => {
      const text = step.structured.draftResponse || step.structured.summary || step.rawOutput;
      return `[${step.agent.name}] ${text}`.trim();
    })
    .join("\n\n");

  return {
    stage,
    mergedText,
    agentIds: steps.map((s) => s.agent.id),
    requiredFixes: steps.flatMap((s) => s.structured.requiredFixes || []),
    actions: steps.flatMap((s) => s.structured.actions || []),
  };
}

export function extractDecisionFromStructured(structured) {
  return {
    decision: structured?.decision?.decision || "",
    rationale: structured?.decision?.rationale || "",
    alternatives: structured?.decision?.alternatives || "",
    confidence: structured?.decision?.confidence || "",
    risks: structured?.decision?.risks || "",
  };
}

export function formatSourcesForPrompt(sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    return "No web sources available.";
  }
  return sources
    .map((src) => `- [${src.id}] ${src.title || "Untitled"} | ${src.url}`)
    .join("\n");
}
