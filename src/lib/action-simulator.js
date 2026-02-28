function normalizeAction(action, idx) {
  return {
    actionId: action?.actionId || `A${idx + 1}`,
    action: String(action?.action || "").trim(),
    description: String(action?.description || "").trim(),
    ownerRole: String(action?.ownerRole || "").trim(),
    requiresApproval: action?.requiresApproval === true,
    simulationOnly: action?.simulationOnly !== false,
    dueWindow: String(action?.dueWindow || "").trim(),
    sourceAgentId: String(action?.sourceAgentId || "").trim(),
    stage: String(action?.stage || "").trim(),
  };
}

export function simulateActions({ actions }) {
  const normalized = (Array.isArray(actions) ? actions : []).map(normalizeAction);
  return normalized
    .filter((action) => action.action)
    .map((action, idx) => {
      const estimatedHours = action.requiresApproval ? 6 : 3;
      const risk = action.requiresApproval ? "medium" : "low";
      return {
        simulationId: `SIM-${String(idx + 1).padStart(3, "0")}`,
        ...action,
        status: "simulated",
        estimatedHours,
        estimatedCostCad: estimatedHours * 120,
        risk,
        note: action.simulationOnly
          ? "Simulation-only action. No external execution performed."
          : "Action flagged as non-simulation; execution is still blocked by policy.",
      };
    });
}

export function summarizeSimulation(simulationActions) {
  const actions = Array.isArray(simulationActions) ? simulationActions : [];
  const totalCost = actions.reduce((sum, item) => sum + (item.estimatedCostCad || 0), 0);
  const totalHours = actions.reduce((sum, item) => sum + (item.estimatedHours || 0), 0);
  const approvals = actions.filter((item) => item.requiresApproval).length;
  return {
    actionCount: actions.length,
    approvalsRequired: approvals,
    estimatedHours: totalHours,
    estimatedCostCad: totalCost,
  };
}

