import path from "path";
import readline from "readline/promises";
import { stdin as input, stdout as output } from "process";
import { createOpenAIClient } from "./lib/openai-client.js";
import { loadPolicy, assertIngestionAllowed } from "./lib/policy.js";
import { ingestPath } from "./lib/memory.js";
import { addAgent, bootstrapBroadAgentTeam, listAgents, removeAgent, setAgentEnabled } from "./lib/agents.js";
import { createSessionId, runWorkflow } from "./lib/workflow.js";
import { appendSessionMessage, loadSessionMessages } from "./lib/session.js";
import { formatTrace, loadTrace } from "./lib/trace.js";
import { startDashboard } from "./lib/dashboard.js";
import { bootstrapWorkspace } from "./lib/bootstrap.js";
import { exists, readJson } from "./lib/fs.js";

function usage() {
  console.log(`Commands:
  npm run start -- "request"
  npm run chat
  npm run ingest -- data
  npm run ingest -- data --classification "Internal or Confidential" --approvedForTypeB true
  npm run trace -- <session_id>
  npm run evaluate -- <session_id>
  npm run dashboard -- --port 4173
  npm run bootstrap
  npm run agents:bootstrap
  npm run agents:list
  npm run agents:add -- --id web_research --name "Web Research" --stage research --prompt "..."
  npm run agents:enable -- <agent_id>
  npm run agents:disable -- <agent_id>
  npm run agents:remove -- <agent_id>
`);
}

function parseFlagValue(args, name) {
  const idx = args.findIndex((a) => a === `--${name}`);
  if (idx < 0) return "";
  return args[idx + 1] || "";
}

export async function runOneShotFromArgv(argv) {
  const userRequest = argv.slice(2).join(" ").trim();
  if (!userRequest) {
    console.log('Usage: node team.js "Your request here"');
    return;
  }
  const cwd = process.cwd();
  const client = createOpenAIClient();
  const policy = loadPolicy(cwd);
  const sessionId = createSessionId();
  appendSessionMessage(cwd, sessionId, "user", userRequest);
  const sessionHistory = loadSessionMessages(cwd, sessionId);
  const result = await runWorkflow({
    cwd,
    client,
    policy,
    userRequest,
    sessionId,
    sessionHistory,
  });
  appendSessionMessage(cwd, sessionId, "assistant", result.finalOutput);
  printRunResult(result);
}

function printRunResult(result) {
  console.log(`\nSession: ${result.sessionId}`);
  console.log(`Run dir: ${path.relative(process.cwd(), result.paths.runDir)}`);
  console.log(`Memory hits: ${result.memoryHits.length}`);
  console.log(`Knowledge hits: ${result.knowledgeHits.length}`);
  console.log(`Profile memory files: ${result.profileMemory.length}`);
  console.log(`Web research: ${result.webResearch?.enabled ? "enabled" : "disabled"}`);
  if (result.evaluation) {
    console.log(`Overall score: ${result.evaluation.overallScore}`);
    console.log(`Passes threshold: ${result.evaluation.passesThreshold ? "yes" : "no"}`);
  }
  if (result.simulationSummary) {
    console.log(`Sim actions: ${result.simulationSummary.actionCount}`);
    console.log(`Sim cost (CAD): ${result.simulationSummary.estimatedCostCad}`);
  }
  console.log("\n=== FINAL OUTPUT ===\n");
  console.log(result.finalOutput);
  console.log("\n=== AGENT STEPS ===\n");
  for (const step of result.outputs) {
    console.log(`[${step.agent.stage}] ${step.agent.name} (${step.agent.id})`);
    console.log(`Decision: ${step.decision.decision || "(not extracted)"}`);
    console.log(`Confidence: ${step.decision.confidence || "(not extracted)"}`);
    console.log(`Pass/Fail: ${step.structured.passFail || "N/A"}`);
    console.log("");
  }
}

async function runChat() {
  const cwd = process.cwd();
  const client = createOpenAIClient();
  const policy = loadPolicy(cwd);
  const sessionId = createSessionId();
  const rl = readline.createInterface({ input, output });

  console.log(`Interactive chat started. Session: ${sessionId}`);
  console.log(`Type 'exit' to quit.`);

  while (true) {
    let answer;
    try {
      answer = await rl.question("\nYou> ");
    } catch {
      break;
    }
    const userRequest = answer.trim();
    if (!userRequest) continue;
    if (userRequest.toLowerCase() === "exit") break;

    appendSessionMessage(cwd, sessionId, "user", userRequest);
    const sessionHistory = loadSessionMessages(cwd, sessionId);

    const result = await runWorkflow({
      cwd,
      client,
      policy,
      userRequest,
      sessionId,
      sessionHistory,
    });
    appendSessionMessage(cwd, sessionId, "assistant", result.finalOutput);

    console.log("\nAssistant>");
    console.log(result.finalOutput);
    console.log(`\nTrace: runs/${sessionId}/events.jsonl`);
  }

  try {
    rl.close();
  } catch {
    // no-op
  }
}

function runIngest(args) {
  const cwd = process.cwd();
  const policy = loadPolicy(cwd);
  const nonFlags = args.filter((a) => !a.startsWith("--"));
  const target = nonFlags[0] || "data";
  const defaultClassification = parseFlagValue(args, "classification");
  const approvedForTypeB = parseFlagValue(args, "approvedForTypeB").toLowerCase() === "true";
  assertIngestionAllowed({ cwd, policy, targetPath: target });
  const stats = ingestPath({
    cwd,
    policy,
    inputPath: target,
    defaultClassification,
    approvedForTypeB,
  });
  console.log(
    `Ingested ${stats.filesIngested} files and ${stats.chunksIngested} chunks into ${stats.indexFile}`
  );
  if (stats.failures.length > 0) {
    console.log("\nFailures:");
    for (const item of stats.failures) {
      console.log(`- ${item.file}: ${item.reason}`);
    }
  }
}

function runAgentsList() {
  const agents = listAgents(process.cwd());
  for (const a of agents) {
    console.log(
      `${a.id} | ${a.name} | stage=${a.stage} | enabled=${a.enabled} | temp=${a.temperature}`
    );
  }
}

function runAgentsBootstrap(args) {
  const replace = parseFlagValue(args, "replace");
  const result = bootstrapBroadAgentTeam(process.cwd(), { replace: replace !== "false" });
  console.log(`Broad team ${result.mode}. Agent count: ${result.count}`);
}

function runAgentsAdd(args) {
  const id = parseFlagValue(args, "id");
  const name = parseFlagValue(args, "name");
  const stage = parseFlagValue(args, "stage");
  const prompt = parseFlagValue(args, "prompt");
  const tempRaw = parseFlagValue(args, "temperature");
  const temperature = tempRaw ? Number(tempRaw) : 0.5;
  addAgent(process.cwd(), {
    id,
    name,
    stage,
    systemPrompt: prompt,
    temperature,
  });
  console.log(`Added agent ${id}.`);
}

function runAgentsEnable(args) {
  const id = args[0];
  if (!id) {
    throw new Error("Usage: npm run agents:enable -- <agent_id>");
  }
  setAgentEnabled(process.cwd(), id, true);
  console.log(`Enabled agent ${id}.`);
}

function runAgentsDisable(args) {
  const id = args[0];
  if (!id) {
    throw new Error("Usage: npm run agents:disable -- <agent_id>");
  }
  setAgentEnabled(process.cwd(), id, false);
  console.log(`Disabled agent ${id}.`);
}

function runAgentsRemove(args) {
  const id = args[0];
  if (!id) {
    throw new Error("Usage: npm run agents:remove -- <agent_id>");
  }
  removeAgent(process.cwd(), id);
  console.log(`Removed agent ${id}.`);
}

function runTrace(args) {
  const sessionId = args[0];
  if (!sessionId) {
    throw new Error("Usage: npm run trace -- <session_id>");
  }
  const trace = loadTrace(process.cwd(), sessionId);
  console.log(formatTrace(trace));
}

function runEvaluate(args) {
  const sessionId = args[0];
  if (!sessionId) {
    throw new Error("Usage: npm run evaluate -- <session_id>");
  }
  const file = path.join(process.cwd(), "runs", sessionId, "evaluation.json");
  if (!exists(file)) {
    throw new Error(`Missing evaluation file: ${file}`);
  }
  const result = readJson(file);
  console.log(JSON.stringify(result, null, 2));
}

function runDashboard(args) {
  const portRaw = parseFlagValue(args, "port");
  const port = portRaw ? Number(portRaw) : 4173;
  startDashboard({ cwd: process.cwd(), port });
}

function runBootstrap() {
  const result = bootstrapWorkspace(process.cwd());
  if (result.created.length === 0) {
    console.log("Bootstrap complete. No new files were needed.");
    return;
  }
  console.log("Bootstrap complete. Created:");
  for (const file of result.created) {
    console.log(`- ${path.relative(process.cwd(), file)}`);
  }
}

export async function main(argv) {
  const command = argv[2];
  const args = argv.slice(3);

  if (!command) {
    usage();
    return;
  }

  if (command === "run") {
    const userRequest = args.join(" ").trim();
    if (!userRequest) {
      console.log('Usage: npm run start -- "Your request here"');
      return;
    }
    const cwd = process.cwd();
    const client = createOpenAIClient();
    const policy = loadPolicy(cwd);
    const sessionId = createSessionId();
    appendSessionMessage(cwd, sessionId, "user", userRequest);
    const sessionHistory = loadSessionMessages(cwd, sessionId);
    const result = await runWorkflow({
      cwd,
      client,
      policy,
      userRequest,
      sessionId,
      sessionHistory,
    });
    appendSessionMessage(cwd, sessionId, "assistant", result.finalOutput);
    printRunResult(result);
    return;
  }

  if (command === "chat") {
    await runChat();
    return;
  }

  if (command === "ingest") {
    runIngest(args);
    return;
  }

  if (command === "trace") {
    runTrace(args);
    return;
  }

  if (command === "evaluate") {
    runEvaluate(args);
    return;
  }

  if (command === "dashboard") {
    runDashboard(args);
    return;
  }

  if (command === "bootstrap") {
    runBootstrap();
    return;
  }

  if (command === "agents:list") {
    runAgentsList();
    return;
  }

  if (command === "agents:bootstrap") {
    runAgentsBootstrap(args);
    return;
  }

  if (command === "agents:add") {
    runAgentsAdd(args);
    return;
  }
  if (command === "agents:enable") {
    runAgentsEnable(args);
    return;
  }
  if (command === "agents:disable") {
    runAgentsDisable(args);
    return;
  }
  if (command === "agents:remove") {
    runAgentsRemove(args);
    return;
  }

  usage();
}

if (process.argv[1] && process.argv[1].endsWith("cli.js")) {
  main(process.argv).catch((err) => {
    console.error("Command failed:", err.message);
    process.exit(1);
  });
}
