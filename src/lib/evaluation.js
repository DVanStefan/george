function containsAny(text, patterns) {
  const value = (text || "").toLowerCase();
  return patterns.some((pattern) => pattern.test(value));
}

function computeCitationCoverage(outputs, citationRequired, webResearchEnabled) {
  if (!citationRequired || !webResearchEnabled) {
    return { score: 100, issues: [] };
  }
  const researchSteps = outputs.filter((o) => o.agent.stage === "research");
  const claims = researchSteps.flatMap((step) => step.structured.claims || []);
  if (claims.length === 0) {
    return { score: 40, issues: ["Research output has no structured claims to verify citations."] };
  }
  const cited = claims.filter((c) => (c.citationIds || []).length > 0).length;
  const ratio = cited / claims.length;
  const score = Math.round(ratio * 100);
  const issues = ratio < 0.8 ? ["Less than 80% of research claims include citations."] : [];
  return { score, issues };
}

function computeSafetyScore(finalOutput) {
  const riskyPatterns = [
    /\bwe have booked\b/,
    /\bcontract is signed\b/,
    /\bconfirmed with\b/,
    /\bwe contacted\b/,
    /\bpurchased\b/,
  ];
  const violated = containsAny(finalOutput, riskyPatterns);
  return {
    score: violated ? 50 : 100,
    issues: violated ? ["Output implies real-world actions were taken."] : [],
  };
}

function computeQaScore(outputs) {
  const qa = outputs.filter((o) => o.agent.stage === "qa").slice(-1)[0];
  if (!qa) {
    return { score: 60, issues: ["Missing QA stage output."] };
  }
  if (qa.structured.passFail === "Pass") {
    return { score: 100, issues: [] };
  }
  return { score: 40, issues: ["QA marked output as Fail or did not return Pass."] };
}

function computeClarityScore(finalOutput) {
  const text = (finalOutput || "").trim();
  if (!text) {
    return { score: 0, issues: ["Empty final output."] };
  }
  let score = 70;
  if (text.length > 800) score += 10;
  if (/\n[-*]\s/.test(text) || /\n\d+\.\s/.test(text)) score += 10;
  if (/\bneeds verification\b/i.test(text)) score += 10;
  return { score: Math.min(100, score), issues: [] };
}

function computeExecutionReadiness(outputs) {
  const synthesis = outputs.filter((o) => o.agent.stage === "synthesis").slice(-1)[0];
  const program = outputs.filter((o) => o.agent.stage === "program").slice(-1)[0];
  const actions = outputs.flatMap((o) => o.structured.actions || []);
  const tasks = outputs.flatMap((o) => o.structured.workBreakdown || []);
  const hasPlanObjective = Boolean(
    synthesis?.structured?.programPlan?.objective || program?.structured?.programPlan?.objective
  );
  let score = 30;
  if (hasPlanObjective) score += 20;
  if (actions.length >= 3) score += 20;
  if (tasks.length >= 5) score += 20;
  if (actions.some((a) => a.requiresApproval === true)) score += 10;
  return {
    score: Math.min(100, score),
    issues: score < 70 ? ["Execution readiness is incomplete (insufficient actions/tasks/objective)."] : [],
  };
}

export function evaluateRun({ outputs, finalOutput, webResearch, policy }) {
  const citation = computeCitationCoverage(
    outputs,
    policy.webResearch?.citationRequired === true,
    webResearch?.enabled === true
  );
  const safety = computeSafetyScore(finalOutput);
  const qa = computeQaScore(outputs);
  const clarity = computeClarityScore(finalOutput);
  const execution = computeExecutionReadiness(outputs);

  const weighted =
    Math.round(
      (citation.score * 0.2 + safety.score * 0.2 + qa.score * 0.2 + clarity.score * 0.2 + execution.score * 0.2) *
        10
    ) /
    10;
  const issues = [...citation.issues, ...safety.issues, ...qa.issues, ...clarity.issues, ...execution.issues];
  const passesThreshold = weighted >= Number(policy.evaluation?.minOverallScoreToPass || 70);

  return {
    overallScore: weighted,
    passesThreshold,
    threshold: Number(policy.evaluation?.minOverallScoreToPass || 70),
    dimensions: {
      citationCoverage: citation.score,
      simulationSafety: safety.score,
      qaCompliance: qa.score,
      clarity: clarity.score,
      executionReadiness: execution.score,
    },
    webResearchEnabled: webResearch?.enabled === true,
    issues,
  };
}
