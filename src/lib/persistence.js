import path from "path";
import fs from "fs";
import { PATHS } from "../constants.js";
import { exists, readJson, readJsonl, readText } from "./fs.js";
import { appendSessionMessage, loadSessionMessages } from "./session.js";

function toIso(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (value?.toDate) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return null;
}

function buildFileStore(cwd) {
  function listSessions() {
    const runsDir = path.join(cwd, PATHS.runsDir);
    if (!exists(runsDir)) return [];
    const entries = fs.readdirSync(runsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    return entries
      .map((entry) => {
        const sessionId = entry.name;
        const runDir = path.join(runsDir, sessionId);
        const evaluationPath = path.join(runDir, "evaluation.json");
        const finalPath = path.join(runDir, "final.md");
        const events = readJsonl(path.join(runDir, "events.jsonl"));
        const messages = readJsonl(path.join(runDir, "messages.jsonl"));
        const started = events.find((e) => e.type === "run_started");
        const completed = events.filter((e) => e.type === "run_completed").slice(-1)[0];
        const latestAssistant = messages.filter((m) => m.role === "assistant").slice(-1)[0]?.content || "";
        return {
          sessionId,
          userRequest: started?.userRequest || "",
          completedAt: completed?.at || null,
          overallScore: exists(evaluationPath) ? readJson(evaluationPath).overallScore : null,
          hasFinal: exists(finalPath),
          latestAssistant,
        };
      })
      .sort((a, b) => String(b.sessionId).localeCompare(String(a.sessionId)));
  }

  function getSessionDetail(sessionId) {
    const runDir = path.join(cwd, PATHS.runsDir, sessionId);
    if (!exists(runDir)) return null;
    const events = readJsonl(path.join(runDir, "events.jsonl"));
    const decisions = readJsonl(path.join(runDir, "decisions.jsonl"));
    const messages = readJsonl(path.join(runDir, "messages.jsonl"));
    const final = exists(path.join(runDir, "final.md")) ? readText(path.join(runDir, "final.md")) : "";
    const evaluation = exists(path.join(runDir, "evaluation.json"))
      ? readJson(path.join(runDir, "evaluation.json"))
      : null;
    const pipeline = exists(path.join(runDir, "pipeline.json"))
      ? readJson(path.join(runDir, "pipeline.json"))
      : null;
    return { sessionId, events, decisions, messages, final, evaluation, pipeline };
  }

  return {
    mode: "file",
    async listSessions() {
      return listSessions();
    },
    async getSessionDetail(sessionId) {
      return getSessionDetail(sessionId);
    },
    async appendMessage(sessionId, role, content) {
      appendSessionMessage(cwd, sessionId, role, content);
    },
    async getSessionHistory(sessionId) {
      return loadSessionMessages(cwd, sessionId);
    },
    async persistRunResult() {
      // File mode already persisted by existing workflow/session modules.
    },
  };
}

async function buildFirestoreStore() {
  const appMod = await import("firebase-admin/app");
  const dbMod = await import("firebase-admin/firestore");
  const { getApps, initializeApp, applicationDefault } = appMod;
  const { getFirestore, FieldValue } = dbMod;

  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault() });
  }
  const db = getFirestore();
  const prefix = process.env.FIRESTORE_NAMESPACE || "dv_agent";
  const sessionsCol = `${prefix}_sessions`;

  function sessionRef(sessionId) {
    return db.collection(sessionsCol).doc(sessionId);
  }

  async function listSessions() {
    const snap = await db.collection(sessionsCol).orderBy("updatedAt", "desc").limit(100).get();
    return snap.docs.map((doc) => {
      const data = doc.data() || {};
      return {
        sessionId: doc.id,
        userRequest: data.userRequest || "",
        completedAt: toIso(data.completedAt),
        overallScore: data.overallScore ?? null,
        hasFinal: Boolean(data.latestFinalOutput),
        latestAssistant: data.latestAssistant || "",
      };
    });
  }

  async function getSessionDetail(sessionId) {
    const ref = sessionRef(sessionId);
    const sessionDoc = await ref.get();
    if (!sessionDoc.exists) return null;
    const sessionData = sessionDoc.data() || {};

    const messagesSnap = await ref.collection("messages").orderBy("at", "asc").limit(500).get();
    const messages = messagesSnap.docs.map((d) => {
      const m = d.data() || {};
      return { at: toIso(m.at), role: m.role || "assistant", content: m.content || "" };
    });

    const runSnap = await ref.collection("runs").orderBy("at", "desc").limit(1).get();
    const latestRun = runSnap.docs[0];
    const runData = latestRun ? latestRun.data() : {};

    const stepsSnap = latestRun
      ? await latestRun.ref.collection("steps").orderBy("idx", "asc").get()
      : { docs: [] };
    const stepDocs = stepsSnap.docs.map((d) => d.data() || {});
    const events = [
      {
        type: "run_started",
        startedAt: toIso(runData.startedAt),
        userRequest: runData.userRequest || sessionData.userRequest || "",
      },
      ...stepDocs.map((s) => ({
        type: "agent_step",
        at: toIso(s.at),
        agentId: s.agentId,
        agentName: s.agentName,
        stage: s.stage,
        input: s.input || "",
        output: s.output || "",
        structured: s.structured || {},
      })),
      {
        type: "run_completed",
        at: toIso(runData.completedAt),
      },
    ];

    const decisions = stepDocs.map((s) => ({
      at: toIso(s.at),
      agentId: s.agentId,
      passFail: s.structured?.passFail || "N/A",
      ...(s.decision || {}),
    }));

    const pipeline = runData.pipeline || null;
    const evaluation = runData.evaluation || null;
    const final = runData.finalOutput || sessionData.latestFinalOutput || "";
    return { sessionId, events, decisions, messages, final, evaluation, pipeline };
  }

  async function appendMessage(sessionId, role, content) {
    const ref = sessionRef(sessionId);
    const now = new Date();
    await ref.set(
      {
        sessionId,
        updatedAt: now,
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await ref.collection("messages").add({
      at: now,
      role,
      content,
    });
  }

  async function getSessionHistory(sessionId) {
    const ref = sessionRef(sessionId);
    const snap = await ref.collection("messages").orderBy("at", "asc").limit(200).get();
    return snap.docs.map((d) => {
      const data = d.data() || {};
      return {
        at: toIso(data.at),
        role: data.role || "assistant",
        content: data.content || "",
      };
    });
  }

  async function persistRunResult({ sessionId, userRequest, result }) {
    const ref = sessionRef(sessionId);
    const now = new Date();
    const runRef = ref.collection("runs").doc(result.sessionId);
    await runRef.set({
      runId: result.sessionId,
      at: now,
      startedAt: now,
      completedAt: now,
      userRequest,
      finalOutput: result.finalOutput,
      evaluation: result.evaluation || null,
      simulationSummary: result.simulationSummary || null,
      webResearch: result.webResearch || null,
      pipeline: {
        sessionId,
        generatedAt: now.toISOString(),
        finalOutput: result.finalOutput,
        qaPass: Boolean(
          result.outputs?.filter((o) => o.agent.stage === "qa").slice(-1)[0]?.structured?.passFail === "Pass"
        ),
        evaluation: result.evaluation || null,
        simulation: {
          summary: result.simulationSummary || null,
        },
        agentOutputs: (result.outputs || []).map((step) => ({
          agent: {
            id: step.agent.id,
            name: step.agent.name,
            stage: step.agent.stage,
          },
          structured: step.structured || {},
          decision: step.decision || {},
        })),
      },
    });

    for (let i = 0; i < (result.outputs || []).length; i += 1) {
      const step = result.outputs[i];
      await runRef.collection("steps").doc(String(i).padStart(3, "0")).set({
        idx: i,
        at: now,
        agentId: step.agent.id,
        agentName: step.agent.name,
        stage: step.agent.stage,
        input: "[stored in trace files]",
        output: step.rawOutput || "",
        structured: step.structured || {},
        decision: step.decision || {},
      });
    }

    await ref.set(
      {
        sessionId,
        userRequest,
        latestAssistant: result.finalOutput,
        latestFinalOutput: result.finalOutput,
        overallScore: result.evaluation?.overallScore ?? null,
        completedAt: now,
        updatedAt: now,
      },
      { merge: true }
    );
  }

  return {
    mode: "firestore",
    listSessions,
    getSessionDetail,
    appendMessage,
    getSessionHistory,
    persistRunResult,
  };
}

export async function createPersistence({ cwd }) {
  const backend = (process.env.DATA_BACKEND || "file").toLowerCase();
  if (backend !== "firestore") {
    return buildFileStore(cwd);
  }
  try {
    return await buildFirestoreStore();
  } catch (err) {
    if (process.env.DATA_BACKEND_STRICT === "true") {
      throw new Error(`Failed to initialize Firestore backend: ${err.message}`);
    }
    return buildFileStore(cwd);
  }
}
