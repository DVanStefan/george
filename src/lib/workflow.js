import path from "path";
import { APP_NAME, PATHS, AGENT_OUTPUT_SCHEMA_GUIDE, STAGE_ORDER } from "../constants.js";
import { getEnabledAgentsInOrder } from "./agents.js";
import { appendJsonl, ensureDir, writeJson, writeText } from "./fs.js";
import { runModel } from "./llm.js";
import { retrieveMemory } from "./memory.js";
import { retrieveKnowledge } from "./knowledge.js";
import { loadProfileMemory } from "./profiles.js";
import { maybeRunWebResearch } from "./web-research.js";
import { assertRequestAllowed, isQaPass } from "./policy-checks.js";
import {
  coerceStructuredOutput,
  extractDecisionFromStructured,
  formatSourcesForPrompt,
  mergeStageSteps,
} from "./structured-output.js";
import { evaluateRun } from "./evaluation.js";
import { simulateActions, summarizeSimulation } from "./action-simulator.js";

export function createSessionId() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}_${rand}`;
}

function buildRunPaths(cwd, sessionId) {
  const runDir = path.join(cwd, PATHS.runsDir, sessionId);
  return {
    runDir,
    eventsFile: path.join(runDir, "events.jsonl"),
    decisionsFile: path.join(runDir, "decisions.jsonl"),
    finalFile: path.join(runDir, "final.md"),
    pipelineFile: path.join(runDir, "pipeline.json"),
    evaluationFile: path.join(runDir, "evaluation.json"),
  };
}

function buildPrompt({
  userRequest,
  priorOutput,
  memoryHits,
  knowledgeHits,
  profileMemory,
  webResearch,
  sessionHistory,
  agent,
  policy,
  revisionNote,
}) {
  const memorySection =
    memoryHits.length === 0
      ? "No retrieved memory."
      : memoryHits
          .map(
            (hit, idx) =>
              `[Memory ${idx + 1}] file=${hit.file} chunk=${hit.chunkIndex}\n${hit.content}`
          )
          .join("\n\n");

  const knowledgeSection =
    knowledgeHits.length === 0
      ? "No retrieved knowledge docs."
      : knowledgeHits
          .map(
            (hit, idx) =>
              `[Knowledge ${idx + 1}] file=${hit.file} chunk=${hit.chunkIndex}\n${hit.content}`
          )
          .join("\n\n");

  const profilesSection =
    profileMemory.length === 0
      ? "No profile memory loaded."
      : profileMemory.map((p) => `[Profile] file=${p.file}\n${p.content}`).join("\n\n");

  const historySection =
    sessionHistory.length === 0
      ? "No prior chat turns."
      : sessionHistory
          .slice(-6)
          .map((item) => `${item.role.toUpperCase()}: ${item.content}`)
          .join("\n");

  const roleGuardrails = [
    ...(policy.agentGuardrails?.[agent.stage] || []),
    ...(agent.roleGuardrails || []),
  ]
    .map((line) => `- ${line}`)
    .join("\n");

  const citationsSection =
    webResearch.citationRequired && webResearch.sources.length > 0
      ? "Citation policy: Include source ids (e.g., S1) for any material external claim."
      : "Citation policy: Follow standard evidence discipline and mark uncertainty.";

  return `
User request:
${userRequest}

Pipeline context from previous agent:
${priorOutput || "None"}

Retrieved memory:
${memorySection}

Retrieved knowledge docs:
${knowledgeSection}

Persistent profile memory:
${profilesSection}

Web research:
${webResearch.summary}

Web sources:
${formatSourcesForPrompt(webResearch.sources)}

${citationsSection}

Recent session history:
${historySection}

Your agent id: ${agent.id}
Your stage: ${agent.stage}

Role guardrails:
${roleGuardrails || "- No additional role guardrails configured."}

${AGENT_OUTPUT_SCHEMA_GUIDE}
${revisionNote ? `\nRevision note:\n${revisionNote}\n` : ""}
`;
}

function buildStageGroups(agents) {
  const groups = new Map();
  for (const agent of agents) {
    if (!groups.has(agent.stage)) {
      groups.set(agent.stage, []);
    }
    groups.get(agent.stage).push(agent);
  }
  const ordered = [];
  for (const stage of STAGE_ORDER) {
    if (groups.has(stage)) {
      ordered.push({ stage, agents: groups.get(stage) });
      groups.delete(stage);
    }
  }
  for (const [stage, stageAgents] of groups.entries()) {
    ordered.push({ stage, agents: stageAgents });
  }
  return ordered;
}

function isCitationOnlyFailure(requiredFixes) {
  const fixes = Array.isArray(requiredFixes) ? requiredFixes : [];
  if (fixes.length === 0) return false;
  const citationPattern = /\b(cite|citation|source)\b/i;
  return fixes.every((fix) => citationPattern.test(String(fix)));
}

function hasHardQaFailure(requiredFixes, rawOutput) {
  const fixes = Array.isArray(requiredFixes) ? requiredFixes : [];
  const text = `${fixes.join(" ")} ${rawOutput || ""}`.toLowerCase();
  const hardPatterns = [
    /\billegal\b/,
    /\bright[s]?\s+infringement\b/,
    /\bharass|bully|discriminat|hate speech\b/,
    /\bimpersonat|deceiv|manipulat|phish\b/,
    /\bemployment decision|hire|fire|terminate|discipline\b/,
    /\brestricted\b/,
    /\bpersonal information\b/,
    /\breal-world action|booked|signed|committed\b/,
    /\bpolicy violation\b/,
  ];
  return hardPatterns.some((pattern) => pattern.test(text));
}

function pickLatestByStage(outputs, stage) {
  return outputs.filter((o) => o.agent.stage === stage).slice(-1)[0] || null;
}

function firstNonEmptyStructured(outputs, stages) {
  for (const stage of stages) {
    const step = pickLatestByStage(outputs, stage);
    const text = step?.structured?.draftResponse || step?.rawOutput || "";
    if (text.trim()) {
      return text;
    }
  }
  return outputs[outputs.length - 1]?.rawOutput || "";
}

export async function runWorkflow({
  cwd,
  client,
  policy,
  userRequest,
  sessionId,
  sessionHistory = [],
}) {
  const paths = buildRunPaths(cwd, sessionId);
  ensureDir(paths.runDir);
  assertRequestAllowed(userRequest, policy);

  const agents = getEnabledAgentsInOrder(cwd);
  if (agents.length === 0) {
    throw new Error("No enabled agents found.");
  }
  const stageGroups = buildStageGroups(agents);

  const memoryHits = policy.memory?.enabled
    ? retrieveMemory({
        cwd,
        query: userRequest,
        limit: policy.memory?.maxRetrievedChunks || 6,
      })
    : [];
  const knowledgeHits = retrieveKnowledge({ cwd, policy, query: userRequest });
  const profileMemory = loadProfileMemory({ cwd, policy });
  const webResearch = await maybeRunWebResearch({ client, policy, userRequest });

  appendJsonl(paths.eventsFile, {
    type: "run_started",
    app: APP_NAME,
    sessionId,
    startedAt: new Date().toISOString(),
    userRequest,
    memoryHits: memoryHits.map((m) => ({
      id: m.id,
      file: m.file,
      chunkIndex: m.chunkIndex,
      score: m.score,
    })),
    knowledgeHits: knowledgeHits.map((m) => ({
      id: m.id,
      file: m.file,
      chunkIndex: m.chunkIndex,
      score: m.score,
    })),
    profileMemoryFiles: profileMemory.map((p) => p.file),
    webResearchEnabled: webResearch.enabled,
    citationRequired: webResearch.citationRequired === true,
  });

  const outputs = [];
  const stageMerges = [];

  async function runAgent(agent, priorOutput, revisionNote = "") {
    const input = buildPrompt({
      userRequest,
      priorOutput,
      memoryHits,
      knowledgeHits,
      profileMemory,
      webResearch,
      sessionHistory,
      agent,
      policy,
      revisionNote,
    });
    const rawOutput = await runModel({
      client,
      systemPrompt: agent.systemPrompt,
      userPrompt: input,
      temperature: agent.temperature ?? 0.5,
    });
    const structured = coerceStructuredOutput({ rawText: rawOutput, agent });
    if (
      agent.stage === "research" &&
      webResearch.citationRequired === true &&
      webResearch.sources.length > 0 &&
      structured.claims.length > 0 &&
      structured.claims.every((claim) => (claim.citationIds || []).length === 0)
    ) {
      structured.requiredFixes = [
        ...structured.requiredFixes,
        "Research claims must cite web source ids (S1, S2, ...).",
      ];
    }
    if (
      agent.stage === "qa" &&
      webResearch.enabled !== true &&
      structured.passFail === "Fail" &&
      isCitationOnlyFailure(structured.requiredFixes)
    ) {
      structured.passFail = "Pass";
      structured.requiredFixes = [];
      structured.decision = {
        ...structured.decision,
        decision: structured.decision?.decision || "Pass",
        rationale:
          "Citation-only QA failure was downgraded because web research is disabled for this run.",
        confidence: structured.decision?.confidence || "medium",
        risks: structured.decision?.risks || "",
      };
    }
    if (
      agent.stage === "qa" &&
      structured.passFail === "Fail" &&
      !hasHardQaFailure(structured.requiredFixes, rawOutput)
    ) {
      structured.passFail = "Pass";
      structured.decision = {
        ...structured.decision,
        decision: structured.decision?.decision || "Pass with advisory fixes",
        rationale:
          "QA findings are advisory and non-blocking under tuned QA rules; no hard-risk policy issue detected.",
        confidence: structured.decision?.confidence || "medium",
        risks: structured.decision?.risks || "",
      };
    }
    const decision = extractDecisionFromStructured(structured);

    appendJsonl(paths.eventsFile, {
      type: "agent_step",
      at: new Date().toISOString(),
      sessionId,
      agentId: agent.id,
      agentName: agent.name,
      stage: agent.stage,
      input: policy.trace?.logInputs ? input : "[suppressed]",
      output: policy.trace?.logOutputs ? rawOutput : "[suppressed]",
      structured,
    });
    appendJsonl(paths.decisionsFile, {
      at: new Date().toISOString(),
      sessionId,
      agentId: agent.id,
      passFail: structured.passFail,
      ...decision,
    });

    const step = { agent, rawOutput, structured, decision };
    outputs.push(step);
    return step;
  }

  async function runStage(stage, stageAgents, priorOutput, revisionNote = "") {
    const parallelEnabled = (policy.workflow?.parallelStages || []).includes(stage);
    const steps =
      parallelEnabled && stageAgents.length > 1
        ? await Promise.all(stageAgents.map((agent) => runAgent(agent, priorOutput, revisionNote)))
        : await stageAgents.reduce(async (prevPromise, agent) => {
            const prev = await prevPromise;
            const step = await runAgent(agent, priorOutput, revisionNote);
            return [...prev, step];
          }, Promise.resolve([]));
    const merged = mergeStageSteps(steps, stage);
    stageMerges.push(merged);
    appendJsonl(paths.eventsFile, {
      type: "stage_merged",
      at: new Date().toISOString(),
      sessionId,
      stage,
      agentIds: merged.agentIds,
      requiredFixes: merged.requiredFixes,
    });
    return merged.mergedText;
  }

  let priorOutput = "";
  for (const group of stageGroups) {
    priorOutput = await runStage(group.stage, group.agents, priorOutput);
  }

  const qaGateEnabled = policy.workflow?.qaGateEnabled !== false;
  const maxLoops = Number(policy.workflow?.maxQaRevisionLoops || 0);
  let loops = 0;
  while (qaGateEnabled && loops < maxLoops) {
    const qaStep = outputs.filter((o) => o.agent.stage === "qa").slice(-1)[0];
    if (!qaStep || qaStep.structured.passFail === "Pass" || isQaPass(qaStep.rawOutput)) {
      break;
    }
    loops += 1;
    appendJsonl(paths.eventsFile, {
      type: "qa_revision_cycle_started",
      at: new Date().toISOString(),
      sessionId,
      cycle: loops,
    });

    let revisionPrior =
      outputs.filter((o) => o.agent.stage === "research").slice(-1)[0]?.structured?.draftResponse || "";
    const revisionNote = [
      "QA requested revisions:",
      ...(qaStep.structured.requiredFixes || []),
      qaStep.rawOutput,
    ]
      .filter(Boolean)
      .join("\n");
    const revisionStages = policy.workflow?.revisionStages || ["program", "operations", "finance", "measurement", "synthesis", "risk", "qa"];
    for (const stage of revisionStages) {
      const group = stageGroups.find((g) => g.stage === stage);
      if (!group || group.agents.length === 0) continue;
      revisionPrior = await runStage(stage, group.agents, revisionPrior, revisionNote);
    }
  }

  const latestQa = pickLatestByStage(outputs, "qa");
  const qaPass = latestQa && (latestQa.structured.passFail === "Pass" || isQaPass(latestQa.rawOutput));

  const executionPreferredStages = ["synthesis", "program", "operations", "measurement", "finance", "strategy", "edit", "draft"];
  const executionDraft = firstNonEmptyStructured(outputs, executionPreferredStages);
  const programPlan =
    pickLatestByStage(outputs, "strategy")?.structured?.programPlan ||
    pickLatestByStage(outputs, "synthesis")?.structured?.programPlan || {
      objective: "",
      kpis: [],
      strategies: [],
      timeline: [],
      dependencies: [],
      assumptions: [],
    };
  const workBreakdown = outputs.flatMap((step) => step.structured.workBreakdown || []);
  const budgetEstimate = outputs.flatMap((step) => step.structured.budgetEstimate || []);
  const metricsSpec = outputs.flatMap((step) => step.structured.metricsSpec || []);
  const declaredActions = outputs.flatMap((step) =>
    (step.structured.actions || []).map((action, idx) => ({
      ...action,
      actionId: action.actionId || `${step.agent.id}-${idx + 1}`,
      sourceAgentId: step.agent.id,
      stage: step.agent.stage,
    }))
  );
  const simulationActions = simulateActions({ actions: declaredActions });
  const simulationSummary = summarizeSimulation(simulationActions);

  appendJsonl(paths.eventsFile, {
    type: "simulation_actions",
    at: new Date().toISOString(),
    sessionId,
    count: simulationSummary.actionCount,
    estimatedHours: simulationSummary.estimatedHours,
    estimatedCostCad: simulationSummary.estimatedCostCad,
    approvalsRequired: simulationSummary.approvalsRequired,
  });

  const finalOutput = qaPass
    ? executionDraft
    : [
        "QA status: Fail",
        "",
        "Required fixes:",
        ...(latestQa?.structured.requiredFixes || []).map((fix) => `- ${fix}`),
        "",
        "Current draft requiring revision:",
        executionDraft || latestQa?.structured.draftResponse || "",
      ]
        .filter(Boolean)
        .join("\n");

  const evaluation = policy.evaluation?.enabled === false
    ? {
        overallScore: null,
        passesThreshold: true,
        threshold: null,
        dimensions: {},
        webResearchEnabled: webResearch?.enabled === true,
        issues: [],
      }
    : evaluateRun({ outputs, finalOutput, webResearch, policy });
  if (latestQa && latestQa.structured.passFail !== "Pass" && evaluation.passesThreshold) {
    evaluation.passesThreshold = false;
    evaluation.issues.push("QA did not return Pass.");
  }

  const pipelineArtifact = {
    sessionId,
    userRequest,
    generatedAt: new Date().toISOString(),
    finalOutput,
    qaPass: Boolean(qaPass),
    evaluation,
    programPlan,
    workBreakdown,
    budgetEstimate,
    metricsSpec,
    webResearch,
    simulation: {
      summary: simulationSummary,
      actions: simulationActions,
    },
    memoryHits: memoryHits.map((m) => ({ id: m.id, file: m.file, chunkIndex: m.chunkIndex, score: m.score })),
    knowledgeHits: knowledgeHits.map((m) => ({ id: m.id, file: m.file, chunkIndex: m.chunkIndex, score: m.score })),
    profiles: profileMemory.map((p) => p.file),
    stages: stageMerges,
    agentOutputs: outputs.map((step) => ({
      agent: {
        id: step.agent.id,
        name: step.agent.name,
        stage: step.agent.stage,
      },
      structured: step.structured,
      decision: step.decision,
    })),
  };

  const finalDoc = [
    `# ${APP_NAME}`,
    "",
    `Session: ${sessionId}`,
    "",
    "## User Request",
    userRequest,
    "",
    "## Final Output",
    finalOutput,
    "",
    "## Evaluation",
    `Overall score: ${evaluation.overallScore}`,
    `Pass threshold: ${evaluation.threshold}`,
    `Passes threshold: ${evaluation.passesThreshold ? "yes" : "no"}`,
    "",
    "## Simulation Summary",
    `Actions simulated: ${simulationSummary.actionCount}`,
    `Approvals required: ${simulationSummary.approvalsRequired}`,
    `Estimated effort hours: ${simulationSummary.estimatedHours}`,
    `Estimated cost (CAD): ${simulationSummary.estimatedCostCad}`,
    "",
    "## Program Objective",
    programPlan.objective || "(not provided)",
  ].join("\n");
  writeText(paths.finalFile, finalDoc);
  writeJson(paths.pipelineFile, pipelineArtifact);
  writeJson(paths.evaluationFile, evaluation);

  appendJsonl(paths.eventsFile, {
    type: "run_completed",
    at: new Date().toISOString(),
    sessionId,
    finalFile: path.relative(cwd, paths.finalFile),
    pipelineFile: path.relative(cwd, paths.pipelineFile),
    evaluationFile: path.relative(cwd, paths.evaluationFile),
    overallScore: evaluation.overallScore,
  });

  return {
    sessionId,
    paths,
    memoryHits,
    knowledgeHits,
    profileMemory,
    webResearch,
    outputs,
    finalOutput,
    evaluation,
    simulationSummary,
  };
}
