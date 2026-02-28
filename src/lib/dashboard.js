import crypto from "crypto";
import fs from "fs";
import http from "http";
import path from "path";
import { createOpenAIClient } from "./openai-client.js";
import { createPersistence } from "./persistence.js";
import { loadPolicy } from "./policy.js";
import { loadSessionMessages } from "./session.js";
import { getEnabledAgentsInOrder } from "./agents.js";
import { runModel } from "./llm.js";
import { createSessionId, runWorkflow } from "./workflow.js";
import {
  DEFAULT_MARKETS,
  DEFAULT_PROVIDERS,
  getGeoBatch,
  initGeoBatch,
  listGeoBatches,
  runGeoBatch,
  summarizeBatch,
  updateGeoBatch,
} from "./geo-measurement.js";
import { createAuthStore, ensureBootstrapAdmin, getDefaultOrgId, normalizeOrgId, verifyPassword } from "./auth-store.js";
import {
  DEFAULT_GEO_CONFIG,
  getGeoConfig,
  listGeoConfigVersions,
  normalizeGeoConfig,
  promptsFromGeoConfig,
  saveGeoConfig,
} from "./geo-config-store.js";
import { DEFAULT_APPEARANCE, getAppearance, saveAppearance, suggestAppearance } from "./appearance-store.js";

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) reject(new Error("Request body too large."));
    });
    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, value) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(value));
}

function isAuthEnabled() {
  return Boolean(process.env.DASHBOARD_PASSWORD);
}

function validateAuth(req, body) {
  if (!isAuthEnabled()) return true;
  const tokenFromHeader = req.headers["x-dv-auth"];
  const tokenFromBody = body?.authToken;
  const password = process.env.DASHBOARD_PASSWORD;
  return tokenFromHeader === password || tokenFromBody === password;
}

function validateApiKey(req, body) {
  const key = process.env.DASHBOARD_API_KEY || "";
  if (!key) return true;
  return req.headers["x-dv-api-key"] === key || body?.apiKey === key;
}

function isPlaceholderDomain(domain) {
  const d = String(domain || "").toLowerCase().trim();
  return d === "example.com" || d.endsWith(".example.com") || d === "localhost" || d.endsWith(".local");
}

function isPlaceholderUrl(url) {
  try {
    const u = new URL(String(url || ""));
    return isPlaceholderDomain(u.hostname.toLowerCase().replace(/^www\./, ""));
  } catch {
    return false;
  }
}

function parseOrgPath(pathname) {
  const p = String(pathname || "");
  if (p === "/" || p === "/geo") return { orgId: null, kind: "root" };
  const m = p.match(/^\/([a-z0-9_-]+)(?:\/(geo))?\/?$/i);
  if (m) {
    return { orgId: normalizeOrgId(m[1]), kind: "org_home" };
  }
  const i = p.match(/^\/([a-z0-9_-]+)\/invite\/([a-f0-9]{16,})\/?$/i);
  if (i) {
    return { orgId: normalizeOrgId(i[1]), kind: "invite_page", token: i[2] };
  }
  return { orgId: null, kind: "other" };
}

function getBaseAppUrl(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim() || "https";
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost").split(",")[0].trim();
  return `${proto}://${host}`;
}

async function maybeSendInviteEmail({ toEmail, inviteUrl, orgId }) {
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  const from = String(process.env.RESEND_FROM_EMAIL || "").trim();
  if (!apiKey || !from) {
    return { delivered: false, reason: "Email provider not configured." };
  }
  const subject = `You're invited to GEOrge (${orgId})`;
  const html = `<p>You have been invited to GEOrge.</p><p><a href="${inviteUrl}">Accept your invite</a></p><p>If you were not expecting this, ignore this email.</p>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [toEmail],
      subject,
      html,
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    return { delivered: false, reason: `Email send failed: ${res.status} ${txt.slice(0, 120)}` };
  }
  return { delivered: true };
}

function buildDiscussionAgents(cwd) {
  const preferred = new Set([
    "intake_orchestrator",
    "strategy_lead",
    "marketing_lead",
    "media_planner",
    "program_manager",
    "partnership_ops",
    "finance_planner",
    "measurement_analyst",
    "risk_reviewer",
  ]);
  const enabled = getEnabledAgentsInOrder(cwd);
  const focused = enabled.filter((agent) => preferred.has(agent.id));
  const maxAgents = Number(process.env.DISCUSSION_MAX_AGENTS || 7);
  return (focused.length > 0 ? focused : enabled).slice(0, Math.max(2, maxAgents));
}

async function runDiscussionTurn({ cwd, client, store, sessionId, text }) {
  const agents = buildDiscussionAgents(cwd);
  const sessionHistory =
    store.mode === "file"
      ? loadSessionMessages(cwd, sessionId)
      : await store.getSessionHistory(sessionId);
  const historySection =
    sessionHistory.length === 0
      ? "No prior conversation."
      : sessionHistory
          .slice(-8)
          .map((item) => `${item.role.toUpperCase()}: ${item.content}`)
          .join("\n");

  const perspectives = [];
  let priorPerspectives = "";
  for (const agent of agents) {
    const prompt = `
You are contributing one short perspective in a multi-agent team discussion.

User message:
${text}

Recent conversation:
${historySection}

Prior agent perspectives this turn:
${priorPerspectives || "None yet."}

Respond as ${agent.name} in this exact format:
Perspective:
Key concerns:
Recommended next step:

Keep it concrete, under 140 words, and simulation-only.
`;
    const response = await runModel({
      client,
      systemPrompt: agent.systemPrompt,
      userPrompt: prompt,
      temperature: agent.temperature ?? 0.4,
    });
    perspectives.push({
      agentId: agent.id,
      agentName: agent.name,
      stage: agent.stage,
      text: String(response || "").trim(),
    });
    priorPerspectives += `[${agent.name}] ${String(response || "").trim()}\n\n`;
  }

  const combined = [
    `Team discussion on: "${text}"`,
    "",
    ...perspectives.map((p) => `### ${p.agentName} (${p.stage})\n${p.text}`),
  ].join("\n");

  return { combined, perspectives };
}

function htmlPage() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DV Agent Command Center</title>
  <style>
    :root {
      --bg: #f5f7f1;
      --panel: #ffffff;
      --ink: #1f2a1f;
      --muted: #5f6d61;
      --line: #d7dfd2;
      --accent: #0f766e;
      --accent-soft: #e2f4f2;
      --warn: #7f1d1d;
      --warn-soft: #fee2e2;
      --mono: "Consolas", "SFMono-Regular", Menlo, monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", "Trebuchet MS", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at 8% 8%, #edf7ed 0%, transparent 34%),
        radial-gradient(circle at 90% 0%, #e6f3f6 0%, transparent 38%),
        var(--bg);
    }
    .wrap { max-width: 1320px; margin: 0 auto; padding: 18px; }
    .top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
      gap: 12px;
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .logo {
      height: 52px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      padding: 3px 8px;
      object-fit: contain;
    }
    h1 { margin: 0; font-size: 28px; letter-spacing: 0.3px; }
    .muted { color: var(--muted); font-size: 12px; }
    .grid {
      display: grid;
      grid-template-columns: 320px 1fr;
      gap: 12px;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 12px;
      box-shadow: 0 10px 22px rgba(8, 28, 20, 0.05);
    }
    .composer textarea {
      width: 100%;
      min-height: 88px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px;
      resize: vertical;
      font: inherit;
    }
    .row { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 8px; }
    button {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      padding: 7px 11px;
      cursor: pointer;
      font-weight: 600;
    }
    button.primary {
      border-color: #0c5e57;
      color: #fff;
      background: linear-gradient(180deg, #0f766e, #0c5e57);
    }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    .status {
      margin-top: 8px;
      padding: 8px;
      border: 1px solid var(--line);
      border-radius: 8px;
      font-size: 12px;
      background: #f8faf6;
    }
    .status.err { color: var(--warn); border-color: #fecaca; background: var(--warn-soft); }
    .session {
      border: 1px solid var(--line);
      border-radius: 9px;
      padding: 8px;
      margin-bottom: 8px;
      cursor: pointer;
      background: #fff;
    }
    .session:hover { background: #fbfefb; }
    .session.active { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
    .score {
      display: inline-block;
      font-size: 11px;
      border-radius: 999px;
      padding: 2px 8px;
      background: var(--accent-soft);
      color: #0f5f58;
      margin-top: 6px;
    }
    .card {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 10px;
      background: #fff;
      margin-bottom: 10px;
    }
    .card h3 { margin: 0 0 6px; font-size: 15px; color: #114c5a; }
    .label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.3px; margin-bottom: 3px; }
    .timeline { display: grid; gap: 8px; }
    .messages { display: grid; gap: 8px; max-height: 360px; overflow: auto; }
    .msg { border: 1px solid var(--line); border-radius: 9px; padding: 8px; background: #fff; }
    .msg.user { border-left: 4px solid #0f766e; }
    .msg.assistant { border-left: 4px solid #155e75; }
    .step {
      border: 1px solid var(--line);
      border-radius: 9px;
      padding: 8px;
      background: #fff;
    }
    .step-head { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
    .pill {
      font-size: 11px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 2px 7px;
      background: #f7faf6;
    }
    .pill.fail { background: #fee2e2; border-color: #fecaca; color: #7f1d1d; }
    pre {
      margin: 0;
      white-space: pre-wrap;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px;
      background: #fbfcfa;
      max-height: 420px;
      overflow: auto;
      font-size: 12px;
      font-family: var(--mono);
    }
    details { margin-top: 8px; }
    summary { cursor: pointer; color: #155e75; font-size: 12px; }
    .login {
      position: fixed;
      inset: 0;
      background: rgba(20, 27, 20, 0.45);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 20;
    }
    .login-card {
      width: 360px;
      max-width: calc(100vw - 24px);
      background: #fff;
      border-radius: 12px;
      border: 1px solid var(--line);
      padding: 14px;
    }
    .login-card input {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px;
      font: inherit;
    }
    @media (max-width: 1000px) {
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div class="brand">
        <img id="logo" class="logo" src="/assets/destination-vancouver-logo.png" alt="Destination Vancouver logo" />
        <h1>DV Agent Command Center</h1>
      </div>
      <div class="muted">Simple workspace for assigning work and reviewing team output</div>
    </div>
    <div style="margin-bottom:12px;"><a href="/geo" class="muted">Open GEO Measurement Dashboard</a></div>

    <div class="grid">
      <div class="panel">
        <h3 style="margin:0 0 10px;">Sessions</h3>
        <div id="sessions"></div>
      </div>

      <div class="panel">
        <div class="composer card">
          <h3>Ask The Team</h3>
          <textarea id="prompt" placeholder="Describe what you want the team to do."></textarea>
          <div class="row">
            <label class="muted"><input type="checkbox" id="newSession"> Start new session</label>
            <div style="display:flex; gap:8px;">
              <button id="discussBtn">Discuss</button>
              <button id="runBtn" class="primary">Run Team</button>
            </div>
          </div>
          <div id="status" class="status">Ready.</div>
        </div>

        <div class="card">
          <h3>Conversation</h3>
          <div id="messages" class="messages"></div>
        </div>

        <div class="card">
          <h3>Current Output</h3>
          <div id="finalText" class="muted">No session selected.</div>
        </div>

        <div class="card">
          <h3>Agent Timeline</h3>
          <div id="timeline" class="timeline"></div>
        </div>

        <details>
          <summary>Show technical details</summary>
          <div style="margin-top:8px; display:grid; gap:8px;">
            <pre id="summaryJson">{}</pre>
            <pre id="pipelineJson">{}</pre>
          </div>
        </details>
      </div>
    </div>
  </div>

  <div id="login" class="login">
    <div class="login-card">
      <h3 style="margin-top:0;">Sign In</h3>
      <div class="muted" style="margin-bottom:8px;">Enter dashboard password.</div>
      <input id="passwordInput" type="password" placeholder="Password" />
      <div class="row">
        <span></span>
        <button id="loginBtn" class="primary">Continue</button>
      </div>
      <div id="loginStatus" class="status" style="margin-top:8px;">Waiting for password.</div>
    </div>
  </div>

  <script>
    let sessions = [];
    let current = null;
    let selectedSessionId = "";
    let busy = false;
    let currentJobId = "";
    const authToken = { value: localStorage.getItem("dv_auth_token") || "" };

    function escapeHtml(text) {
      return String(text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    function clip(text, max = 260) {
      const v = String(text || "").trim();
      return v.length <= max ? v : (v.slice(0, max) + "...");
    }

    function setStatus(text, isErr = false) {
      const el = document.getElementById("status");
      el.textContent = text;
      el.className = "status" + (isErr ? " err" : "");
    }

    function setBusy(v) {
      busy = v;
      document.getElementById("runBtn").disabled = v;
    }

    async function apiFetch(url, options = {}) {
      const opts = { ...options, headers: { ...(options.headers || {}) } };
      if (authToken.value) opts.headers["x-dv-auth"] = authToken.value;
      const res = await fetch(url, opts);
      if (res.status === 401) {
        showLogin();
        throw new Error("Authentication required.");
      }
      return res;
    }

    async function loadSessions() {
      const res = await apiFetch("/api/sessions");
      sessions = await res.json();
      if (!selectedSessionId && sessions.length > 0) selectedSessionId = sessions[0].sessionId;
      renderSessionList();
      if (selectedSessionId) await loadSession(selectedSessionId);
    }

    function renderSessionList() {
      const root = document.getElementById("sessions");
      root.innerHTML = "";
      sessions.forEach((s) => {
        const div = document.createElement("div");
        div.className = "session" + (s.sessionId === selectedSessionId ? " active" : "");
        div.innerHTML =
          "<div><strong>" + escapeHtml(s.sessionId) + "</strong></div>" +
          "<div class='muted'>" + escapeHtml(clip(s.userRequest, 80)) + "</div>" +
          "<div class='muted'>" + escapeHtml(s.completedAt || "in progress") + "</div>" +
          (s.overallScore !== null ? ("<span class='score'>Score " + escapeHtml(s.overallScore) + "</span>") : "");
        div.onclick = async () => {
          selectedSessionId = s.sessionId;
          renderSessionList();
          await loadSession(s.sessionId);
        };
        root.appendChild(div);
      });
      if (sessions.length === 0) {
        root.innerHTML = "<div class='muted'>No sessions yet.</div>";
      }
    }

    async function loadSession(sessionId) {
      const res = await apiFetch("/api/session/" + encodeURIComponent(sessionId));
      current = await res.json();
      renderCurrent();
    }

    function renderCurrent() {
      if (!current) return;
      const messageItems = current.messages || [];
      const messagesEl = document.getElementById("messages");
      if (messageItems.length === 0) {
        messagesEl.innerHTML = "<div class='muted'>No conversation yet.</div>";
      } else {
        messagesEl.innerHTML = messageItems.slice(-20).map((m) => {
          const role = m.role === "user" ? "user" : "assistant";
          return "<div class='msg " + role + "'>" +
            "<div class='label'>" + escapeHtml(role) + "</div>" +
            "<div>" + escapeHtml(m.content || "") + "</div>" +
            "</div>";
        }).join("");
      }
      document.getElementById("finalText").textContent = current.final || "(No final output yet)";
      const steps = (current.events || []).filter((e) => e.type === "agent_step");
      const timeline = document.getElementById("timeline");
      if (steps.length === 0) {
        timeline.innerHTML = "<div class='muted'>No agent steps yet.</div>";
      } else {
        timeline.innerHTML = steps.map((step, idx) => {
          const pf = step.structured?.passFail || "N/A";
          const failClass = String(pf).toLowerCase() === "fail" ? " fail" : "";
          return "<div class='step'>" +
            "<div class='step-head'>" +
              "<strong>" + (idx + 1) + ". [" + escapeHtml(step.stage || "") + "] " + escapeHtml(step.agentName || step.agentId || "agent") + "</strong>" +
              "<span class='pill" + failClass + "'>" + escapeHtml(pf) + "</span>" +
            "</div>" +
            "<div class='muted'>" + escapeHtml(clip(step.structured?.summary || step.structured?.decision?.decision || step.output || "", 260)) + "</div>" +
            "</div>";
        }).join("");
      }
      document.getElementById("summaryJson").textContent = JSON.stringify({
        sessionId: current.sessionId,
        evaluation: current.evaluation,
        decisions: current.decisions
      }, null, 2);
      document.getElementById("pipelineJson").textContent = JSON.stringify(current.pipeline || {}, null, 2);
    }

    async function pollJob(jobId) {
      currentJobId = jobId;
      for (;;) {
        const res = await apiFetch("/api/job/" + encodeURIComponent(jobId));
        const job = await res.json();
        if (job.status === "queued") {
          setStatus("Queued. Waiting for worker...");
        } else if (job.status === "running") {
          setStatus(job.kind === "discussion" ? "Running team discussion..." : "Running team workflow...");
        } else if (job.status === "failed") {
          setStatus("Run failed: " + (job.error || "Unknown error"), true);
          setBusy(false);
          return;
        } else if (job.status === "done") {
          setStatus("Run completed.");
          selectedSessionId = job.sessionId || selectedSessionId;
          await loadSessions();
          setBusy(false);
          return;
        }
        await new Promise((r) => setTimeout(r, 1300));
      }
    }

    async function runAction(kind) {
      if (busy) return;
      const text = String(document.getElementById("prompt").value || "").trim();
      if (!text) {
        setStatus("Enter a request first.", true);
        return;
      }
      setBusy(true);
      try {
        const payload = {
          text,
          sessionId: document.getElementById("newSession").checked ? "" : selectedSessionId,
          newSession: document.getElementById("newSession").checked,
          kind
        };
        const route = kind === "discussion" ? "/api/discuss" : "/api/message";
        const res = await apiFetch(route, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Run enqueue failed.");
        document.getElementById("prompt").value = "";
        document.getElementById("newSession").checked = false;
        await pollJob(data.jobId);
      } catch (err) {
        setStatus(String(err.message || err), true);
        setBusy(false);
      }
    }

    async function runTeam() {
      await runAction("workflow");
    }

    async function runDiscussion() {
      await runAction("discussion");
    }

    function showLogin() {
      document.getElementById("login").style.display = "flex";
    }

    function hideLogin() {
      document.getElementById("login").style.display = "none";
    }

    async function validateLogin() {
      const pwd = document.getElementById("passwordInput").value;
      const status = document.getElementById("loginStatus");
      status.textContent = "Checking...";
      try {
        const res = await fetch("/api/auth/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ authToken: pwd }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          status.textContent = "Password invalid.";
          status.className = "status err";
          return;
        }
        authToken.value = pwd;
        localStorage.setItem("dv_auth_token", pwd);
        status.textContent = "Authenticated.";
        status.className = "status";
        hideLogin();
        await loadSessions();
      } catch (err) {
        status.textContent = "Auth check failed.";
        status.className = "status err";
      }
    }

    document.getElementById("runBtn").onclick = runTeam;
    document.getElementById("discussBtn").onclick = runDiscussion;
    document.getElementById("loginBtn").onclick = validateLogin;
    document.getElementById("logo").onerror = () => { document.getElementById("logo").style.display = "none"; };

    (async function init() {
      try {
        await loadSessions();
      } catch (err) {
        showLogin();
      }
    })();
  </script>
</body>
</html>`;
}

function geoHtmlPage() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>GEOrge Measurement</title>
  <style>
    :root { --bg:#f4f7f3; --card:#fff; --ink:#1d2b22; --line:#d5e0d4; --accent:#0f766e; --muted:#5f6d61; --err:#7f1d1d; }
    body {
      margin:0;
      background:
        radial-gradient(circle at 12% 0%, #dcefe7 0%, transparent 34%),
        radial-gradient(circle at 88% 0%, #e4f0f8 0%, transparent 36%),
        var(--bg);
      color:var(--ink);
      font-family:"Segoe UI","Trebuchet MS",sans-serif;
    }
    .wrap { max-width:1280px; margin:0 auto; padding:18px; }
    .tabs { display:flex; gap:8px; margin-top:12px; }
    .tab { border:1px solid var(--line); border-radius:999px; padding:7px 12px; cursor:pointer; background:#fff; font-weight:600; }
    .tab.active { border-color:var(--accent); background:#e7f5f3; color:#0c5e57; }
    .hidden { display:none; }
    .row { display:grid; gap:12px; grid-template-columns:360px 1fr; margin-top:12px; }
    .rowPerf { display:grid; gap:12px; grid-template-columns:1fr; margin-top:12px; }
    .split2 { display:grid; gap:12px; grid-template-columns:1fr 1fr; }
    .split3 { display:grid; gap:12px; grid-template-columns:1fr 1fr 1fr; }
    .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px; }
    .muted { color:var(--muted); font-size:12px; }
    .kpis { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; }
    .kpi {
      border:1px solid var(--line);
      border-radius:10px;
      padding:8px;
      background:linear-gradient(180deg,#ffffff,#f5fbf8);
      box-shadow:0 8px 14px rgba(13, 42, 33, 0.04);
    }
    .rangeRow { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:8px; }
    .chip { border:1px solid var(--line); border-radius:999px; padding:6px 10px; font-size:12px; cursor:pointer; background:#fff; }
    .chip.active { border-color:var(--accent); background:#e7f5f3; color:#0c5e57; font-weight:600; }
    .mini { width:auto; min-width:130px; }
    .bars { display:grid; gap:8px; }
    .barRow { border:1px solid var(--line); border-radius:10px; padding:8px; background:#fff; }
    .barTop { display:flex; justify-content:space-between; gap:8px; font-size:12px; margin-bottom:6px; }
    .barTrack { height:8px; border-radius:999px; background:#edf3ee; overflow:hidden; }
    .barFill { height:100%; background:linear-gradient(90deg,#0f766e,#23a39b); }
    textarea, input { width:100%; border:1px solid var(--line); border-radius:8px; padding:8px; font:inherit; }
    textarea { min-height:120px; resize:vertical; }
    button { border:1px solid var(--line); border-radius:8px; padding:8px 12px; cursor:pointer; font-weight:600; }
    button.primary { background:linear-gradient(180deg,#0f766e,#0c5e57); color:#fff; border-color:#0c5e57; }
    .status { margin-top:8px; border:1px solid var(--line); border-radius:8px; padding:8px; background:#f8faf6; font-size:12px; }
    .err { color:var(--err); background:#fee2e2; border-color:#fecaca; }
    .batch { border:1px solid var(--line); border-radius:9px; background:#fff; padding:8px; margin-bottom:8px; cursor:pointer; }
    .batch.active { border-color:var(--accent); box-shadow:inset 0 0 0 1px var(--accent); }
    table { width:100%; border-collapse:collapse; font-size:13px; }
    th, td { border-bottom:1px solid var(--line); text-align:left; padding:6px; vertical-align:top; }
    @media (max-width:1000px) { .row, .split2, .split3 { grid-template-columns:1fr; } .kpis { grid-template-columns:repeat(2,minmax(0,1fr)); } }
  </style>
</head>
<body>
  <div class="wrap">
    <h1 style="margin:0;">GEOrge Measurement</h1>
    <div class="muted" style="margin-top:4px;">Track visibility in ChatGPT and Gemini by market and funnel.</div>
    <div style="margin-top:10px;" class="muted">Standalone edition</div>

    <div class="tabs">
      <button id="tabRunBtn" class="tab active">Run</button>
      <button id="tabPerfBtn" class="tab">Performance</button>
    </div>

    <div id="tabRun" class="row">
      <div class="card">
        <h3 style="margin:0 0 8px;">Run Batch</h3>
        <label class="muted">Providers (comma-separated)</label>
        <input id="providers" value="${DEFAULT_PROVIDERS.join(",")}" />
        <label class="muted" style="display:block;margin-top:8px;">Markets (comma-separated)</label>
        <input id="markets" value="${DEFAULT_MARKETS.join(",")}" />
        <label class="muted" style="display:block;margin-top:8px;">Repeats per prompt</label>
        <input id="repeats" value="2" />
        <label class="muted" style="display:block;margin-top:8px;">Prompt set JSON (optional)</label>
        <textarea id="prompts" placeholder='Leave blank to use default Vancouver brand prompt set.'></textarea>
        <div style="margin-top:8px;"><button id="runBtn" class="primary">Start GEO Batch</button></div>
        <div id="status" class="status">Ready.</div>
        <h3 style="margin:14px 0 8px;">Batches</h3>
        <div id="batches"></div>
      </div>
      <div class="card">
        <h3 style="margin:0 0 8px;">Selected Batch</h3>
        <div id="selectedBatchMeta" class="muted">No batch selected.</div>
        <div id="selectedBatchKpis" class="kpis" style="margin-top:10px;"></div>
        <h4>Top Sources</h4>
        <div id="selectedSources"></div>
        <h4>Sample Rows</h4>
        <div style="max-height:340px; overflow:auto;">
          <table>
            <thead><tr><th>Provider</th><th>Market</th><th>Funnel</th><th>Rank</th><th>Sources</th><th>Error</th></tr></thead>
            <tbody id="selectedSamples"></tbody>
          </table>
        </div>
      </div>
    </div>

    <div id="tabPerf" class="rowPerf hidden">
      <div class="card">
        <h3 style="margin:0;">Performance</h3>
        <div class="rangeRow">
          <button class="chip active" id="rangeToday">Today</button>
          <button class="chip" id="rangeWeek">This Week</button>
          <button class="chip" id="rangeMonth">This Month</button>
          <button class="chip" id="rangeAll">All Time</button>
          <button class="chip" id="rangeCustom">Custom</button>
          <input id="rangeStart" class="mini" type="date" />
          <input id="rangeEnd" class="mini" type="date" />
          <button class="chip" id="applyRange">Apply</button>
        </div>
        <div id="perfMeta" class="muted" style="margin-top:8px;"></div>
        <div id="perfKpis" class="kpis" style="margin-top:10px;"></div>
      </div>
      <div class="split2">
        <div class="card">
          <h4 style="margin-top:0;">Top Overall Sources</h4>
          <div id="perfSources" class="bars"></div>
        </div>
        <div class="card">
          <h4 style="margin-top:0;">Top Sources Excluding Vancouver</h4>
          <div id="perfSourcesNoDv" class="bars"></div>
        </div>
      </div>
      <div class="split2">
        <div class="card">
          <h4 style="margin-top:0;">Vancouver Performance by Funnel</h4>
          <div id="perfByFunnel"></div>
        </div>
        <div class="card">
          <h4 style="margin-top:0;">Vancouver Performance by Location</h4>
          <div id="perfByMarket"></div>
        </div>
      </div>
    </div>
  </div>
  <script>
    let selectedBatchId = "";
    let busy = false;
    const authToken = localStorage.getItem("dv_auth_token") || "";
    let batchList = [];
    let currentRange = "today";

    async function apiFetch(url, options = {}) {
      const opts = { ...options, headers: { ...(options.headers || {}) } };
      if (authToken) opts.headers["x-dv-auth"] = authToken;
      return fetch(url, opts);
    }

    function splitCsv(v) {
      return String(v || "").split(",").map((x) => x.trim()).filter(Boolean);
    }
    function escapeHtml(s) {
      return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
    function setStatus(text, isErr = false) {
      const el = document.getElementById("status");
      el.textContent = text;
      el.className = "status" + (isErr ? " err" : "");
    }
    function setBusy(v) {
      busy = v;
      document.getElementById("runBtn").disabled = v;
    }
    function renderTable(rows, cols) {
      if (!rows || rows.length === 0) return "<div class='muted'>No data.</div>";
      return "<table><thead><tr>" + cols.map((c) => "<th>" + escapeHtml(c) + "</th>").join("") + "</tr></thead><tbody>" +
        rows.map((r) => "<tr>" + cols.map((c) => "<td>" + escapeHtml(String(r[c] || "")) + "</td>").join("") + "</tr>").join("") +
        "</tbody></table>";
    }
    function renderBars(elId, rows) {
      const root = document.getElementById(elId);
      if (!rows || rows.length === 0) {
        root.innerHTML = "<div class='muted'>No data.</div>";
        return;
      }
      const max = Math.max(...rows.map((r) => Number(r.count || 0)), 1);
      root.innerHTML = rows.slice(0, 12).map((r) => {
        const pct = Math.round((Number(r.count || 0) / max) * 100);
        return "<div class='barRow'>" +
          "<div class='barTop'><strong>" + escapeHtml(r.domain || "") + "</strong><span>" + escapeHtml(String(r.count || 0)) + "</span></div>" +
          "<div class='barTrack'><div class='barFill' style='width:" + escapeHtml(String(pct)) + "%;'></div></div>" +
        "</div>";
      }).join("");
    }
    function renderKpis(elId, items) {
      document.getElementById(elId).innerHTML = items.map((x) =>
        "<div class='kpi'><div class='muted'>" + escapeHtml(x.k) + "</div><div style='font-size:24px;font-weight:700;'>" + escapeHtml(String(x.v)) + "</div></div>"
      ).join("");
    }
    function setTab(tab) {
      const run = tab === "run";
      document.getElementById("tabRun").className = run ? "row" : "row hidden";
      document.getElementById("tabPerf").className = run ? "rowPerf hidden" : "rowPerf";
      document.getElementById("tabRunBtn").className = run ? "tab active" : "tab";
      document.getElementById("tabPerfBtn").className = run ? "tab" : "tab active";
    }
    function setRange(range) {
      currentRange = range;
      const map = {
        today: "rangeToday",
        week: "rangeWeek",
        month: "rangeMonth",
        all: "rangeAll",
        custom: "rangeCustom",
      };
      Object.values(map).forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.className = "chip";
      });
      const active = document.getElementById(map[range]);
      if (active) active.className = "chip active";
    }
    function parseDateSafe(value) {
      const s = String(value || "");
      if (!s) return null;
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) return null;
      return d;
    }
    function isInRange(iso, range, startDate, endDate) {
      const d = parseDateSafe(iso);
      if (!d) return false;
      const now = new Date();
      if (range === "all") return true;
      if (range === "today") {
        const y = now.getFullYear(), m = now.getMonth(), day = now.getDate();
        return d.getFullYear() === y && d.getMonth() === m && d.getDate() === day;
      }
      if (range === "week") {
        const start = new Date(now);
        const dayOfWeek = (start.getDay() + 6) % 7;
        start.setDate(start.getDate() - dayOfWeek);
        start.setHours(0, 0, 0, 0);
        return d >= start;
      }
      if (range === "month") {
        return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
      }
      if (range === "custom") {
        if (!startDate || !endDate) return false;
        const start = new Date(startDate);
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        return d >= start && d <= end;
      }
      return false;
    }

    function isVancouverDomain(domain) {
      const d = String(domain || "").toLowerCase();
      return d.includes("destinationvancouver") || d.includes("vancouver");
    }

    function summarizeSamples(samples) {
      const ok = (samples || []).filter((s) => !s.error);
      const total = ok.length;
      const mention = ok.filter((s) => s.vancouverMentioned).length;
      const top = ok.filter((s) => s.vancouverRank === "top").length;
      const included = ok.filter((s) => s.vancouverRank === "included").length;

      const sourceCount = (excludeDv) => {
        const m = new Map();
        ok.forEach((s) => {
          const unique = new Set(s.sourceDomains || []);
          unique.forEach((d) => {
            if (excludeDv && isVancouverDomain(d)) return;
            m.set(d, (m.get(d) || 0) + 1);
          });
        });
        return [...m.entries()].map(([domain, count]) => ({ domain, count })).sort((a, b) => b.count - a.count).slice(0, 20);
      };

      const byKey = (keyFn) => {
        const m = new Map();
        ok.forEach((s) => {
          const key = keyFn(s);
          const cur = m.get(key) || { key, sampleCount: 0, mention: 0, top: 0 };
          cur.sampleCount += 1;
          if (s.vancouverMentioned) cur.mention += 1;
          if (s.vancouverRank === "top") cur.top += 1;
          m.set(key, cur);
        });
        return [...m.values()].map((x) => ({
          key: x.key,
          sampleCount: x.sampleCount,
          mentionRate: x.sampleCount ? (x.mention / x.sampleCount).toFixed(3) : "0.000",
          topRate: x.sampleCount ? (x.top / x.sampleCount).toFixed(3) : "0.000",
        })).sort((a, b) => b.sampleCount - a.sampleCount);
      };

      return {
        total,
        mentionRate: total ? (mention / total).toFixed(3) : "0.000",
        topRate: total ? (top / total).toFixed(3) : "0.000",
        includedRate: total ? ((top + included) / total).toFixed(3) : "0.000",
        sourceOverall: sourceCount(false),
        sourceNoDv: sourceCount(true),
        byFunnel: byKey((s) => s.funnel || "unknown"),
        byMarket: byKey((s) => s.market || "unknown"),
      };
    }

    async function loadBatches() {
      const res = await apiFetch("/api/geo/batches");
      batchList = await res.json();
      const root = document.getElementById("batches");
      root.innerHTML = "";
      if (!selectedBatchId && batchList.length > 0) selectedBatchId = batchList[0].batchId;
      batchList.forEach((row) => {
        const div = document.createElement("div");
        div.className = "batch" + (row.batchId === selectedBatchId ? " active" : "");
        div.innerHTML = "<div><strong>" + escapeHtml(row.batchId) + "</strong></div>" +
          "<div class='muted'>" + escapeHtml(row.createdAt || "") + " | " + escapeHtml(row.status || "") + "</div>" +
          "<div class='muted'>Mention " + escapeHtml(String(row.mentionRate || 0)) + " | Top " + escapeHtml(String(row.topRate || 0)) + "</div>";
        div.onclick = async () => {
          selectedBatchId = row.batchId;
          await loadBatches();
          await loadSelectedBatch();
        };
        root.appendChild(div);
      });
      if (batchList.length === 0) root.innerHTML = "<div class='muted'>No GEO batches yet.</div>";
    }

    async function loadSelectedBatch() {
      if (!selectedBatchId) return;
      const res = await apiFetch("/api/geo/batch/" + encodeURIComponent(selectedBatchId));
      if (!res.ok) return;
      const batch = await res.json();
      const summary = summarizeSamples(batch.samples || []);
      document.getElementById("selectedBatchMeta").textContent =
        "Batch: " + (batch.batchId || "") + " | Status: " + (batch.status || "") + " | Created: " + (batch.createdAt || "");
      renderKpis("selectedBatchKpis", [
        { k: "Samples", v: summary.total },
        { k: "Mention Rate", v: summary.mentionRate },
        { k: "Top Rate", v: summary.topRate },
        { k: "Included Rate", v: summary.includedRate },
      ]);
      document.getElementById("selectedSources").innerHTML = renderTable(summary.sourceOverall, ["domain", "count"]);
      const samples = (batch.samples || []).slice(0, 250);
      document.getElementById("selectedSamples").innerHTML = samples.map((s) => "<tr>" +
        "<td>" + escapeHtml(s.provider) + "</td>" +
        "<td>" + escapeHtml(s.market) + "</td>" +
        "<td>" + escapeHtml(s.funnel) + "</td>" +
        "<td>" + escapeHtml(s.vancouverRank) + "</td>" +
        "<td>" + escapeHtml((s.sourceDomains || []).slice(0, 3).join(", ")) + "</td>" +
        "<td>" + escapeHtml(s.error || "") + "</td>" +
      "</tr>").join("");
    }

    async function loadPerformance() {
      const startDate = document.getElementById("rangeStart").value;
      const endDate = document.getElementById("rangeEnd").value;
      const scopedBatches = (batchList || []).filter((b) => isInRange(b.createdAt, currentRange, startDate, endDate));
      const details = await Promise.all(scopedBatches.map(async (b) => {
        const res = await apiFetch("/api/geo/batch/" + encodeURIComponent(b.batchId));
        if (!res.ok) return null;
        return res.json();
      }));
      const allSamples = details.filter(Boolean).flatMap((b) => Array.isArray(b.samples) ? b.samples : []);
      const summary = summarizeSamples(allSamples);
      const label = currentRange === "today" ? "Today" :
        currentRange === "week" ? "This Week" :
        currentRange === "month" ? "This Month" :
        currentRange === "all" ? "All Time" :
        ("Custom: " + (startDate || "?") + " to " + (endDate || "?"));
      document.getElementById("perfMeta").textContent =
        label + " | Batches: " + scopedBatches.length + " | Rows: " + allSamples.length;
      renderKpis("perfKpis", [
        { k: "Samples", v: summary.total },
        { k: "Mention Rate", v: summary.mentionRate },
        { k: "Top Rate", v: summary.topRate },
        { k: "Included Rate", v: summary.includedRate },
      ]);
      renderBars("perfSources", summary.sourceOverall);
      renderBars("perfSourcesNoDv", summary.sourceNoDv);
      document.getElementById("perfByFunnel").innerHTML = renderTable(summary.byFunnel, ["key", "sampleCount", "mentionRate", "topRate"]);
      document.getElementById("perfByMarket").innerHTML = renderTable(summary.byMarket, ["key", "sampleCount", "mentionRate", "topRate"]);
    }

    async function pollJob(jobId) {
      for (;;) {
        const res = await apiFetch("/api/job/" + encodeURIComponent(jobId));
        const job = await res.json();
        if (job.status === "queued") setStatus("Queued...");
        if (job.status === "running") {
          const p = job.progress || {};
          setStatus("Running GEO batch... " + String(p.completed || 0) + "/" + String(p.total || 0));
        }
        if (job.status === "failed") {
          setStatus("Batch failed: " + String(job.error || "Unknown"), true);
          setBusy(false);
          return;
        }
        if (job.status === "done") {
          setStatus("Batch completed.");
          if (job.batchId) selectedBatchId = job.batchId;
          await loadBatches();
          await loadSelectedBatch();
          await loadPerformance();
          setBusy(false);
          return;
        }
        await new Promise((r) => setTimeout(r, 1300));
      }
    }

    async function runBatch() {
      if (busy) return;
      setBusy(true);
      try {
        let prompts = undefined;
        const promptRaw = String(document.getElementById("prompts").value || "").trim();
        if (promptRaw) prompts = JSON.parse(promptRaw);
        const body = {
          providers: splitCsv(document.getElementById("providers").value),
          markets: splitCsv(document.getElementById("markets").value),
          repeats: Number(document.getElementById("repeats").value || 1),
          prompts
        };
        const res = await apiFetch("/api/geo/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to start batch.");
        selectedBatchId = data.batchId;
        setStatus("Batch queued.");
        await pollJob(data.jobId);
      } catch (err) {
        setStatus(String(err.message || err), true);
        setBusy(false);
      }
    }

    document.getElementById("runBtn").onclick = runBatch;
    document.getElementById("tabRunBtn").onclick = () => setTab("run");
    document.getElementById("tabPerfBtn").onclick = () => setTab("perf");
    document.getElementById("rangeToday").onclick = async () => { setRange("today"); await loadPerformance(); };
    document.getElementById("rangeWeek").onclick = async () => { setRange("week"); await loadPerformance(); };
    document.getElementById("rangeMonth").onclick = async () => { setRange("month"); await loadPerformance(); };
    document.getElementById("rangeAll").onclick = async () => { setRange("all"); await loadPerformance(); };
    document.getElementById("rangeCustom").onclick = async () => { setRange("custom"); await loadPerformance(); };
    document.getElementById("applyRange").onclick = async () => { setRange("custom"); await loadPerformance(); };

    (async function init() {
      setRange("today");
      await loadBatches();
      await loadSelectedBatch();
      await loadPerformance();
      const defaultPromptSet = ${JSON.stringify(promptsFromGeoConfig(DEFAULT_GEO_CONFIG))};
      if (!document.getElementById("prompts").value) {
        document.getElementById("prompts").placeholder = JSON.stringify(defaultPromptSet.slice(0, 2), null, 2) + "\\n...";
      }
    })();
  </script>
</body>
</html>`;
}

function geoExecutivePage({ orgHint = "" } = {}) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>GEOrge Executive Dashboard</title>
  <style>
    :root { --bg:#f2f6f4; --card:#ffffff; --ink:#17241d; --muted:#5e6f65; --line:#d4dfd8; --accent:#0f766e; --accent2:#1ea399; --err:#7f1d1d; }
    body { margin:0; font-family:"Segoe UI","Trebuchet MS",sans-serif; color:var(--ink); background:var(--bg); }
    .wrap { max-width:1240px; margin:0 auto; padding:20px; }
    .tabs { display:flex; gap:8px; margin:12px 0; }
    .tab { border:1px solid var(--line); background:#fff; border-radius:999px; padding:8px 12px; cursor:pointer; font-weight:700; }
    .tab.active { border-color:var(--accent); background:#e7f5f3; color:#0c5e57; }
    .hidden { display:none; }
    .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px; }
    .muted { color:var(--muted); font-size:12px; }
    .kpis { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:10px; margin-top:10px; }
    .kpi { border:1px solid var(--line); border-radius:10px; padding:10px; background:#fbfdfc; }
    .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:12px; }
    .row { display:grid; grid-template-columns:320px 1fr; gap:12px; margin-top:12px; }
    .filters { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:8px; }
    .chip { border:1px solid var(--line); border-radius:999px; background:#fff; padding:6px 10px; cursor:pointer; font-size:12px; }
    .chip.active { border-color:var(--accent); background:#e7f5f3; color:#0c5e57; font-weight:700; }
    input[type="date"], select { border:1px solid var(--line); border-radius:8px; padding:6px 8px; font:inherit; background:#fff; }
    .bars { display:grid; gap:8px; }
    .bar { border:1px solid var(--line); border-radius:10px; padding:8px; background:#fff; }
    .barTop { display:flex; justify-content:space-between; font-size:12px; margin-bottom:6px; }
    .track { height:8px; border-radius:999px; background:#eaf1ec; overflow:hidden; }
    .fill { height:100%; background:linear-gradient(90deg,var(--accent),var(--accent2)); }
    .trendWrap { border:1px solid var(--line); border-radius:10px; background:#fff; padding:10px; margin-top:8px; }
    .trendLegend { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; margin-top:8px; }
    .trendItem { display:flex; align-items:center; gap:8px; font-size:12px; border:1px solid var(--line); border-radius:8px; padding:6px; background:#fff; }
    .trendDot { width:10px; height:10px; border-radius:999px; flex:0 0 10px; }
    .trendLogo { width:18px; height:18px; border-radius:4px; background:#fff; border:1px solid var(--line); }
    .trendSvg { width:100%; height:auto; display:block; }
    table { width:100%; border-collapse:collapse; font-size:13px; }
    th, td { border-bottom:1px solid var(--line); text-align:left; padding:6px; }
    .option { border:1px solid var(--line); border-radius:8px; padding:8px; background:#fff; margin-top:8px; }
    .status { margin-top:8px; padding:8px; border:1px solid var(--line); border-radius:8px; background:#f8faf8; font-size:12px; }
    .status.err { color:var(--err); background:#fee2e2; border-color:#fecaca; }
    button.primary { border:1px solid var(--accent); color:#fff; background:linear-gradient(180deg,var(--accent2),var(--accent)); border-radius:8px; padding:8px 12px; font-weight:700; cursor:pointer; }
    @media (max-width:1000px){ .kpis{grid-template-columns:1fr 1fr;} .grid2,.row{grid-template-columns:1fr;} }
  </style>
</head>
<body>
  <div id="loginOverlay" style="position:fixed; inset:0; background:rgba(11,21,17,0.45); display:flex; align-items:center; justify-content:center; z-index:50;">
    <div style="width:min(420px,92vw); background:#fff; border:1px solid #d4dfd8; border-radius:12px; padding:14px;">
      <h3 style="margin:0 0 8px;">Sign In</h3>
      <div class="muted" style="margin-bottom:10px;">Access is scoped to your organization. New users join via an invite link from an admin.</div>
      <label class="muted">Name (for access request)</label>
      <input id="registerName" type="text" placeholder="Your full name" />
      <label class="muted">Email</label>
      <input id="loginEmail" type="email" placeholder="you@organization.com" />
      <label class="muted" style="display:block; margin-top:8px;">Password</label>
      <input id="loginPassword" type="password" />
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; margin-top:10px;">
        <div style="display:flex; gap:8px;">
          <button id="forgotPasswordBtn" class="chip" type="button">Forgot password?</button>
          <button id="registerRequestBtn" class="chip" type="button">Request Access</button>
        </div>
        <button id="loginBtn" class="primary">Sign In</button>
      </div>
      <div id="loginStatus" class="status" style="margin-top:8px;">Enter your credentials.</div>
    </div>
  </div>
  <div id="passwordOverlay" style="position:fixed; inset:0; background:rgba(11,21,17,0.45); display:none; align-items:center; justify-content:center; z-index:55;">
    <div style="width:min(440px,92vw); background:#fff; border:1px solid #d4dfd8; border-radius:12px; padding:14px;">
      <h3 style="margin:0 0 8px;">Change Password</h3>
      <label class="muted">Current Password</label>
      <input id="pwdCurrent" type="password" />
      <label class="muted" style="display:block; margin-top:8px;">New Password</label>
      <input id="pwdNew" type="password" />
      <label class="muted" style="display:block; margin-top:8px;">Confirm New Password</label>
      <input id="pwdConfirm" type="password" />
      <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:10px;">
        <button id="pwdCancelBtn" class="chip" type="button">Cancel</button>
        <button id="pwdSaveBtn" class="primary" type="button">Save Password</button>
      </div>
      <div id="pwdStatus" class="status" style="margin-top:8px;">Enter your current password and choose a new one.</div>
    </div>
  </div>
  <div class="wrap">
    <div style="display:flex; align-items:center; gap:10px;">
      <img id="orgLogo" src="/assets/destination-vancouver-logo.png" alt="Org logo" style="width:44px;height:44px;object-fit:contain;border:1px solid #d4dfd8;border-radius:8px;background:#fff;" />
      <h1 style="margin:0;">GEOrge Dashboard</h1>
    </div>
    <div class="muted" style="margin-top:4px;">Executive view: performance, sources, and trends for destination marketing organizations.</div>
    <div id="identity" style="margin-top:6px;" class="muted">Not signed in.</div>

    <div class="tabs">
      <button id="tabOverviewBtn" class="tab active">Overview</button>
      <button id="tabDrillBtn" class="tab">Sources</button>
      <button id="tabQualityBtn" class="tab">Content Quality</button>
      <button id="tabRunBtn" class="tab">Run</button>
      <button id="tabAdminBtn" class="tab">Admin</button>
    </div>

    <div id="tabOverview">
      <div class="card">
        <div class="filters">
          <button id="rangeToday" class="chip active">Today</button>
          <button id="rangeWeek" class="chip">This Week</button>
          <button id="rangeMonth" class="chip">This Month</button>
          <button id="rangeAll" class="chip">All Time</button>
          <button id="rangeCustom" class="chip">Custom</button>
          <input id="rangeStart" type="date" />
          <input id="rangeEnd" type="date" />
          <button id="applyRange" class="chip">Apply</button>
        </div>
        <div id="rangeMeta" class="muted" style="margin-top:8px;"></div>
        <div id="kpis" class="kpis"></div>
      </div>

      <div class="grid2">
        <div class="card">
          <h3 style="margin:0 0 8px;">Performance by Market</h3>
          <div id="marketBars" class="bars"></div>
        </div>
        <div class="card">
          <h3 style="margin:0 0 8px;">Performance by Funnel</h3>
          <div id="funnelBars" class="bars"></div>
        </div>
      </div>

      <div class="grid2">
        <div class="card">
          <h3 style="margin:0 0 8px;">Top Overall Sources</h3>
          <div id="sourceBars" class="bars"></div>
        </div>
        <div class="card">
          <h3 style="margin:0 0 8px;">Top Sources When Vancouver Is Mentioned</h3>
          <div id="sourceVancouverBars" class="bars"></div>
        </div>
      </div>
    </div>

    <div id="tabDrill" class="hidden">
      <div class="card">
        <div class="filters">
          <strong>Slice:</strong>
          <select id="drillType">
            <option value="market">Market</option>
            <option value="funnel">Funnel</option>
            <option value="question">Question</option>
          </select>
          <select id="drillValue"></select>
          <button id="drillApply" class="chip">Apply</button>
        </div>
        <div id="drillMeta" class="muted" style="margin-top:8px;"></div>
        <div id="drillKpis" class="kpis"></div>
      </div>
      <div class="grid2">
        <div class="card">
          <h3 style="margin:0 0 8px;">Top Sources (Overall in Slice)</h3>
          <div id="drillSourcesAll" class="bars"></div>
        </div>
        <div class="card">
          <h3 style="margin:0 0 8px;">Top Sources (Vancouver Mentioned)</h3>
          <div id="drillSourcesVancouver" class="bars"></div>
        </div>
      </div>
      <div class="card" style="margin-top:12px;">
        <h3 style="margin:0 0 8px;">Top Sources (Vancouver Top Answer)</h3>
        <div id="drillSourcesVancouverTop" class="bars"></div>
      </div>
      <div class="card" style="margin-top:12px;">
        <div class="filters" style="margin-top:0;">
          <strong>Question Source Variability</strong>
          <button id="trendRangeMonth" class="chip active">Month</button>
          <button id="trendRangeQuarter" class="chip">Quarter</button>
          <button id="trendRangeYear" class="chip">Year</button>
          <button id="trendRangeAll" class="chip">All</button>
          <button id="trendRangeCustom" class="chip">Custom</button>
          <input id="trendStart" type="date" />
          <input id="trendEnd" type="date" />
          <button id="trendApply" class="chip">Apply</button>
          <select id="trendGranularity">
            <option value="auto" selected>Auto</option>
            <option value="day">Day</option>
            <option value="week">Week</option>
          </select>
        </div>
        <div id="trendMeta" class="muted" style="margin-top:8px;"></div>
        <div class="trendWrap">
          <div id="trendChart"></div>
        </div>
        <div id="trendLegend" class="trendLegend"></div>
      </div>
    </div>

    <div id="tabQuality" class="hidden">
      <div class="card">
        <div id="qualityMeta" class="muted"></div>
        <div id="qualityKpis" class="kpis"></div>
      </div>
      <div class="grid2">
        <div class="card">
          <h3 style="margin:0 0 8px;">Scores by Market</h3>
          <div id="qualityMarket"></div>
        </div>
        <div class="card">
          <h3 style="margin:0 0 8px;">Scores by Funnel</h3>
          <div id="qualityFunnel"></div>
        </div>
      </div>
      <div class="card" style="margin-top:12px;">
        <div class="filters" style="margin-top:0; justify-content:space-between;">
          <h3 style="margin:0;">Scores by Question</h3>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <label class="muted">Sentiment
              <select id="qSortSentiment">
                <option value="none" selected>Off</option>
                <option value="desc">High-Low</option>
                <option value="asc">Low-High</option>
              </select>
            </label>
            <label class="muted">Specificity
              <select id="qSortSpecificity">
                <option value="none" selected>Off</option>
                <option value="desc">High-Low</option>
                <option value="asc">Low-High</option>
              </select>
            </label>
            <label class="muted">Brand
              <select id="qSortBrand">
                <option value="none" selected>Off</option>
                <option value="desc">High-Low</option>
                <option value="asc">Low-High</option>
              </select>
            </label>
            <label class="muted">Mention Rate
              <select id="qSortMentionRate">
                <option value="none" selected>Off</option>
                <option value="desc">High-Low</option>
                <option value="asc">Low-High</option>
              </select>
            </label>
            <label class="muted">Content Quality
              <select id="qSortContentQuality">
                <option value="none" selected>Off</option>
                <option value="desc">High-Low</option>
                <option value="asc">Low-High</option>
              </select>
            </label>
          </div>
        </div>
        <div id="qualityQuestion"></div>
      </div>
    </div>

    <div id="tabRun" class="hidden">
      <div class="row">
        <div class="card">
          <h3 style="margin:0;">Start New Run</h3>
          <div class="option">
            <strong>Models</strong>
            <label style="display:block; margin-top:6px;"><input id="modelChatgpt" type="checkbox" checked /> ChatGPT</label>
            <label style="display:block;"><input id="modelGemini" type="checkbox" checked /> Gemini</label>
          </div>
          <div class="option">
            <strong>Markets</strong>
            <label style="display:block; margin-top:6px;"><input class="market" type="checkbox" value="Los Angeles" checked /> Los Angeles</label>
            <label style="display:block;"><input class="market" type="checkbox" value="Seattle" checked /> Seattle</label>
            <label style="display:block;"><input class="market" type="checkbox" value="Mexico City" checked /> Mexico City</label>
            <label style="display:block;"><input class="market" type="checkbox" value="Sydney" checked /> Sydney</label>
          </div>
          <div class="option">
            <strong>Sample Depth</strong>
            <div style="margin-top:6px;">
              <select id="repeats">
                <option value="1">1 repeat (quick)</option>
                <option value="3" selected>3 repeats (recommended)</option>
                <option value="5">5 repeats (high confidence)</option>
              </select>
            </div>
          </div>
          <div style="margin-top:10px;"><button id="startRun" class="primary">Start Run</button></div>
          <div id="runStatus" class="status">Ready.</div>
        </div>
        <div class="card">
          <h3 style="margin:0 0 8px;">Recent Runs</h3>
          <div class="filters" style="margin-top:0;">
            <button id="runRangeDay" class="chip active">Day</button>
            <button id="runRangeWeek" class="chip">Week</button>
            <button id="runRangeMonth" class="chip">Month</button>
            <button id="runRangeAll" class="chip">All</button>
          </div>
          <div id="runRangeMeta" class="muted" style="margin:8px 0;"></div>
          <div id="recentRuns"></div>
        </div>
      </div>
    </div>

    <div id="tabAdmin" class="hidden">
      <div class="tabs" style="margin-top:0;">
        <button id="adminSectionUsersBtn" class="tab active">Manage Users</button>
        <button id="adminSectionGeoBtn" class="tab">Manage GEO Search</button>
        <button id="adminSectionAppearanceBtn" class="tab">Appearance</button>
      </div>

      <div id="adminUsersSection">
        <div class="card">
          <h3 style="margin:0 0 8px;">Organization Users</h3>
          <div class="muted" style="margin-bottom:8px;">Admins can add users and assign role access for this organization only.</div>
          <div id="adminStatus" class="status">Ready.</div>
        </div>
        <div class="grid2">
          <div class="card">
            <h3 style="margin:0 0 8px;">Create User</h3>
            <div class="option">
              <label class="muted" style="display:block;">Name</label>
              <input id="adminNewName" type="text" placeholder="Full name" style="width:100%; border:1px solid var(--line); border-radius:8px; padding:6px 8px; font:inherit; background:#fff;" />
              <label class="muted" style="display:block; margin-top:8px;">Email</label>
              <input id="adminNewEmail" type="email" placeholder="user@organization.com" style="width:100%; border:1px solid var(--line); border-radius:8px; padding:6px 8px; font:inherit; background:#fff;" />
              <label class="muted" style="display:block; margin-top:8px;">Password</label>
              <input id="adminNewPassword" type="password" style="width:100%; border:1px solid var(--line); border-radius:8px; padding:6px 8px; font:inherit; background:#fff;" />
              <label class="muted" style="display:block; margin-top:8px;">Role</label>
              <select id="adminNewRole" style="width:100%;">
                <option value="member" selected>User</option>
                <option value="admin">Administrator</option>
              </select>
              <div style="margin-top:10px;">
                <button id="adminCreateUserBtn" class="primary">Create User</button>
              </div>
            </div>
          </div>
          <div class="card">
            <h3 style="margin:0 0 8px;">Current Users</h3>
            <div id="adminUsersTable" class="muted">No users loaded.</div>
          </div>
        </div>
        <div class="card" style="margin-top:12px;">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
            <h3 style="margin:0;">Password Reset Requests</h3>
            <button id="adminRefreshResetsBtn" class="chip" type="button">Refresh</button>
          </div>
          <div id="adminResetRequests" class="muted" style="margin-top:8px;">No pending reset requests.</div>
        </div>
        <div class="card" style="margin-top:12px;">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
            <h3 style="margin:0;">Invites</h3>
            <button id="adminRefreshInvitesBtn" class="chip" type="button">Refresh</button>
          </div>
          <div class="option">
            <label class="muted" style="display:block;">Name</label>
            <input id="inviteName" type="text" placeholder="Full name" style="width:100%; border:1px solid var(--line); border-radius:8px; padding:6px 8px; font:inherit; background:#fff;" />
            <label class="muted" style="display:block; margin-top:8px;">Email</label>
            <input id="inviteEmail" type="email" placeholder="user@organization.com" style="width:100%; border:1px solid var(--line); border-radius:8px; padding:6px 8px; font:inherit; background:#fff;" />
            <label class="muted" style="display:block; margin-top:8px;">Role</label>
            <select id="inviteRole" style="width:100%;">
              <option value="member" selected>User</option>
              <option value="admin">Administrator</option>
            </select>
            <label class="muted" style="display:block; margin-top:8px;">
              <input id="inviteSendEmail" type="checkbox" checked /> Send invite email automatically
            </label>
            <div style="margin-top:10px;">
              <button id="inviteCreateBtn" class="primary" type="button">Create Invite</button>
            </div>
          </div>
          <div id="adminInviteStatus" class="status">Ready.</div>
          <div id="adminInvitesTable" class="muted" style="margin-top:8px;">No invites loaded.</div>
        </div>
        <div class="card" style="margin-top:12px;">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
            <h3 style="margin:0;">Registration Requests</h3>
            <button id="adminRefreshRegsBtn" class="chip" type="button">Refresh</button>
          </div>
          <div id="adminRegStatus" class="status">Ready.</div>
          <div id="adminRegistrationsTable" class="muted" style="margin-top:8px;">No registration requests.</div>
        </div>
      </div>

      <div id="adminGeoSection" class="hidden">
        <div class="card">
          <h3 style="margin:0 0 8px;">GEO Search Configuration</h3>
          <div class="muted" style="margin-bottom:8px;">Edit scoring rules, questions, funnels, and categories used for GEO measurement runs.</div>
          <div id="adminGeoStatus" class="status">Ready.</div>
          <div id="adminGeoMeta" class="muted" style="margin-top:8px;">Current config version: unknown.</div>
        </div>
        <div class="grid2">
          <div class="card">
            <h3 style="margin:0 0 8px;">Scoring Criteria</h3>
            <div class="option">
              <strong>Sentiment</strong>
              <label class="muted" style="display:block; margin-top:6px;">Positive Keywords (comma/newline)</label>
              <textarea id="geoSentimentPositive" style="width:100%;min-height:70px;border:1px solid var(--line);border-radius:8px;padding:6px 8px;font:inherit;background:#fff;"></textarea>
              <label class="muted" style="display:block; margin-top:6px;">Negative Keywords (comma/newline)</label>
              <textarea id="geoSentimentNegative" style="width:100%;min-height:70px;border:1px solid var(--line);border-radius:8px;padding:6px 8px;font:inherit;background:#fff;"></textarea>
            </div>
            <div class="option">
              <strong>Specificity</strong>
              <label class="muted" style="display:block; margin-top:6px;">Known Place Keywords (comma/newline)</label>
              <textarea id="geoSpecificityKeywords" style="width:100%;min-height:70px;border:1px solid var(--line);border-radius:8px;padding:6px 8px;font:inherit;background:#fff;"></textarea>
            </div>
            <div class="option">
              <strong>Brand Alignment</strong>
              <label class="muted" style="display:block; margin-top:6px;">Pillar Keywords (comma/newline)</label>
              <textarea id="geoBrandKeywords" style="width:100%;min-height:70px;border:1px solid var(--line);border-radius:8px;padding:6px 8px;font:inherit;background:#fff;"></textarea>
            </div>
          </div>
          <div class="card">
            <h3 style="margin:0 0 8px;">Categories</h3>
            <div class="option">
              <label class="muted" style="display:block;">New Category Name</label>
              <input id="geoNewCategoryName" type="text" placeholder="Seasonality (Spring)" style="width:100%; border:1px solid var(--line); border-radius:8px; padding:6px 8px; font:inherit; background:#fff;" />
              <button id="geoAddCategoryBtn" class="chip" type="button" style="margin-top:8px;">Add Category</button>
            </div>
            <div id="geoCategoryList" class="muted" style="margin-top:8px;">No categories.</div>
          </div>
        </div>
        <div class="card" style="margin-top:12px;">
          <h3 style="margin:0 0 8px;">Questions</h3>
          <div class="option">
            <label class="muted" style="display:block;">Question</label>
            <input id="geoNewQuestionPrompt" type="text" placeholder="What are the best places to eat in Vancouver?" style="width:100%; border:1px solid var(--line); border-radius:8px; padding:6px 8px; font:inherit; background:#fff;" />
            <div style="display:flex; gap:8px; margin-top:8px; flex-wrap:wrap;">
              <label class="muted">Category
                <select id="geoNewQuestionCategory"></select>
              </label>
              <label class="muted">Funnel
                <select id="geoNewQuestionFunnel">
                  <option value="high">high</option>
                  <option value="mid">mid</option>
                  <option value="low">low</option>
                </select>
              </label>
              <button id="geoAddQuestionBtn" class="chip" type="button">Add Question</button>
            </div>
          </div>
          <div id="geoQuestionsTable" class="muted" style="margin-top:8px;">No questions.</div>
          <div style="margin-top:10px;">
            <button id="geoSaveConfigBtn" class="primary" type="button">Save GEO Config</button>
          </div>
        </div>
      </div>

      <div id="adminAppearanceSection" class="hidden">
        <div class="card">
          <h3 style="margin:0 0 8px;">Brand Appearance</h3>
          <div class="muted" style="margin-bottom:8px;">Set destination-specific UI palette. Applied to this org only.</div>
          <div id="adminAppearanceStatus" class="status">Ready.</div>
          <div id="adminAppearanceMeta" class="muted" style="margin-top:8px;">Current palette is active.</div>
        </div>
        <div class="grid2">
          <div class="card">
            <h3 style="margin:0 0 8px;">Palette</h3>
            <div class="option">
              <label class="muted" style="display:block;">Background</label>
              <input id="appBg" type="color" />
              <label class="muted" style="display:block; margin-top:8px;">Card</label>
              <input id="appCard" type="color" />
              <label class="muted" style="display:block; margin-top:8px;">Text</label>
              <input id="appInk" type="color" />
              <label class="muted" style="display:block; margin-top:8px;">Muted Text</label>
              <input id="appMuted" type="color" />
              <label class="muted" style="display:block; margin-top:8px;">Line</label>
              <input id="appLine" type="color" />
              <label class="muted" style="display:block; margin-top:8px;">Accent</label>
              <input id="appAccent" type="color" />
              <label class="muted" style="display:block; margin-top:8px;">Accent 2</label>
              <input id="appAccent2" type="color" />
              <label class="muted" style="display:block; margin-top:8px;">Error</label>
              <input id="appErr" type="color" />
            </div>
            <div style="margin-top:10px; display:flex; gap:8px; flex-wrap:wrap;">
              <button id="appearanceSuggestBtn" class="chip" type="button">Suggest Palette</button>
              <button id="appearanceResetBtn" class="chip" type="button">Reset Default</button>
              <button id="appearanceSaveBtn" class="primary" type="button">Save Appearance</button>
            </div>
          </div>
          <div class="card">
            <h3 style="margin:0 0 8px;">Preview</h3>
            <div id="appearancePreview" class="option">
              <div style="font-weight:700; margin-bottom:8px;">GEOrge Theme Preview</div>
              <div class="muted">This preview uses your selected destination colors.</div>
              <div style="display:flex; gap:8px; margin-top:10px; align-items:center;">
                <button class="chip" type="button">Secondary</button>
                <button class="primary" type="button">Primary</button>
              </div>
              <div style="margin-top:10px; border:1px solid var(--line); border-radius:8px; padding:8px;">
                <div style="height:8px; background:#eaf1ec; border-radius:999px; overflow:hidden;">
                  <div style="height:100%; width:62%; background:linear-gradient(90deg,var(--accent),var(--accent2));"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const ORG_HINT = ${JSON.stringify(String(orgHint || ""))};
    const DEFAULT_GEO_CONFIG = ${JSON.stringify(DEFAULT_GEO_CONFIG)};
    const DEFAULT_APPEARANCE = ${JSON.stringify(DEFAULT_APPEARANCE)};
    let currentRange = "today";
    let batches = [];
    let detailsCache = new Map();
    let runBusy = false;
    let runRange = "day";
    let drillType = "market";
    let drillValue = "";
    let trendRange = "month";
    let trendGranularity = "auto";
    let qualityQuestionRows = [];
    let qualityQuestionSortKey = "";
    let qualityQuestionSortDir = "desc";
    let adminUsers = [];
    let adminResetRequests = [];
    let adminInvites = [];
    let adminRegistrationRequests = [];
    let adminCapability = false;
    let adminSection = "users";
    let geoConfig = JSON.parse(JSON.stringify(DEFAULT_GEO_CONFIG));
    let adminGeoConfig = JSON.parse(JSON.stringify(DEFAULT_GEO_CONFIG));
    let appearanceConfig = JSON.parse(JSON.stringify(DEFAULT_APPEARANCE));
    let adminAppearanceConfig = JSON.parse(JSON.stringify(DEFAULT_APPEARANCE));
    let geoConfigVersions = [];
    const REPORT_TZ = "America/Vancouver";
    let sessionToken = localStorage.getItem("dmo_session_token") || "";
    let currentUser = null;

    async function apiFetch(url, options = {}) {
      const opts = { ...options, headers: { ...(options.headers || {}) } };
      if (sessionToken) opts.headers["x-dmo-session"] = sessionToken;
      if (ORG_HINT) opts.headers["x-dmo-org"] = ORG_HINT;
      return fetch(url, opts);
    }
    function setIdentity(user, org) {
      currentUser = user || null;
      const el = document.getElementById("identity");
      const logo = document.getElementById("orgLogo");
      if (!user) {
        adminCapability = false;
        el.textContent = "Not signed in.";
        if (logo) logo.src = "/assets/destination-vancouver-logo.png";
        applyAppearanceTheme(DEFAULT_APPEARANCE);
        updateAdminVisibility();
        return;
      }
      const orgName = org?.name || org?.orgId || user.orgId || "";
      if (logo && org?.logoUrl) logo.src = org.logoUrl;
      el.innerHTML =
        "Signed in as <strong>" + esc(user.email || "") + "</strong> (" + esc(user.role || "member") + ")" +
        " | Org: <strong>" + esc(orgName) + "</strong>" +
        " <button id='changePwdBtn' class='chip' style='margin-left:8px;'>Change Password</button>" +
        " <button id='logoutBtn' class='chip' style='margin-left:8px;'>Logout</button>";
      const changePwd = document.getElementById("changePwdBtn");
      if (changePwd) {
        changePwd.onclick = () => showPasswordModal("Enter your current password and choose a new one.");
      }
      const logout = document.getElementById("logoutBtn");
      if (logout) {
        logout.onclick = async () => {
          await apiFetch("/api/auth/logout", { method: "POST" });
          sessionToken = "";
          localStorage.removeItem("dmo_session_token");
          setIdentity(null, null);
          showLogin("Logged out.");
        };
      }
      updateAdminVisibility();
    }
    function isAdminUser() {
      const role = String(currentUser?.role || "").trim().toLowerCase();
      return role === "admin" || role.includes("admin") || adminCapability;
    }
    function updateAdminVisibility() {
      const adminBtn = document.getElementById("tabAdminBtn");
      const adminPane = document.getElementById("tabAdmin");
      if (!adminBtn || !adminPane) return;
      adminBtn.className = String(adminBtn.className || "")
        .trim()
        .split(" ")
        .filter((c) => c && c !== "hidden")
        .join(" ")
        .trim() || "tab";
      if (!adminBtn.className.includes("tab")) adminBtn.className = "tab";
      adminBtn.style.display = "";
      adminBtn.hidden = false;
      if (!isAdminUser()) {
        const classes = String(adminBtn.className || "").trim().split(" ").filter(Boolean);
        const adminWasActive = adminPane.className !== "hidden" || classes.includes("active");
        if (adminWasActive) setTab("overview");
        adminPane.className = "hidden";
      }
    }
    async function refreshAdminCapability() {
      if (!currentUser || !sessionToken) return;
      try {
        const res = await apiFetch("/api/admin/users");
        adminCapability = res.ok;
        if (res.ok && String(currentUser.role || "").trim().toLowerCase() !== "admin") {
          currentUser = { ...currentUser, role: "admin" };
        }
        updateAdminVisibility();
      } catch {
        adminCapability = false;
        updateAdminVisibility();
      }
    }
    function showLogin(message) {
      const overlay = document.getElementById("loginOverlay");
      overlay.style.display = "flex";
      document.getElementById("loginStatus").textContent = message || "Enter your credentials.";
    }
    function hideLogin() {
      document.getElementById("loginOverlay").style.display = "none";
    }
    function showPasswordModal(message, err) {
      document.getElementById("passwordOverlay").style.display = "flex";
      const el = document.getElementById("pwdStatus");
      el.textContent = message || "Enter your current password and choose a new one.";
      el.className = "status" + (err ? " err" : "");
    }
    function hidePasswordModal() {
      document.getElementById("passwordOverlay").style.display = "none";
      document.getElementById("pwdCurrent").value = "";
      document.getElementById("pwdNew").value = "";
      document.getElementById("pwdConfirm").value = "";
    }
    async function checkSession() {
      if (!sessionToken) return false;
      const res = await apiFetch("/api/auth/me");
      if (!res.ok) return false;
      const data = await res.json();
      setIdentity(data.user, data.org);
      refreshAdminCapability();
      return true;
    }
    async function requireAuthReady() {
      const ok = await checkSession();
      if (!ok) {
        showLogin("Sign in to continue.");
        throw new Error("Unauthorized");
      }
    }
    function esc(v) {
      return String(v || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
    function setTab(tab) {
      const panes = {
        overview: "tabOverview",
        drill: "tabDrill",
        quality: "tabQuality",
        run: "tabRun",
        admin: "tabAdmin",
      };
      const buttons = {
        overview: "tabOverviewBtn",
        drill: "tabDrillBtn",
        quality: "tabQualityBtn",
        run: "tabRunBtn",
        admin: "tabAdminBtn",
      };
      Object.keys(panes).forEach((key) => {
        const pane = document.getElementById(panes[key]);
        const button = document.getElementById(buttons[key]);
        if (!pane || !button) return;
        pane.className = key === tab ? "" : "hidden";
        button.className = key === tab ? "tab active" : "tab";
      });
    }
    function setAdminStatus(text, err) {
      const el = document.getElementById("adminStatus");
      if (!el) return;
      el.textContent = text;
      el.className = "status" + (err ? " err" : "");
    }
    function setInviteStatus(text, err) {
      const el = document.getElementById("adminInviteStatus");
      if (!el) return;
      el.textContent = text;
      el.className = "status" + (err ? " err" : "");
    }
    function setRegStatus(text, err) {
      const el = document.getElementById("adminRegStatus");
      if (!el) return;
      el.textContent = text;
      el.className = "status" + (err ? " err" : "");
    }
    function setGeoStatus(text, err) {
      const el = document.getElementById("adminGeoStatus");
      if (!el) return;
      el.textContent = text;
      el.className = "status" + (err ? " err" : "");
    }
    function setGeoMeta(text) {
      const el = document.getElementById("adminGeoMeta");
      if (!el) return;
      el.textContent = text || "Current config version: unknown.";
    }
    function setAppearanceStatus(text, err) {
      const el = document.getElementById("adminAppearanceStatus");
      if (!el) return;
      el.textContent = text;
      el.className = "status" + (err ? " err" : "");
    }
    function setAppearanceMeta(text) {
      const el = document.getElementById("adminAppearanceMeta");
      if (!el) return;
      el.textContent = text || "Current palette is active.";
    }
    function setAdminSection(section) {
      adminSection = section === "geo" ? "geo" : (section === "appearance" ? "appearance" : "users");
      const usersBtn = document.getElementById("adminSectionUsersBtn");
      const geoBtn = document.getElementById("adminSectionGeoBtn");
      const appearanceBtn = document.getElementById("adminSectionAppearanceBtn");
      const usersPane = document.getElementById("adminUsersSection");
      const geoPane = document.getElementById("adminGeoSection");
      const appearancePane = document.getElementById("adminAppearanceSection");
      if (usersBtn) usersBtn.className = adminSection === "users" ? "tab active" : "tab";
      if (geoBtn) geoBtn.className = adminSection === "geo" ? "tab active" : "tab";
      if (appearanceBtn) appearanceBtn.className = adminSection === "appearance" ? "tab active" : "tab";
      if (usersPane) usersPane.className = adminSection === "users" ? "" : "hidden";
      if (geoPane) geoPane.className = adminSection === "geo" ? "" : "hidden";
      if (appearancePane) appearancePane.className = adminSection === "appearance" ? "" : "hidden";
    }
    function splitKeywordText(value) {
      return String(value || "")
        .split(",")
        .flatMap((v) => String(v || "").split("\\n"))
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean);
    }
    function joinKeywords(arr) {
      return (Array.isArray(arr) ? arr : []).join(", ");
    }
    function getCategoryNameById(categoryId) {
      const c = (adminGeoConfig?.categories || []).find((x) => x.id === categoryId);
      return c?.name || categoryId || "unknown";
    }
    function renderGeoCategories() {
      const root = document.getElementById("geoCategoryList");
      const select = document.getElementById("geoNewQuestionCategory");
      const categories = Array.isArray(adminGeoConfig?.categories) ? adminGeoConfig.categories : [];
      if (root) {
        root.innerHTML = categories.length
          ? categories.map((c) => "<span class='chip' style='margin-right:6px;'>" + esc(c.name) + " <span class='muted'>(" + esc(c.id) + ")</span></span>").join("")
          : "No categories.";
      }
      if (select) {
        select.innerHTML = categories.map((c) => "<option value='" + esc(c.id) + "'>" + esc(c.name) + "</option>").join("");
      }
    }
    function renderGeoQuestions() {
      const root = document.getElementById("geoQuestionsTable");
      if (!root) return;
      const questions = Array.isArray(adminGeoConfig?.questions) ? adminGeoConfig.questions : [];
      const categories = Array.isArray(adminGeoConfig?.categories) ? adminGeoConfig.categories : [];
      if (!questions.length) {
        root.textContent = "No questions.";
        return;
      }
      const categoryOptions = categories
        .map((c) => "<option value='" + esc(c.id) + "'>" + esc(c.name) + "</option>")
        .join("");
      const rows = questions.map((q) => {
        return "<tr data-qid='" + esc(q.id || "") + "'>" +
          "<td><input data-qprompt type='text' value='" + esc(q.prompt || "") + "' style='width:100%;border:1px solid var(--line);border-radius:8px;padding:4px 6px;font:inherit;background:#fff;' /></td>" +
          "<td><select data-qcategory>" + categoryOptions + "</select></td>" +
          "<td><select data-qfunnel>" +
            "<option value='high'" + (q.funnel === "high" ? " selected" : "") + ">high</option>" +
            "<option value='mid'" + (q.funnel === "mid" ? " selected" : "") + ">mid</option>" +
            "<option value='low'" + (q.funnel === "low" ? " selected" : "") + ">low</option>" +
          "</select></td>" +
          "<td><button class='chip' data-qremove>Remove</button></td>" +
        "</tr>";
      }).join("");
      root.innerHTML = "<table><thead><tr><th>Question</th><th>Category</th><th>Funnel</th><th>Action</th></tr></thead><tbody>" + rows + "</tbody></table>";
      const tbodyRows = root.querySelectorAll("tbody tr[data-qid]");
      tbodyRows.forEach((row) => {
        const qid = row.getAttribute("data-qid");
        const q = questions.find((x) => x.id === qid);
        if (!q) return;
        const cat = row.querySelector("select[data-qcategory]");
        if (cat) cat.value = q.categoryId;
      });
    }
    function renderGeoCriteria() {
      const qc = adminGeoConfig?.qualityCriteria || {};
      const s = qc.sentiment || {};
      const sp = qc.specificity || {};
      const b = qc.brand_alignment || {};
      const a = document.getElementById("geoSentimentPositive");
      const c = document.getElementById("geoSentimentNegative");
      const d = document.getElementById("geoSpecificityKeywords");
      const e = document.getElementById("geoBrandKeywords");
      if (a) a.value = joinKeywords(s.positiveKeywords);
      if (c) c.value = joinKeywords(s.negativeKeywords);
      if (d) d.value = joinKeywords(sp.knownPlaceKeywords);
      if (e) e.value = joinKeywords(b.pillarKeywords);
    }
    function renderGeoConfigEditor() {
      renderGeoCriteria();
      renderGeoCategories();
      renderGeoQuestions();
    }
    function collectGeoConfigFromEditor() {
      const categories = Array.isArray(adminGeoConfig?.categories) ? adminGeoConfig.categories.slice() : [];
      const rows = [...document.querySelectorAll("#geoQuestionsTable tbody tr[data-qid]")];
      const questions = rows.map((row) => ({
        id: row.getAttribute("data-qid") || "",
        prompt: String(row.querySelector("[data-qprompt]")?.value || "").trim(),
        categoryId: String(row.querySelector("[data-qcategory]")?.value || ""),
        funnel: String(row.querySelector("[data-qfunnel]")?.value || "unknown"),
      })).filter((q) => q.prompt);
      return {
        version: 1,
        categories,
        questions,
        qualityCriteria: {
          sentiment: {
            label: "Sentiment",
            description: "Tone quality when Vancouver is mentioned.",
            positiveKeywords: splitKeywordText(document.getElementById("geoSentimentPositive")?.value || ""),
            negativeKeywords: splitKeywordText(document.getElementById("geoSentimentNegative")?.value || ""),
          },
          specificity: {
            label: "Specificity",
            description: "Presence of specific places/details in response.",
            knownPlaceKeywords: splitKeywordText(document.getElementById("geoSpecificityKeywords")?.value || ""),
          },
          brand_alignment: {
            label: "Brand Alignment",
            description: "Alignment with strategic brand pillars.",
            pillarKeywords: splitKeywordText(document.getElementById("geoBrandKeywords")?.value || ""),
          },
        },
      };
    }
    async function loadGeoConfigForAdmin() {
      setGeoStatus("Loading GEO config...");
      const res = await apiFetch("/api/admin/geo-config");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setGeoStatus(data?.error || "Failed to load GEO config.", true);
        return false;
      }
      adminGeoConfig = data || JSON.parse(JSON.stringify(DEFAULT_GEO_CONFIG));
      const version = String(adminGeoConfig?.configVersionId || "unversioned");
      const updatedAt = formatZonedDateTime(adminGeoConfig?.updatedAt || "");
      const updatedBy = String(adminGeoConfig?.updatedBy || "unknown");
      setGeoMeta("Current config: " + version + " | Updated: " + (updatedAt || "unknown") + " | By: " + updatedBy);
      const versionsRes = await apiFetch("/api/admin/geo-config/versions");
      const versionsData = await versionsRes.json().catch(() => []);
      geoConfigVersions = versionsRes.ok && Array.isArray(versionsData) ? versionsData : [];
      renderGeoConfigEditor();
      setGeoStatus("Loaded. Versions available: " + String(geoConfigVersions.length));
      return true;
    }
    async function saveGeoConfigFromAdmin() {
      const payload = collectGeoConfigFromEditor();
      setGeoStatus("Saving GEO config...");
      const res = await apiFetch("/api/admin/geo-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setGeoStatus(data?.error || "Failed to save GEO config.", true);
        return false;
      }
      adminGeoConfig = data?.config || payload;
      geoConfig = adminGeoConfig;
      const version = String(adminGeoConfig?.configVersionId || "unversioned");
      const updatedAt = formatZonedDateTime(adminGeoConfig?.updatedAt || "");
      const updatedBy = String(adminGeoConfig?.updatedBy || "unknown");
      setGeoMeta("Current config: " + version + " | Updated: " + (updatedAt || "unknown") + " | By: " + updatedBy);
      if (Array.isArray(data?.versions)) geoConfigVersions = data.versions;
      renderGeoConfigEditor();
      setGeoStatus("Saved as " + version + ".");
      return true;
    }
    async function loadGeoConfigForDashboard() {
      const res = await apiFetch("/api/geo/config");
      if (!res.ok) return;
      const data = await res.json().catch(() => null);
      if (data) geoConfig = data;
    }
    function applyAppearanceTheme(theme) {
      const palette = theme?.palette || DEFAULT_APPEARANCE.palette;
      const root = document.documentElement;
      const keys = ["bg", "card", "ink", "muted", "line", "accent", "accent2", "err"];
      keys.forEach((k) => {
        const v = String(palette?.[k] || DEFAULT_APPEARANCE.palette[k] || "").trim();
        if (v) root.style.setProperty("--" + k, v);
      });
    }
    function renderAppearanceEditor() {
      const palette = adminAppearanceConfig?.palette || DEFAULT_APPEARANCE.palette;
      const set = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.value = String(value || "");
      };
      set("appBg", palette.bg);
      set("appCard", palette.card);
      set("appInk", palette.ink);
      set("appMuted", palette.muted);
      set("appLine", palette.line);
      set("appAccent", palette.accent);
      set("appAccent2", palette.accent2);
      set("appErr", palette.err);
      applyAppearanceTheme({ palette });
    }
    function collectAppearanceFromEditor() {
      const read = (id, fallback) => {
        const v = String(document.getElementById(id)?.value || "").trim();
        return v || fallback;
      };
      return {
        palette: {
          bg: read("appBg", DEFAULT_APPEARANCE.palette.bg),
          card: read("appCard", DEFAULT_APPEARANCE.palette.card),
          ink: read("appInk", DEFAULT_APPEARANCE.palette.ink),
          muted: read("appMuted", DEFAULT_APPEARANCE.palette.muted),
          line: read("appLine", DEFAULT_APPEARANCE.palette.line),
          accent: read("appAccent", DEFAULT_APPEARANCE.palette.accent),
          accent2: read("appAccent2", DEFAULT_APPEARANCE.palette.accent2),
          err: read("appErr", DEFAULT_APPEARANCE.palette.err),
        },
      };
    }
    async function loadAppearanceForDashboard() {
      const res = await apiFetch("/api/appearance");
      if (!res.ok) return false;
      const data = await res.json().catch(() => null);
      if (!data) return false;
      appearanceConfig = data;
      applyAppearanceTheme(appearanceConfig);
      return true;
    }
    async function loadAppearanceForAdmin() {
      setAppearanceStatus("Loading appearance...");
      const res = await apiFetch("/api/admin/appearance");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAppearanceStatus(data?.error || "Failed to load appearance.", true);
        return false;
      }
      adminAppearanceConfig = data || JSON.parse(JSON.stringify(DEFAULT_APPEARANCE));
      appearanceConfig = adminAppearanceConfig;
      renderAppearanceEditor();
      setAppearanceMeta(
        "Updated: " + (formatZonedDateTime(adminAppearanceConfig?.updatedAt || "") || "n/a") +
        " | By: " + String(adminAppearanceConfig?.updatedBy || "system")
      );
      setAppearanceStatus("Loaded.");
      return true;
    }
    async function saveAppearanceFromAdmin() {
      const payload = collectAppearanceFromEditor();
      setAppearanceStatus("Saving appearance...");
      const res = await apiFetch("/api/admin/appearance", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAppearanceStatus(data?.error || "Failed to save appearance.", true);
        return false;
      }
      adminAppearanceConfig = data?.appearance || payload;
      appearanceConfig = adminAppearanceConfig;
      renderAppearanceEditor();
      setAppearanceMeta(
        "Updated: " + (formatZonedDateTime(adminAppearanceConfig?.updatedAt || "") || "n/a") +
        " | By: " + String(adminAppearanceConfig?.updatedBy || "system")
      );
      setAppearanceStatus("Saved.");
      return true;
    }
    async function suggestAppearanceFromAdmin() {
      setAppearanceStatus("Generating suggested palette...");
      const res = await apiFetch("/api/admin/appearance/suggest", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAppearanceStatus(data?.error || "Failed to generate suggestion.", true);
        return false;
      }
      adminAppearanceConfig = data?.appearance || JSON.parse(JSON.stringify(DEFAULT_APPEARANCE));
      appearanceConfig = adminAppearanceConfig;
      renderAppearanceEditor();
      setAppearanceStatus("Suggested palette loaded. Save to apply permanently.");
      return true;
    }
    function renderAdminResetRequests() {
      const root = document.getElementById("adminResetRequests");
      if (!root) return;
      if (!adminResetRequests.length) {
        root.textContent = "No pending reset requests.";
        return;
      }
      const rows = adminResetRequests.map((r) => {
        return "<tr data-reset-id='" + esc(r.requestId || "") + "'>" +
          "<td>" + esc(r.email || "") + "</td>" +
          "<td>" + esc(formatZonedDateTime(r.requestedAt || "")) + "</td>" +
          "<td><input type='password' data-reset-password style='width:180px;border:1px solid var(--line);border-radius:8px;padding:4px 6px;font:inherit;background:#fff;' placeholder='New password' /></td>" +
          "<td><button class='chip' data-reset-apply>Set Password</button></td>" +
          "</tr>";
      }).join("");
      root.innerHTML = "<table><thead><tr><th>Email</th><th>Requested</th><th>New Password</th><th>Action</th></tr></thead><tbody>" + rows + "</tbody></table>";
    }
    function renderAdminInvites() {
      const root = document.getElementById("adminInvitesTable");
      if (!root) return;
      if (!adminInvites.length) {
        root.textContent = "No invites found.";
        return;
      }
      const rows = adminInvites.map((i) => {
        const status = String(i.status || "");
        const rescindBtn = status === "pending" ? "<button class='chip' data-invite-revoke>Rescind</button>" : "";
        const removeBtn = "<button class='chip' data-invite-delete>Remove</button>";
        return "<tr data-invite-id='" + esc(i.inviteId || "") + "'>" +
          "<td>" + esc(i.email || "") + "</td>" +
          "<td>" + esc(i.role || "member") + "</td>" +
          "<td>" + esc(status || "pending") + "</td>" +
          "<td>" + esc(formatZonedDateTime(i.createdAt || "")) + "</td>" +
          "<td>" + (i.inviteUrl ? ("<a href='" + esc(i.inviteUrl) + "' target='_blank' rel='noopener'>Open</a>") : "") + "</td>" +
          "<td>" + rescindBtn + " " + removeBtn + "</td>" +
        "</tr>";
      }).join("");
      root.innerHTML = "<table><thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Created</th><th>Link</th><th>Action</th></tr></thead><tbody>" + rows + "</tbody></table>";
    }
    function renderAdminRegistrations() {
      const root = document.getElementById("adminRegistrationsTable");
      if (!root) return;
      if (!adminRegistrationRequests.length) {
        root.textContent = "No registration requests.";
        return;
      }
      const rows = adminRegistrationRequests.map((r) => {
        const pending = String(r.status || "") === "pending";
        return "<tr data-reg-id='" + esc(r.requestId || "") + "'>" +
          "<td>" + esc(r.name || "") + "</td>" +
          "<td>" + esc(r.email || "") + "</td>" +
          "<td>" + esc(r.status || "pending") + "</td>" +
          "<td>" + esc(formatZonedDateTime(r.requestedAt || "")) + "</td>" +
          "<td>" + (pending ? "<button class='chip' data-reg-approve>Approve</button> <button class='chip' data-reg-reject>Reject</button>" : "") + "</td>" +
        "</tr>";
      }).join("");
      root.innerHTML = "<table><thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Requested</th><th>Action</th></tr></thead><tbody>" + rows + "</tbody></table>";
    }
    function renderAdminUsers() {
      const root = document.getElementById("adminUsersTable");
      if (!root) return;
      if (!adminUsers.length) {
        root.textContent = "No users found.";
        return;
      }
      const rows = adminUsers
        .slice()
        .sort((a, b) => String(a.email || "").localeCompare(String(b.email || "")))
        .map((u) => {
          const canDelete = String(u.userId || "") !== String(currentUser?.userId || "");
          const action = canDelete ? "<button class='chip' data-user-delete>Remove</button>" : "<span class='muted'>Current user</span>";
          return "<tr>" +
            "<td>" + esc(u.name || "") + "</td>" +
            "<td>" + esc(u.email || "") + "</td>" +
            "<td>" + esc(u.role || "member") + "</td>" +
            "<td>" + esc(formatZonedDateTime(u.createdAt || "")) + "</td>" +
            "<td>" + action + "</td>" +
          "</tr>";
        })
        .join("");
      root.innerHTML = "<table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Created</th><th>Action</th></tr></thead><tbody>" + rows + "</tbody></table>";
    }
    async function loadAdminUsers() {
      if (!sessionToken) return false;
      setAdminStatus("Loading users...");
      const [usersRes, resetsRes, invitesRes, regsRes] = await Promise.all([
        apiFetch("/api/admin/users"),
        apiFetch("/api/admin/reset-requests"),
        apiFetch("/api/admin/invites"),
        apiFetch("/api/admin/registration-requests"),
      ]);
      const userData = await usersRes.json().catch(() => ([]));
      const resetData = await resetsRes.json().catch(() => ([]));
      const inviteData = await invitesRes.json().catch(() => ([]));
      const regData = await regsRes.json().catch(() => ([]));
      if (!usersRes.ok) {
        setAdminStatus(userData?.error || "Failed to load users.", true);
        return false;
      }
      adminUsers = Array.isArray(userData) ? userData : [];
      adminResetRequests = Array.isArray(resetData) ? resetData : [];
      adminInvites = Array.isArray(inviteData) ? inviteData : [];
      adminRegistrationRequests = Array.isArray(regData) ? regData : [];
      renderAdminUsers();
      renderAdminResetRequests();
      renderAdminInvites();
      renderAdminRegistrations();
      setAdminStatus("Loaded " + adminUsers.length + " users.");
      return true;
    }
    async function resolveResetRequest(requestId, password) {
      const res = await apiFetch("/api/admin/reset-requests/" + encodeURIComponent(requestId) + "/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Failed to resolve request.");
      return data;
    }
    async function createInvite() {
      const name = String(document.getElementById("inviteName").value || "").trim();
      const email = String(document.getElementById("inviteEmail").value || "").trim().toLowerCase();
      const role = String(document.getElementById("inviteRole").value || "member");
      const sendEmail = Boolean(document.getElementById("inviteSendEmail").checked);
      if (!email) {
        setInviteStatus("Email is required.", true);
        return;
      }
      setInviteStatus("Creating invite...");
      const res = await apiFetch("/api/admin/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, role, sendEmail }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setInviteStatus(data?.error || "Failed to create invite.", true);
        return;
      }
      document.getElementById("inviteName").value = "";
      document.getElementById("inviteEmail").value = "";
      document.getElementById("inviteRole").value = "member";
      await loadAdminUsers();
      const suffix = data?.email?.delivered ? " Email sent." : " Copy link from Invites table.";
      setInviteStatus("Invite created." + suffix);
    }
    async function requestAccessRegistration() {
      const name = String(document.getElementById("registerName").value || "").trim();
      const email = String(document.getElementById("loginEmail").value || "").trim().toLowerCase();
      const status = document.getElementById("loginStatus");
      if (!email) {
        status.textContent = "Enter your email first.";
        return;
      }
      status.textContent = "Submitting registration request...";
      const res = await fetch("/api/auth/register-request", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(ORG_HINT ? { "x-dmo-org": ORG_HINT } : {}) },
        body: JSON.stringify({ name, email, orgId: ORG_HINT || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        status.textContent = data?.error || "Could not submit request.";
        return;
      }
      status.textContent = data?.message || "Request submitted for admin approval.";
    }
    async function approveRegistration(requestId) {
      const res = await apiFetch("/api/admin/registration-requests/" + encodeURIComponent(requestId) + "/approve", {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Failed to approve request.");
      return data;
    }
    async function rejectRegistration(requestId) {
      const res = await apiFetch("/api/admin/registration-requests/" + encodeURIComponent(requestId) + "/reject", {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Failed to reject request.");
      return data;
    }
    async function revokeInvite(inviteId) {
      const res = await apiFetch("/api/admin/invites/" + encodeURIComponent(inviteId) + "/revoke", {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Failed to revoke invite.");
      return data;
    }
    async function deleteInvite(inviteId) {
      const res = await apiFetch("/api/admin/invites/" + encodeURIComponent(inviteId), {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Failed to remove invite.");
      return data;
    }
    async function requestPasswordReset() {
      const email = String(document.getElementById("loginEmail").value || "").trim().toLowerCase();
      const status = document.getElementById("loginStatus");
      if (!email) {
        status.textContent = "Enter your email, then click Forgot password.";
        return;
      }
      status.textContent = "Submitting reset request...";
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, orgId: ORG_HINT || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        status.textContent = data?.error || "Unable to submit reset request.";
        return;
      }
      status.textContent = data?.message || "If your account exists, a reset request has been submitted.";
    }
    async function changeMyPassword() {
      const currentPassword = String(document.getElementById("pwdCurrent").value || "");
      const newPassword = String(document.getElementById("pwdNew").value || "");
      const confirmPassword = String(document.getElementById("pwdConfirm").value || "");
      if (!currentPassword || !newPassword) {
        showPasswordModal("Current and new password are required.", true);
        return;
      }
      if (newPassword !== confirmPassword) {
        showPasswordModal("New password and confirm password do not match.", true);
        return;
      }
      if (newPassword.length < 10) {
        showPasswordModal("New password must be at least 10 characters.", true);
        return;
      }
      showPasswordModal("Updating password...");
      const res = await apiFetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showPasswordModal(data?.error || "Failed to update password.", true);
        return;
      }
      if (data?.token) {
        sessionToken = data.token;
        localStorage.setItem("dmo_session_token", sessionToken);
      }
      hidePasswordModal();
      setRunStatus("Password updated.");
    }
    async function createAdminUser() {
      if (!isAdminUser()) return;
      const name = String(document.getElementById("adminNewName").value || "").trim();
      const email = String(document.getElementById("adminNewEmail").value || "").trim().toLowerCase();
      const password = String(document.getElementById("adminNewPassword").value || "");
      const role = String(document.getElementById("adminNewRole").value || "member");
      if (!email || !password) {
        setAdminStatus("Email and password are required.", true);
        return;
      }
      setAdminStatus("Creating user...");
      const res = await apiFetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password, role }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAdminStatus(data?.error || "Failed to create user.", true);
        return;
      }
      document.getElementById("adminNewName").value = "";
      document.getElementById("adminNewEmail").value = "";
      document.getElementById("adminNewPassword").value = "";
      document.getElementById("adminNewRole").value = "member";
      await loadAdminUsers();
      setAdminStatus("User created.");
    }
    async function removeUser(userId) {
      const res = await apiFetch("/api/admin/users/" + encodeURIComponent(userId), { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Failed to remove user.");
      return data;
    }
    function setRange(range) {
      currentRange = range;
      ["rangeToday","rangeWeek","rangeMonth","rangeAll","rangeCustom"].forEach((id) => {
        document.getElementById(id).className = "chip";
      });
      const id = { today:"rangeToday", week:"rangeWeek", month:"rangeMonth", all:"rangeAll", custom:"rangeCustom" }[range];
      if (id) document.getElementById(id).className = "chip active";
    }
    function setRunRange(range) {
      runRange = range;
      const ids = {
        day: "runRangeDay",
        week: "runRangeWeek",
        month: "runRangeMonth",
        all: "runRangeAll",
      };
      Object.values(ids).forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.className = "chip";
      });
      const active = document.getElementById(ids[range]);
      if (active) active.className = "chip active";
    }
    function setTrendRange(range) {
      trendRange = range;
      const ids = {
        month: "trendRangeMonth",
        quarter: "trendRangeQuarter",
        year: "trendRangeYear",
        all: "trendRangeAll",
        custom: "trendRangeCustom",
      };
      Object.values(ids).forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.className = "chip";
      });
      const active = document.getElementById(ids[range]);
      if (active) active.className = "chip active";
    }
    function parseDate(v) {
      const d = new Date(String(v || ""));
      return Number.isNaN(d.getTime()) ? null : d;
    }
    function zonedDayKey(date) {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: REPORT_TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(date);
      const y = parts.find((p) => p.type === "year")?.value || "0000";
      const m = parts.find((p) => p.type === "month")?.value || "01";
      const d = parts.find((p) => p.type === "day")?.value || "01";
      return y + "-" + m + "-" + d;
    }
    function zonedMonthKey(date) {
      return zonedDayKey(date).slice(0, 7);
    }
    function parseDayKey(key) {
      const m = String(key || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) return null;
      return {
        y: Number(m[1]),
        m: Number(m[2]),
        d: Number(m[3]),
      };
    }
    function shiftDayKey(key, deltaDays) {
      const p = parseDayKey(key);
      if (!p) return key;
      const dt = new Date(Date.UTC(p.y, p.m - 1, p.d));
      dt.setUTCDate(dt.getUTCDate() + deltaDays);
      const y = String(dt.getUTCFullYear());
      const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
      const d = String(dt.getUTCDate()).padStart(2, "0");
      return y + "-" + m + "-" + d;
    }
    function dayOfWeekFromDayKey(key) {
      const p = parseDayKey(key);
      if (!p) return 1;
      return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
    }
    function formatZonedDateTime(value) {
      const d = parseDate(value);
      if (!d) return String(value || "");
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: REPORT_TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(d);
      const y = parts.find((p) => p.type === "year")?.value || "";
      const m = parts.find((p) => p.type === "month")?.value || "";
      const day = parts.find((p) => p.type === "day")?.value || "";
      const h = parts.find((p) => p.type === "hour")?.value || "";
      const min = parts.find((p) => p.type === "minute")?.value || "";
      return y + "-" + m + "-" + day + " " + h + ":" + min;
    }
    function toIsoDay(d) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return y + "-" + m + "-" + day;
    }
    function addDays(d, n) {
      const out = new Date(d);
      out.setDate(out.getDate() + n);
      return out;
    }
    function weekStart(d) {
      const out = new Date(d);
      const dow = (out.getDay() + 6) % 7;
      out.setDate(out.getDate() - dow);
      out.setHours(0,0,0,0);
      return out;
    }
    function bucketStart(d, granularity) {
      if (granularity === "week") return weekStart(d);
      const out = new Date(d);
      out.setHours(0,0,0,0);
      return out;
    }
    function domainColor(domain) {
      const s = String(domain || "");
      let hash = 0;
      for (let i = 0; i < s.length; i += 1) {
        hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
      }
      const hue = Math.abs(hash) % 360;
      return "hsl(" + String(hue) + " 62% 42%)";
    }
    function logoUrl(domain) {
      return "https://www.google.com/s2/favicons?domain=" + encodeURIComponent(String(domain || "")) + "&sz=64";
    }
    function inRange(iso, range, start, end) {
      const d = parseDate(iso);
      if (!d) return false;
      const sampleDayKey = zonedDayKey(d);
      const now = new Date();
      if (range === "all") return true;
      if (range === "today") return sampleDayKey === zonedDayKey(now);
      if (range === "week") {
        const nowKey = zonedDayKey(now);
        const dow = (dayOfWeekFromDayKey(nowKey) + 6) % 7;
        const weekStartKey = shiftDayKey(nowKey, -dow);
        return sampleDayKey >= weekStartKey;
      }
      if (range === "month") return zonedMonthKey(d) === zonedMonthKey(now);
      if (range === "custom") {
        if (!start || !end) return false;
        return sampleDayKey >= String(start) && sampleDayKey <= String(end);
      }
      return false;
    }
    function isDvDomain(domain) {
      const d = String(domain || "").toLowerCase();
      return d.includes("destinationvancouver") || d.includes("tourismvancouver") || d.includes("vancouver");
    }
    function sourceCounts(samples, mode) {
      const rows = (samples || []).filter((s) => !s.error);
      let subset = rows;
      if (mode === "vancouver") subset = rows.filter((s) => s.vancouverMentioned);
      if (mode === "vancouver_top") subset = rows.filter((s) => s.vancouverRank === "top");
      const map = new Map();
      subset.forEach((s) => {
        [...new Set(s.sourceDomains || [])].forEach((d) => {
          if (mode === "non_dv" && isDvDomain(d)) return;
          map.set(d, (map.get(d) || 0) + 1);
        });
      });
      return [...map.entries()]
        .map(([domain, count]) => ({ domain, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
    }
    function sentimentScore(sample) {
      if (!sample.vancouverMentioned) return 1;
      const t = String(sample.answer || "").toLowerCase();
      const qc = sample?.__qualityCriteria?.sentiment || geoConfig?.qualityCriteria?.sentiment || {};
      const positive = Array.isArray(qc.positiveKeywords) && qc.positiveKeywords.length
        ? qc.positiveKeywords
        : DEFAULT_GEO_CONFIG.qualityCriteria.sentiment.positiveKeywords;
      const negative = Array.isArray(qc.negativeKeywords) && qc.negativeKeywords.length
        ? qc.negativeKeywords
        : DEFAULT_GEO_CONFIG.qualityCriteria.sentiment.negativeKeywords;
      const p = positive.filter((k) => t.includes(k)).length;
      const n = negative.filter((k) => t.includes(k)).length;
      if (n > 0) return 2;
      if (p >= 2) return 5;
      if (p === 1) return 4;
      return 3;
    }
    function specificityScore(sample) {
      if (!sample.vancouverMentioned) return 1;
      const t = String(sample.answer || "").toLowerCase();
      const qc = sample?.__qualityCriteria?.specificity || geoConfig?.qualityCriteria?.specificity || {};
      const known = Array.isArray(qc.knownPlaceKeywords) && qc.knownPlaceKeywords.length
        ? qc.knownPlaceKeywords
        : DEFAULT_GEO_CONFIG.qualityCriteria.specificity.knownPlaceKeywords;
      const hits = known.filter((k) => t.includes(k)).length;
      if (hits >= 2) return 5;
      if (hits === 1) return 4;
      return 3;
    }
    function brandAlignmentScore(sample) {
      if (!sample.vancouverMentioned) return 1;
      const t = String(sample.answer || "").toLowerCase();
      const qc = sample?.__qualityCriteria?.brand_alignment || geoConfig?.qualityCriteria?.brand_alignment || {};
      const pillars = Array.isArray(qc.pillarKeywords) && qc.pillarKeywords.length
        ? qc.pillarKeywords
        : DEFAULT_GEO_CONFIG.qualityCriteria.brand_alignment.pillarKeywords;
      const hits = pillars.filter((k) => t.includes(k)).length;
      if (hits >= 2) return 5;
      if (hits === 1) return 4;
      return 3;
    }
    function qualityScores(samples) {
      const all = (samples || []).filter((s) => !s.error);
      const mentioned = all.filter((s) => s.vancouverMentioned);
      const scored = mentioned.map((s) => ({
        market: s.market || "unknown",
        funnel: s.funnel || "unknown",
        question: s.question || "unknown",
        sentiment: sentimentScore(s),
        specificity: specificityScore(s),
        brand_alignment: brandAlignmentScore(s),
      }));
      const avgNum = (arr, key) => arr.length ? (arr.reduce((a, b) => a + Number(b[key] || 0), 0) / arr.length) : 0;
      const avg = (arr, key) => avgNum(arr, key).toFixed(2);
      const pct = (n, d) => d ? ((100 * n) / d).toFixed(1) + "%" : "0.0%";
      const by = (key) => {
        const groups = new Map();
        all.forEach((s) => {
          const k = s[key] || "unknown";
          const cur = groups.get(k) || { all: [], mentioned: [] };
          cur.all.push(s);
          if (s.vancouverMentioned) {
            cur.mentioned.push({
              sentiment: sentimentScore(s),
              specificity: specificityScore(s),
              brand_alignment: brandAlignmentScore(s),
            });
          }
          groups.set(k, cur);
        });
        return [...groups.entries()].map(([k, g]) => {
          const mentionRateDecimalByGroup = g.all.length ? (g.mentioned.length / g.all.length) : 0;
          const sAvg = avgNum(g.mentioned, "sentiment");
          const spAvg = avgNum(g.mentioned, "specificity");
          const bAvg = avgNum(g.mentioned, "brand_alignment");
          const criteriaAvg = g.mentioned.length ? ((sAvg + spAvg + bAvg) / 3) : 0;
          const totalContentQualityByGroup = mentionRateDecimalByGroup * criteriaAvg;
          return {
            key: k,
            mentionRate: pct(g.mentioned.length, g.all.length),
            sampleCount: g.mentioned.length,
            sentiment: avg(g.mentioned, "sentiment"),
            specificity: avg(g.mentioned, "specificity"),
            brand_alignment: avg(g.mentioned, "brand_alignment"),
            total_content_quality: totalContentQualityByGroup.toFixed(2),
          };
        });
      };
      const mentionRateDecimal = all.length ? (mentioned.length / all.length) : 0;
      const sentiment = avgNum(scored, "sentiment");
      const specificity = avgNum(scored, "specificity");
      const brand = avgNum(scored, "brand_alignment");
      const criteriaAverage = scored.length ? ((sentiment + specificity + brand) / 3) : 0;
      const totalContentQuality = mentionRateDecimal * criteriaAverage;
      return {
        totalSamples: all.length,
        sampleCount: scored.length,
        mentionRate: pct(mentioned.length, all.length),
        mentionRateDecimal,
        sentiment: sentiment.toFixed(2),
        specificity: specificity.toFixed(2),
        brand_alignment: brand.toFixed(2),
        totalContentQuality: totalContentQuality.toFixed(2),
        byMarket: by("market"),
        byFunnel: by("funnel"),
        byQuestion: by("question"),
      };
    }
    function aggregate(samples) {
      const ok = (samples || []).filter((s) => !s.error);
      const total = ok.length;
      const mention = ok.filter((s) => s.vancouverMentioned).length;
      const top = ok.filter((s) => s.vancouverRank === "top").length;
      const included = ok.filter((s) => s.vancouverRank === "included").length;
      const pct = (n, d) => d ? (100 * n / d).toFixed(1) + "%" : "0.0%";

      const byKey = (key) => {
        const map = new Map();
        ok.forEach((s) => {
          const k = s[key] || "unknown";
          const cur = map.get(k) || { key:k, n:0, m:0, t:0 };
          cur.n += 1;
          if (s.vancouverMentioned) cur.m += 1;
          if (s.vancouverRank === "top") cur.t += 1;
          map.set(k, cur);
        });
        return [...map.values()].map((x) => ({
          key: x.key,
          sampleCount: x.n,
          mentionRate: x.n ? (100 * x.m / x.n) : 0,
          topRate: x.n ? (100 * x.t / x.n) : 0,
        })).sort((a,b) => b.topRate - a.topRate);
      };
      return {
        total,
        mentionRate: pct(mention, total),
        topRate: pct(top, total),
        includedRate: pct(top + included, total),
        visibilityScore: total ? Math.round(((mention/total) * 0.6 + (top/total) * 0.4) * 100) : 0,
        byMarket: byKey("market"),
        byFunnel: byKey("funnel"),
        sources: sourceCounts(ok, "all"),
        sourcesNoDv: sourceCounts(ok, "non_dv"),
        sourcesVancouver: sourceCounts(ok, "vancouver"),
      };
    }
    function renderBars(elId, rows, labelField, valueField, suffix, drillKind) {
      const root = document.getElementById(elId);
      if (!rows || rows.length === 0) {
        root.innerHTML = "<div class='muted'>No data.</div>";
        return;
      }
      const max = Math.max(...rows.map((r) => Number(r[valueField] || 0)), 1);
      root.innerHTML = rows.map((r) => {
        const value = Number(r[valueField] || 0);
        const width = Math.max(3, Math.round((value / max) * 100));
        const label = r[labelField];
        const shown = valueField === "count" ? String(value) : value.toFixed(1) + (suffix || "");
        const attrs = drillKind
          ? (" data-drill-kind='" + esc(drillKind) + "' data-drill-value='" + esc(label) + "'")
          : "";
        return "<div class='bar'" + attrs + ">" +
          "<div class='barTop'><strong>" + esc(label) + "</strong><span>" + esc(shown) + "</span></div>" +
          "<div class='track'><div class='fill' style='width:" + esc(width) + "%;'></div></div>" +
        "</div>";
      }).join("");
    }
    function renderTable(elId, rows, cols) {
      const root = document.getElementById(elId);
      if (!rows || rows.length === 0) {
        root.innerHTML = "<div class='muted'>No data.</div>";
        return;
      }
      root.innerHTML = "<table><thead><tr>" + cols.map((c) => "<th>" + esc(c) + "</th>").join("") + "</tr></thead><tbody>" +
        rows.map((r) => "<tr>" + cols.map((c) => "<td>" + esc(String(r[c] || "")) + "</td>").join("") + "</tr>").join("") +
        "</tbody></table>";
    }
    function renderQualityQuestionTable() {
      const cols = ["key", "mentionRate", "sampleCount", "sentiment", "specificity", "brand_alignment", "total_content_quality"];
      if (!qualityQuestionRows.length) {
        renderTable("qualityQuestion", [], cols);
        return;
      }
      const rows = [...qualityQuestionRows];
      if (qualityQuestionSortKey) {
        const dir = qualityQuestionSortDir === "asc" ? 1 : -1;
        const metricValue = (row, key) => {
          const raw = String(row?.[key] ?? "");
          if (key === "mentionRate") return Number(raw.replace(/[^0-9.-]/g, "")) || 0;
          return Number(raw) || 0;
        };
        rows.sort((a, b) => {
          const av = metricValue(a, qualityQuestionSortKey);
          const bv = metricValue(b, qualityQuestionSortKey);
          if (av !== bv) return (av - bv) * dir;
          return String(a.key || "").localeCompare(String(b.key || ""));
        });
      }
      renderTable("qualityQuestion", rows, cols);
    }
    function setQualityQuestionSort(metric, dir) {
      qualityQuestionSortKey = "";
      qualityQuestionSortDir = "desc";
      const sentiment = document.getElementById("qSortSentiment");
      const specificity = document.getElementById("qSortSpecificity");
      const brand = document.getElementById("qSortBrand");
      const mentionRate = document.getElementById("qSortMentionRate");
      const contentQuality = document.getElementById("qSortContentQuality");
      if (sentiment) sentiment.value = "none";
      if (specificity) specificity.value = "none";
      if (brand) brand.value = "none";
      if (mentionRate) mentionRate.value = "none";
      if (contentQuality) contentQuality.value = "none";
      if (dir === "none") {
        renderQualityQuestionTable();
        return;
      }
      if (metric === "sentiment") {
        qualityQuestionSortKey = "sentiment";
        qualityQuestionSortDir = dir;
        if (sentiment) sentiment.value = dir;
      } else if (metric === "specificity") {
        qualityQuestionSortKey = "specificity";
        qualityQuestionSortDir = dir;
        if (specificity) specificity.value = dir;
      } else if (metric === "brand_alignment") {
        qualityQuestionSortKey = "brand_alignment";
        qualityQuestionSortDir = dir;
        if (brand) brand.value = dir;
      } else if (metric === "mentionRate") {
        qualityQuestionSortKey = "mentionRate";
        qualityQuestionSortDir = dir;
        if (mentionRate) mentionRate.value = dir;
      } else if (metric === "total_content_quality") {
        qualityQuestionSortKey = "total_content_quality";
        qualityQuestionSortDir = dir;
        if (contentQuality) contentQuality.value = dir;
      }
      renderQualityQuestionTable();
    }
    function renderRunsByRange() {
      const list = document.getElementById("recentRuns");
      const rangeMap = { day: "today", week: "week", month: "month", all: "all" };
      const mappedRange = rangeMap[runRange] || "today";
      const scoped = batches.filter((b) => inRange(b.createdAt, mappedRange, "", ""));
      const done = scoped.filter((b) => b.status === "done");
      const avgMention = done.length
        ? Math.round((done.reduce((sum, b) => sum + Number(b.mentionRate || 0), 0) / done.length) * 100)
        : 0;
      const avgTop = done.length
        ? Math.round((done.reduce((sum, b) => sum + Number(b.topRate || 0), 0) / done.length) * 100)
        : 0;
      document.getElementById("runRangeMeta").textContent =
        "Runs: " + String(scoped.length) + " | Completed: " + String(done.length) +
        " | Avg Mention: " + String(avgMention) + "% | Avg Top: " + String(avgTop) + "%";
      if (!scoped.length) {
        list.innerHTML = "<div class='muted'>No runs in this period.</div>";
        return;
      }
      list.innerHTML = scoped.slice(0, 20).map((b) => {
        const date = formatZonedDateTime(b.createdAt);
        const cfg = String(b.geoConfigVersionId || "unversioned");
        return "<div style='padding:8px;border:1px solid var(--line);border-radius:8px;margin-bottom:8px;background:#fff;'>" +
          "<div><strong>" + esc(date) + "</strong> - " + esc(b.status || "") + "</div>" +
          "<div class='muted'>Mention: " + esc(String(Math.round((b.mentionRate || 0) * 100))) + "% | Top: " + esc(String(Math.round((b.topRate || 0) * 100))) + "% | Config: " + esc(cfg) + "</div>" +
        "</div>";
      }).join("");
    }
    async function loadBatches() {
      const res = await apiFetch("/api/geo/batches");
      batches = await res.json();
      renderRunsByRange();
    }
    async function getDetail(batchId) {
      if (detailsCache.has(batchId)) return detailsCache.get(batchId);
      const res = await apiFetch("/api/geo/batch/" + encodeURIComponent(batchId));
      if (!res.ok) return null;
      const data = await res.json();
      detailsCache.set(batchId, data);
      return data;
    }
    async function getScopedSamples() {
      const start = document.getElementById("rangeStart").value;
      const end = document.getElementById("rangeEnd").value;
      const scoped = batches.filter((b) => inRange(b.createdAt, currentRange, start, end));
      const details = await Promise.all(scoped.map((b) => getDetail(b.batchId)));
      const samples = details.filter(Boolean).flatMap((d) => {
        const qc =
          d?.geoConfigSnapshot?.qualityCriteria ||
          d?.config?.geoConfigSnapshot?.qualityCriteria ||
          geoConfig?.qualityCriteria ||
          DEFAULT_GEO_CONFIG.qualityCriteria;
        return (d.samples || []).map((s) => ({ ...s, __qualityCriteria: qc }));
      });
      return {
        scopedRuns: scoped.length,
        samples,
      };
    }
    async function getAllSamples() {
      const details = await Promise.all((batches || []).map((b) => getDetail(b.batchId)));
      return details.filter(Boolean).flatMap((d) => {
        const qc =
          d?.geoConfigSnapshot?.qualityCriteria ||
          d?.config?.geoConfigSnapshot?.qualityCriteria ||
          geoConfig?.qualityCriteria ||
          DEFAULT_GEO_CONFIG.qualityCriteria;
        return (d.samples || []).map((s) => ({ ...s, __qualityCriteria: qc }));
      });
    }
    async function renderQuestionTrend() {
      const meta = document.getElementById("trendMeta");
      const chart = document.getElementById("trendChart");
      const legend = document.getElementById("trendLegend");
      if (drillType !== "question" || !drillValue) {
        meta.textContent = "Select Slice = Question and choose a question to see source variability.";
        chart.innerHTML = "<div class='muted'>No question selected.</div>";
        legend.innerHTML = "";
        return;
      }

      const all = (await getAllSamples()).filter((s) => !s.error && (s.question || "unknown") === drillValue);
      if (!all.length) {
        meta.textContent = "No samples for this question.";
        chart.innerHTML = "<div class='muted'>No data.</div>";
        legend.innerHTML = "";
        return;
      }

      const byAt = all.filter((s) => parseDate(s.at));
      if (!byAt.length) {
        meta.textContent = "No timestamped samples for this question.";
        chart.innerHTML = "<div class='muted'>No data.</div>";
        legend.innerHTML = "";
        return;
      }

      const sortedAt = byAt.map((s) => parseDate(s.at)).sort((a, b) => a - b);
      const latest = sortedAt[sortedAt.length - 1];
      const earliest = sortedAt[0];
      let start = new Date(earliest);
      let end = new Date(latest);
      end.setHours(23,59,59,999);
      if (trendRange === "month") start = addDays(end, -30);
      if (trendRange === "quarter") start = addDays(end, -90);
      if (trendRange === "year") start = addDays(end, -365);
      if (trendRange === "custom") {
        const s = parseDate(document.getElementById("trendStart").value);
        const e = parseDate(document.getElementById("trendEnd").value);
        if (s && e) {
          start = s;
          end = new Date(e);
          end.setHours(23,59,59,999);
        }
      }
      if (start < earliest && trendRange !== "custom") start = new Date(earliest);

      const scoped = byAt.filter((s) => {
        const d = parseDate(s.at);
        return d && d >= start && d <= end;
      });
      if (!scoped.length) {
        meta.textContent = "No samples in selected period.";
        chart.innerHTML = "<div class='muted'>No data for selected period.</div>";
        legend.innerHTML = "";
        return;
      }

      const daySpan = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 86400000));
      const granularity = trendGranularity === "auto" ? (daySpan > 120 ? "week" : "day") : trendGranularity;
      const bucketMap = new Map();
      let cursor = bucketStart(start, granularity);
      const hardEnd = bucketStart(end, granularity);
      while (cursor <= hardEnd) {
        bucketMap.set(toIsoDay(cursor), new Date(cursor));
        cursor = addDays(cursor, granularity === "week" ? 7 : 1);
      }
      const bucketKeys = [...bucketMap.keys()];
      const counts = new Map();
      for (const sample of scoped) {
        const d = bucketStart(parseDate(sample.at), granularity);
        const key = toIsoDay(d);
        if (!bucketMap.has(key)) continue;
        const uniqDomains = [...new Set(sample.sourceDomains || [])];
        for (const domain of uniqDomains) {
          if (!counts.has(domain)) counts.set(domain, new Map());
          const perBucket = counts.get(domain);
          perBucket.set(key, (perBucket.get(key) || 0) + 1);
        }
      }
      const ranked = [...counts.entries()]
        .map(([domain, perBucket]) => ({
          domain,
          total: [...perBucket.values()].reduce((a, b) => a + b, 0),
        }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 8);
      if (!ranked.length) {
        meta.textContent = "No source domains captured in selected period.";
        chart.innerHTML = "<div class='muted'>No source-domain data.</div>";
        legend.innerHTML = "";
        return;
      }

      const pointsByDomain = ranked.map((r) => {
        const perBucket = counts.get(r.domain) || new Map();
        const values = bucketKeys.map((k) => Number(perBucket.get(k) || 0));
        return { domain: r.domain, total: r.total, values };
      });
      const yMax = Math.max(1, ...pointsByDomain.flatMap((d) => d.values));
      const w = 960;
      const h = 320;
      const ml = 40, mr = 12, mt = 12, mb = 36;
      const cw = w - ml - mr;
      const ch = h - mt - mb;
      const xFor = (i) => ml + (bucketKeys.length <= 1 ? 0 : (i * cw) / (bucketKeys.length - 1));
      const yFor = (v) => mt + ch - (v / yMax) * ch;
      const grid = [0, 0.25, 0.5, 0.75, 1].map((p) => {
        const y = mt + ch - (ch * p);
        const val = Math.round(yMax * p);
        return "<line x1='" + ml + "' y1='" + y.toFixed(1) + "' x2='" + (w - mr) + "' y2='" + y.toFixed(1) + "' stroke='#e5ece8' />" +
          "<text x='" + (ml - 6) + "' y='" + (y + 4).toFixed(1) + "' font-size='10' text-anchor='end' fill='#6b7b71'>" + String(val) + "</text>";
      }).join("");
      const lines = pointsByDomain.map((d) => {
        const color = domainColor(d.domain);
        const pts = d.values.map((v, i) => xFor(i).toFixed(1) + "," + yFor(v).toFixed(1)).join(" ");
        return "<polyline fill='none' stroke='" + color + "' stroke-width='2.2' points='" + pts + "' />";
      }).join("");
      const xTicks = (() => {
        const idx = bucketKeys.length <= 2 ? bucketKeys.map((_, i) => i) : [0, Math.floor((bucketKeys.length - 1) / 2), bucketKeys.length - 1];
        const uniq = [...new Set(idx)];
        return uniq.map((i) => {
          const x = xFor(i);
          const label = bucketKeys[i];
          return "<text x='" + x.toFixed(1) + "' y='" + (h - 8) + "' font-size='10' text-anchor='middle' fill='#6b7b71'>" + esc(label) + "</text>";
        }).join("");
      })();

      chart.innerHTML =
        "<svg class='trendSvg' viewBox='0 0 " + w + " " + h + "' aria-label='Top sources over time'>" +
        grid + lines + xTicks +
        "</svg>";
      legend.innerHTML = pointsByDomain.map((d) => {
        const color = domainColor(d.domain);
        return "<div class='trendItem'>" +
          "<span class='trendDot' style='background:" + esc(color) + ";'></span>" +
          "<img class='trendLogo' src='" + esc(logoUrl(d.domain)) + "' alt='' />" +
          "<span>" + esc(d.domain) + "</span>" +
          "<span class='muted' style='margin-left:auto;'>Total: " + esc(String(d.total)) + "</span>" +
        "</div>";
      }).join("");
      meta.textContent =
        "Question: " + drillValue + " | Range: " + trendRange + " | Granularity: " + granularity +
        " | Samples: " + String(scoped.length) + " | Top Sources: " + String(pointsByDomain.length);
    }
    function refreshDrillOptions(samples) {
      const select = document.getElementById("drillValue");
      const values = drillType === "market"
        ? [...new Set(samples.map((s) => s.market || "unknown"))]
        : drillType === "funnel"
          ? [...new Set(samples.map((s) => s.funnel || "unknown"))]
          : [...new Set(samples.map((s) => s.question || "unknown"))];
      select.innerHTML = values.map((v) => "<option value='" + esc(v) + "'>" + esc(v) + "</option>").join("");
      if (!drillValue || !values.includes(drillValue)) {
        drillValue = values[0] || "";
      }
      if (drillValue) select.value = drillValue;
    }
    async function renderDrilldown() {
      const { samples } = await getScopedSamples();
      const filtered = (samples || []).filter((s) => {
        const value = drillType === "market"
          ? (s.market || "unknown")
          : drillType === "funnel"
            ? (s.funnel || "unknown")
            : (s.question || "unknown");
        return value === drillValue;
      });
      const summary = aggregate(filtered);
      document.getElementById("drillMeta").textContent =
        drillType + ": " + (drillValue || "(none)") + " | Samples: " + filtered.length;
      document.getElementById("drillKpis").innerHTML = [
        { k: "Visibility Score", v: summary.visibilityScore },
        { k: "Mention Rate", v: summary.mentionRate },
        { k: "Top-3 Rate", v: summary.topRate },
        { k: "Included Rate", v: summary.includedRate },
      ].map((x) => "<div class='kpi'><div class='muted'>" + esc(x.k) + "</div><div style='font-size:30px;font-weight:700;'>" + esc(x.v) + "</div></div>").join("");
      renderBars("drillSourcesAll", sourceCounts(filtered, "all"), "domain", "count", "");
      renderBars("drillSourcesVancouver", sourceCounts(filtered, "vancouver"), "domain", "count", "");
      renderBars("drillSourcesVancouverTop", sourceCounts(filtered, "vancouver_top"), "domain", "count", "");
      await renderQuestionTrend();
    }
    async function renderQuality(samples, scopedRuns) {
      const q = qualityScores(samples);
      document.getElementById("qualityMeta").textContent =
        "Runs: " + scopedRuns + " | Total samples: " + q.totalSamples + " | Vancouver-mentioned samples scored: " + q.sampleCount;
      document.getElementById("qualityKpis").innerHTML = [
        { k: "Vancouver Mention Frequency", v: q.mentionRate },
        { k: "Sentiment (1-5)", v: q.sentiment },
        { k: "Specificity (1-5)", v: q.specificity },
        { k: "Brand Alignment (1-5)", v: q.brand_alignment },
        { k: "Total Content Quality", v: q.totalContentQuality },
      ].map((x) => "<div class='kpi'><div class='muted'>" + esc(x.k) + "</div><div style='font-size:30px;font-weight:700;'>" + esc(x.v) + "</div></div>").join("");
      renderTable("qualityMarket", q.byMarket, ["key", "mentionRate", "sampleCount", "sentiment", "specificity", "brand_alignment", "total_content_quality"]);
      renderTable("qualityFunnel", q.byFunnel, ["key", "mentionRate", "sampleCount", "sentiment", "specificity", "brand_alignment", "total_content_quality"]);
      qualityQuestionRows = q.byQuestion || [];
      renderQualityQuestionTable();
    }
    async function renderOverview() {
      const start = document.getElementById("rangeStart").value;
      const end = document.getElementById("rangeEnd").value;
      const { scopedRuns, samples } = await getScopedSamples();
      const s = aggregate(samples);
      const rangeLabel = currentRange === "today" ? "Today" : currentRange === "week" ? "This Week" : currentRange === "month" ? "This Month" : currentRange === "all" ? "All Time" : ("Custom " + (start || "") + " to " + (end || ""));
      document.getElementById("rangeMeta").textContent = rangeLabel + " | Runs: " + scopedRuns + " | Samples: " + samples.length;
      document.getElementById("kpis").innerHTML = [
        { k: "Visibility Score", v: s.visibilityScore },
        { k: "Mention Rate", v: s.mentionRate },
        { k: "Top-3 Rate", v: s.topRate },
        { k: "Included Rate", v: s.includedRate },
      ].map((x) => "<div class='kpi'><div class='muted'>" + esc(x.k) + "</div><div style='font-size:30px;font-weight:700;'>" + esc(x.v) + "</div></div>").join("");
      renderBars("marketBars", s.byMarket, "key", "topRate", "%", "market");
      renderBars("funnelBars", s.byFunnel, "key", "topRate", "%", "funnel");
      renderBars("sourceBars", s.sources, "domain", "count", "");
      renderBars("sourceVancouverBars", s.sourcesVancouver, "domain", "count", "");
      refreshDrillOptions(samples);
      await renderDrilldown();
      await renderQuality(samples, scopedRuns);
    }
    function setRunStatus(text, err) {
      const el = document.getElementById("runStatus");
      el.textContent = text;
      el.className = "status" + (err ? " err" : "");
    }
    async function pollJob(jobId) {
      for (;;) {
        const res = await apiFetch("/api/job/" + encodeURIComponent(jobId));
        const job = await res.json();
        if (job.status === "queued") setRunStatus("Queued...");
        if (job.status === "running") {
          const p = job.progress || {};
          setRunStatus("Running... " + (p.completed || 0) + "/" + (p.total || 0));
        }
        if (job.status === "failed") {
          setRunStatus("Failed: " + (job.error || "Unknown"), true);
          runBusy = false;
          return;
        }
        if (job.status === "done") {
          setRunStatus("Completed.");
          runBusy = false;
          await loadBatches();
          await renderOverview();
          return;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    async function startRun() {
      if (runBusy) return;
      const providers = [];
      if (document.getElementById("modelChatgpt").checked) providers.push("chatgpt");
      if (document.getElementById("modelGemini").checked) providers.push("gemini");
      const markets = [...document.querySelectorAll(".market:checked")].map((el) => el.value);
      const repeats = Number(document.getElementById("repeats").value || 3);
      if (!providers.length) { setRunStatus("Select at least one model.", true); return; }
      if (!markets.length) { setRunStatus("Select at least one market.", true); return; }
      runBusy = true;
      try {
        const res = await apiFetch("/api/geo/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ providers, markets, repeats }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Run failed to start.");
        setRunStatus("Started.");
        await pollJob(data.jobId);
      } catch (err) {
        setRunStatus(String(err.message || err), true);
        runBusy = false;
      }
    }

    document.getElementById("tabOverviewBtn").onclick = () => setTab("overview");
    document.getElementById("tabDrillBtn").onclick = () => setTab("drill");
    document.getElementById("tabQualityBtn").onclick = () => setTab("quality");
    document.getElementById("tabRunBtn").onclick = () => setTab("run");
    document.getElementById("tabAdminBtn").onclick = async () => {
      const ok = await loadAdminUsers();
      if (ok) {
        setTab("admin");
        setAdminSection("users");
      }
      else setTab("overview");
    };
    document.getElementById("adminSectionUsersBtn").onclick = () => setAdminSection("users");
    document.getElementById("adminSectionGeoBtn").onclick = async () => {
      setAdminSection("geo");
      await loadGeoConfigForAdmin();
    };
    document.getElementById("adminSectionAppearanceBtn").onclick = async () => {
      setAdminSection("appearance");
      await loadAppearanceForAdmin();
    };
    document.getElementById("startRun").onclick = startRun;
    document.getElementById("adminCreateUserBtn").onclick = createAdminUser;
    document.getElementById("adminRefreshResetsBtn").onclick = async () => { await loadAdminUsers(); };
    document.getElementById("adminRefreshInvitesBtn").onclick = async () => { await loadAdminUsers(); };
    document.getElementById("adminRefreshRegsBtn").onclick = async () => { await loadAdminUsers(); };
    document.getElementById("inviteCreateBtn").onclick = createInvite;
    document.getElementById("geoAddCategoryBtn").onclick = () => {
      const name = String(document.getElementById("geoNewCategoryName").value || "").trim();
      if (!name) return;
      const id = name.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "category";
      const exists = (adminGeoConfig.categories || []).some((c) => c.id === id);
      if (exists) {
        setGeoStatus("Category id already exists.", true);
        return;
      }
      adminGeoConfig.categories.push({ id, name });
      document.getElementById("geoNewCategoryName").value = "";
      renderGeoConfigEditor();
      setGeoStatus("Category added.");
    };
    document.getElementById("geoAddQuestionBtn").onclick = () => {
      const prompt = String(document.getElementById("geoNewQuestionPrompt").value || "").trim();
      const categoryId = String(document.getElementById("geoNewQuestionCategory").value || "");
      const funnel = String(document.getElementById("geoNewQuestionFunnel").value || "unknown");
      if (!prompt || !categoryId) {
        setGeoStatus("Question and category are required.", true);
        return;
      }
      const nextId = "q" + String((adminGeoConfig.questions || []).length + 1).padStart(2, "0");
      adminGeoConfig.questions.push({ id: nextId, categoryId, funnel, prompt });
      document.getElementById("geoNewQuestionPrompt").value = "";
      renderGeoQuestions();
      setGeoStatus("Question added.");
    };
    document.getElementById("geoSaveConfigBtn").onclick = saveGeoConfigFromAdmin;
    document.getElementById("appearanceSuggestBtn").onclick = suggestAppearanceFromAdmin;
    document.getElementById("appearanceResetBtn").onclick = () => {
      adminAppearanceConfig = JSON.parse(JSON.stringify(DEFAULT_APPEARANCE));
      appearanceConfig = adminAppearanceConfig;
      renderAppearanceEditor();
      setAppearanceStatus("Reset to default palette. Save to persist.");
    };
    document.getElementById("appearanceSaveBtn").onclick = saveAppearanceFromAdmin;
    document.getElementById("runRangeDay").onclick = () => { setRunRange("day"); renderRunsByRange(); };
    document.getElementById("runRangeWeek").onclick = () => { setRunRange("week"); renderRunsByRange(); };
    document.getElementById("runRangeMonth").onclick = () => { setRunRange("month"); renderRunsByRange(); };
    document.getElementById("runRangeAll").onclick = () => { setRunRange("all"); renderRunsByRange(); };
    document.getElementById("rangeToday").onclick = async () => { setRange("today"); await renderOverview(); };
    document.getElementById("rangeWeek").onclick = async () => { setRange("week"); await renderOverview(); };
    document.getElementById("rangeMonth").onclick = async () => { setRange("month"); await renderOverview(); };
    document.getElementById("rangeAll").onclick = async () => { setRange("all"); await renderOverview(); };
    document.getElementById("rangeCustom").onclick = async () => { setRange("custom"); await renderOverview(); };
    document.getElementById("applyRange").onclick = async () => { setRange("custom"); await renderOverview(); };
    document.getElementById("drillType").onchange = (e) => {
      drillType = e.target.value;
      drillValue = "";
      renderOverview();
      setTab("drill");
    };
    document.getElementById("drillValue").onchange = (e) => {
      drillValue = e.target.value;
    };
    document.getElementById("drillApply").onclick = async () => {
      drillValue = document.getElementById("drillValue").value;
      await renderDrilldown();
    };
    document.getElementById("trendRangeMonth").onclick = async () => { setTrendRange("month"); await renderQuestionTrend(); };
    document.getElementById("trendRangeQuarter").onclick = async () => { setTrendRange("quarter"); await renderQuestionTrend(); };
    document.getElementById("trendRangeYear").onclick = async () => { setTrendRange("year"); await renderQuestionTrend(); };
    document.getElementById("trendRangeAll").onclick = async () => { setTrendRange("all"); await renderQuestionTrend(); };
    document.getElementById("trendRangeCustom").onclick = async () => { setTrendRange("custom"); await renderQuestionTrend(); };
    document.getElementById("trendApply").onclick = async () => { setTrendRange("custom"); await renderQuestionTrend(); };
    document.getElementById("trendGranularity").onchange = async (e) => {
      trendGranularity = e.target.value || "auto";
      await renderQuestionTrend();
    };
    document.getElementById("qSortSentiment").onchange = (e) => {
      setQualityQuestionSort("sentiment", e.target.value);
    };
    document.getElementById("qSortSpecificity").onchange = (e) => {
      setQualityQuestionSort("specificity", e.target.value);
    };
    document.getElementById("qSortBrand").onchange = (e) => {
      setQualityQuestionSort("brand_alignment", e.target.value);
    };
    document.getElementById("qSortMentionRate").onchange = (e) => {
      setQualityQuestionSort("mentionRate", e.target.value);
    };
    document.getElementById("qSortContentQuality").onchange = (e) => {
      setQualityQuestionSort("total_content_quality", e.target.value);
    };
    document.getElementById("forgotPasswordBtn").onclick = requestPasswordReset;
    document.getElementById("registerRequestBtn").onclick = requestAccessRegistration;
    document.getElementById("pwdCancelBtn").onclick = hidePasswordModal;
    document.getElementById("pwdSaveBtn").onclick = changeMyPassword;
    document.getElementById("loginBtn").onclick = async () => {
      const email = String(document.getElementById("loginEmail").value || "").trim();
      const password = String(document.getElementById("loginPassword").value || "");
      const status = document.getElementById("loginStatus");
      if (!email || !password) {
        status.textContent = "Email and password are required.";
        return;
      }
      status.textContent = "Signing in...";
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, orgId: ORG_HINT || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.token) {
        status.textContent = data?.error || "Sign-in failed.";
        return;
      }
      sessionToken = data.token;
      localStorage.setItem("dmo_session_token", sessionToken);
      const me = await apiFetch("/api/auth/me");
      const meData = await me.json().catch(() => ({}));
      setIdentity(meData.user || data.user, meData.org || { orgId: data.user?.orgId, name: data.user?.orgId });
      hideLogin();
      await refreshAdminCapability();
      await loadAppearanceForDashboard();
      await loadGeoConfigForDashboard();
      await loadBatches();
      await renderOverview();
      if (isAdminUser()) await loadAdminUsers();
    };
    document.getElementById("adminResetRequests").onclick = async (e) => {
      const btn = e.target.closest("[data-reset-apply]");
      if (!btn) return;
      const row = e.target.closest("tr[data-reset-id]");
      if (!row) return;
      const requestId = row.getAttribute("data-reset-id") || "";
      const input = row.querySelector("input[data-reset-password]");
      const password = String(input?.value || "");
      if (!password || password.length < 10) {
        setAdminStatus("Reset password must be at least 10 characters.", true);
        return;
      }
      setAdminStatus("Resolving reset request...");
      try {
        await resolveResetRequest(requestId, password);
        await loadAdminUsers();
        setAdminStatus("Reset request resolved.");
      } catch (err) {
        setAdminStatus(String(err.message || err), true);
      }
    };
    document.getElementById("adminUsersTable").onclick = async (e) => {
      const btn = e.target.closest("[data-user-delete]");
      if (!btn) return;
      const row = e.target.closest("tr");
      if (!row) return;
      const cells = row.querySelectorAll("td");
      const email = String(cells?.[1]?.textContent || "").trim();
      const user = adminUsers.find((u) => String(u.email || "").trim() === email);
      if (!user?.userId) {
        setAdminStatus("Could not identify selected user.", true);
        return;
      }
      setAdminStatus("Removing user...");
      try {
        await removeUser(user.userId);
        await loadAdminUsers();
        setAdminStatus("User removed.");
      } catch (err) {
        setAdminStatus(String(err.message || err), true);
      }
    };
    document.getElementById("adminInvitesTable").onclick = async (e) => {
      const btn = e.target.closest("[data-invite-revoke]");
      const delBtn = e.target.closest("[data-invite-delete]");
      if (!btn && !delBtn) return;
      const row = e.target.closest("tr[data-invite-id]");
      if (!row) return;
      const inviteId = row.getAttribute("data-invite-id") || "";
      setInviteStatus(delBtn ? "Removing invite..." : "Rescinding invite...");
      try {
        if (delBtn) await deleteInvite(inviteId);
        else await revokeInvite(inviteId);
        await loadAdminUsers();
        setInviteStatus(delBtn ? "Invite removed." : "Invite rescinded.");
      } catch (err) {
        setInviteStatus(String(err.message || err), true);
      }
    };
    document.getElementById("geoQuestionsTable").onclick = (e) => {
      const removeBtn = e.target.closest("[data-qremove]");
      if (!removeBtn) return;
      const row = e.target.closest("tr[data-qid]");
      if (!row) return;
      const qid = row.getAttribute("data-qid") || "";
      adminGeoConfig.questions = (adminGeoConfig.questions || []).filter((q) => q.id !== qid);
      renderGeoQuestions();
      setGeoStatus("Question removed.");
    };
    document.getElementById("adminRegistrationsTable").onclick = async (e) => {
      const approveBtn = e.target.closest("[data-reg-approve]");
      const rejectBtn = e.target.closest("[data-reg-reject]");
      if (!approveBtn && !rejectBtn) return;
      const row = e.target.closest("tr[data-reg-id]");
      if (!row) return;
      const requestId = row.getAttribute("data-reg-id") || "";
      try {
        if (approveBtn) {
          setRegStatus("Approving registration...");
          await approveRegistration(requestId);
          setRegStatus("Registration approved.");
        } else {
          setRegStatus("Rejecting registration...");
          await rejectRegistration(requestId);
          setRegStatus("Registration rejected.");
        }
        await loadAdminUsers();
      } catch (err) {
        setRegStatus(String(err.message || err), true);
      }
    };
    document.getElementById("marketBars").onclick = async (e) => {
      const card = e.target.closest("[data-drill-kind='market']");
      if (!card) return;
      drillType = "market";
      drillValue = card.getAttribute("data-drill-value") || "";
      document.getElementById("drillType").value = "market";
      await renderOverview();
      setTab("drill");
    };
    document.getElementById("funnelBars").onclick = async (e) => {
      const card = e.target.closest("[data-drill-kind='funnel']");
      if (!card) return;
      drillType = "funnel";
      drillValue = card.getAttribute("data-drill-value") || "";
      document.getElementById("drillType").value = "funnel";
      await renderOverview();
      setTab("drill");
    };

    (async function init() {
      updateAdminVisibility();
      setRange("today");
      setRunRange("day");
      setTrendRange("month");
      const end = new Date();
      const start = addDays(end, -30);
      document.getElementById("trendStart").value = toIsoDay(start);
      document.getElementById("trendEnd").value = toIsoDay(end);
      try {
        await requireAuthReady();
        await loadAppearanceForDashboard();
        await loadGeoConfigForDashboard();
        await loadBatches();
        await renderOverview();
        setRunStatus("Ready.");
      } catch {
        setRunStatus("Awaiting login.");
      }
    })();
  </script>
</body>
</html>`;
}

function inviteAcceptPage({ orgHint = "", token = "" } = {}) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>GEOrge Invite</title>
  <style>
    :root { --bg:#f2f6f4; --card:#ffffff; --ink:#17241d; --muted:#5e6f65; --line:#d4dfd8; --accent:#0f766e; --err:#7f1d1d; }
    body { margin:0; font-family:"Segoe UI","Trebuchet MS",sans-serif; color:var(--ink); background:var(--bg); }
    .wrap { max-width:560px; margin:24px auto; padding:20px; }
    .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px; }
    .muted { color:var(--muted); font-size:12px; }
    input { width:100%; border:1px solid var(--line); border-radius:8px; padding:8px; font:inherit; background:#fff; box-sizing:border-box; }
    .status { margin-top:8px; padding:8px; border:1px solid var(--line); border-radius:8px; background:#f8faf8; font-size:12px; }
    .status.err { color:var(--err); background:#fee2e2; border-color:#fecaca; }
    button { border:1px solid #0c5e57; color:#fff; background:linear-gradient(180deg,#0f766e,#0c5e57); border-radius:8px; padding:8px 12px; font-weight:700; cursor:pointer; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h2 style="margin:0 0 8px;">Accept Your GEOrge Invite</h2>
      <div id="meta" class="muted">Checking invite...</div>
      <label class="muted" style="display:block; margin-top:8px;">Name</label>
      <input id="name" type="text" placeholder="Your name" />
      <label class="muted" style="display:block; margin-top:8px;">Password</label>
      <input id="password" type="password" />
      <label class="muted" style="display:block; margin-top:8px;">Confirm Password</label>
      <input id="confirm" type="password" />
      <div style="margin-top:12px;">
        <button id="acceptBtn" type="button">Accept Invite</button>
      </div>
      <div id="status" class="status">Enter details to continue.</div>
    </div>
  </div>
  <script>
    const ORG_HINT = ${JSON.stringify(String(orgHint || ""))};
    const INVITE_TOKEN = ${JSON.stringify(String(token || ""))};
    function setStatus(text, err) {
      const el = document.getElementById("status");
      el.textContent = text;
      el.className = "status" + (err ? " err" : "");
    }
    async function loadInvite() {
      const res = await fetch("/api/auth/invite/" + encodeURIComponent(INVITE_TOKEN), {
        headers: ORG_HINT ? { "x-dmo-org": ORG_HINT } : {},
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus(data?.error || "Invite is not valid.", true);
        return;
      }
      document.getElementById("meta").textContent =
        "Invited email: " + (data?.email || "") + " | Org: " + (data?.orgId || ORG_HINT || "");
    }
    document.getElementById("acceptBtn").onclick = async () => {
      const name = String(document.getElementById("name").value || "").trim();
      const password = String(document.getElementById("password").value || "");
      const confirm = String(document.getElementById("confirm").value || "");
      if (!password || password.length < 10) {
        setStatus("Password must be at least 10 characters.", true);
        return;
      }
      if (password !== confirm) {
        setStatus("Password confirmation does not match.", true);
        return;
      }
      setStatus("Accepting invite...");
      const res = await fetch("/api/auth/invite/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(ORG_HINT ? { "x-dmo-org": ORG_HINT } : {}) },
        body: JSON.stringify({ token: INVITE_TOKEN, name, password, orgId: ORG_HINT || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.token) {
        setStatus(data?.error || "Could not accept invite.", true);
        return;
      }
      localStorage.setItem("dmo_session_token", data.token);
      const target = ORG_HINT ? ("/" + ORG_HINT + "/geo") : "/geo";
      window.location.href = target;
    };
    loadInvite();
  </script>
</body>
</html>`;
}

export function createDashboardHandler({ cwd }) {
  const assetsDir = path.join(cwd, "assets");
  const storeReady = createPersistence({ cwd });
  const authStoreReady = createAuthStore({ cwd });

  const queue = [];
  const jobs = new Map();
  let workerActive = false;
  const runTimeoutMs = Number(process.env.RUN_TIMEOUT_MS || 300000);

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`Run timed out after ${ms}ms.`)), ms);
      }),
    ]);
  }

  async function processQueue() {
    if (workerActive) return;
    const next = queue.shift();
    if (!next) return;
    workerActive = true;
    const job = jobs.get(next.jobId);
    if (!job) {
      workerActive = false;
      return;
    }

    job.status = "running";
    job.updatedAt = new Date().toISOString();
    try {
      if (next.kind === "geo_batch") {
        const result = await withTimeout(
          runGeoBatch({
            cwd,
            config: next.geoConfig,
            onProgress: (progress) => {
              job.progress = progress;
              job.updatedAt = new Date().toISOString();
              updateGeoBatch({
                cwd,
                orgId: next.orgId,
                batchId: next.batchId,
                mutate: (batch) => ({
                  ...batch,
                  progress,
                }),
              }).catch(() => {});
            },
          }),
          Number(process.env.GEO_RUN_TIMEOUT_MS || 1800000)
        );
        await updateGeoBatch({
          cwd,
          orgId: next.orgId,
          batchId: next.batchId,
          mutate: (batch) => ({
            ...batch,
            status: "done",
            progress: {
              completed: result.samples.length,
              total: result.samples.length,
            },
            samples: result.samples,
            summary: result.summary,
            completedAt: new Date().toISOString(),
          }),
        });
        job.status = "done";
        job.updatedAt = new Date().toISOString();
        job.batchId = next.batchId;
        job.result = {
          kind: "geo_batch",
          summary: result.summary,
          sampleCount: result.samples.length,
        };
      } else if (next.kind === "discussion") {
        const store = await storeReady;
        const client = createOpenAIClient();
        await store.appendMessage(next.sessionId, "user", next.text);
        const discussion = await withTimeout(
          runDiscussionTurn({
            cwd,
            client,
            store,
            sessionId: next.sessionId,
            text: next.text,
          }),
          runTimeoutMs
        );
        await store.appendMessage(next.sessionId, "assistant", discussion.combined);

        job.status = "done";
        job.updatedAt = new Date().toISOString();
        job.sessionId = next.sessionId;
        job.result = {
          kind: "discussion",
          perspectives: discussion.perspectives,
        };
      } else {
        const store = await storeReady;
        const client = createOpenAIClient();
        await store.appendMessage(next.sessionId, "user", next.text);
        const policy = loadPolicy(cwd);
        const sessionHistory =
          store.mode === "file"
            ? loadSessionMessages(cwd, next.sessionId)
            : await store.getSessionHistory(next.sessionId);
        const result = await withTimeout(
          runWorkflow({
            cwd,
            client,
            policy,
            userRequest: next.text,
            sessionId: next.sessionId,
            sessionHistory,
          }),
          runTimeoutMs
        );
        await store.appendMessage(next.sessionId, "assistant", result.finalOutput);
        await store.persistRunResult({ sessionId: next.sessionId, userRequest: next.text, result });

        job.status = "done";
        job.updatedAt = new Date().toISOString();
        job.sessionId = next.sessionId;
        job.result = {
          kind: "workflow",
          finalOutput: result.finalOutput,
          evaluation: result.evaluation,
          simulationSummary: result.simulationSummary,
        };
      }
    } catch (err) {
      job.status = "failed";
      job.updatedAt = new Date().toISOString();
      job.error = err.message || String(err);
    } finally {
      workerActive = false;
      setTimeout(processQueue, 10);
    }
  }

  function resolveRequestedOrgId(req, url, routeOrgId) {
    const raw =
      String(req.headers["x-dmo-org"] || "").trim() ||
      String(url.searchParams.get("orgId") || "").trim() ||
      String(routeOrgId || "").trim();
    if (!raw) return null;
    return normalizeOrgId(raw);
  }

  async function getAuthContext(req, expectedOrgId = null) {
    const token = String(req.headers["x-dmo-session"] || "").trim();
    if (!token) return null;
    const authStore = await authStoreReady;
    const session = await authStore.getSession(token);
    if (!session) return null;
    const user = await authStore.findUserById(session.userId);
    if (!user) return null;
    const ctx = {
      token,
      session,
      user,
      orgId: normalizeOrgId(session.orgId || user.orgId || getDefaultOrgId()),
      isAdmin: String(user.role || "") === "admin",
    };
    if (expectedOrgId && ctx.orgId !== normalizeOrgId(expectedOrgId)) {
      return null;
    }
    return ctx;
  }

  return async function dashboardHandler(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    const routeInfo = parseOrgPath(url.pathname);
    const requestedOrgId = resolveRequestedOrgId(req, url, routeInfo.orgId);
    try {
      const authStore = await authStoreReady;
      await ensureBootstrapAdmin(authStore);

      if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
        const rel = url.pathname.slice("/assets/".length).replace(/\\/g, "/").replace(/\.\.+/g, "");
        const full = path.join(assetsDir, rel);
        if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
          sendJson(res, 404, { error: "Asset not found" });
          return;
        }
        const ext = path.extname(full).toLowerCase();
        const types = {
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".svg": "image/svg+xml",
          ".webp": "image/webp",
        };
        res.statusCode = 200;
        res.setHeader("Content-Type", types[ext] || "application/octet-stream");
        fs.createReadStream(full).pipe(res);
        return;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true, service: "george", queueDepth: queue.length, workerActive });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/auth/check") {
        const body = await parseJsonBody(req);
        const ctx = await getAuthContext(req, requestedOrgId);
        const ok = Boolean(ctx);
        sendJson(res, ok ? 200 : 401, {
          ok,
          authEnabled: true,
          orgId: ctx?.orgId || normalizeOrgId(body?.orgId || requestedOrgId || getDefaultOrgId()),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/auth/login") {
        const body = await parseJsonBody(req);
        const orgId = normalizeOrgId(body?.orgId || requestedOrgId || getDefaultOrgId());
        const email = String(body?.email || "").trim().toLowerCase();
        const password = String(body?.password || "");
        if (!email || !password) {
          sendJson(res, 400, { error: "email and password are required." });
          return;
        }
        const user = await authStore.findUserByEmail(orgId, email);
        if (!user || !verifyPassword(password, user.passwordSalt, user.passwordHash)) {
          sendJson(res, 401, { error: "Invalid credentials." });
          return;
        }
        const session = await authStore.createSession({
          userId: user.userId,
          orgId,
          ttlHours: Number(process.env.AUTH_SESSION_TTL_HOURS || 72),
        });
        sendJson(res, 200, {
          ok: true,
          token: session.token,
          user: {
            userId: user.userId,
            email: user.email,
            name: user.name || "",
            role: user.role || "member",
            orgId,
          },
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/auth/forgot-password") {
        const body = await parseJsonBody(req);
        const orgId = normalizeOrgId(body?.orgId || requestedOrgId || getDefaultOrgId());
        const email = String(body?.email || "").trim().toLowerCase();
        if (email) {
          const user = await authStore.findUserByEmail(orgId, email);
          if (user) {
            await authStore.createResetRequest({
              orgId,
              email,
              requestedFromIp: String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || ""),
              userAgent: String(req.headers["user-agent"] || ""),
            });
          }
        }
        sendJson(res, 200, {
          ok: true,
          message: "If your account exists, a reset request has been submitted to your organization administrator.",
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/auth/register-request") {
        const body = await parseJsonBody(req);
        const orgId = normalizeOrgId(body?.orgId || requestedOrgId || getDefaultOrgId());
        const email = String(body?.email || "").trim().toLowerCase();
        const name = String(body?.name || "").trim();
        if (!email) {
          sendJson(res, 400, { error: "email is required." });
          return;
        }
        const existingUser = await authStore.findUserByEmail(orgId, email);
        if (!existingUser) {
          const reqs = await authStore.listRegistrationRequestsByOrg(orgId);
          const duplicatePending = (Array.isArray(reqs) ? reqs : []).some(
            (r) => String(r.email || "").toLowerCase() === email && String(r.status || "") === "pending"
          );
          if (!duplicatePending) {
            await authStore.createRegistrationRequest({
              orgId,
              email,
              name,
              requestedFromIp: String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || ""),
              userAgent: String(req.headers["user-agent"] || ""),
            });
          }
        }
        sendJson(res, 200, {
          ok: true,
          message: "Registration request submitted. An admin must approve your access.",
        });
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/api/auth/invite/")) {
        const token = decodeURIComponent(url.pathname.slice("/api/auth/invite/".length));
        if (!token || token === "accept") {
          sendJson(res, 400, { error: "Invite token is required." });
          return;
        }
        const invite = await authStore.getInviteByToken(token);
        if (!invite || invite.status !== "pending") {
          sendJson(res, 404, { error: "Invite not found or no longer active." });
          return;
        }
        if (requestedOrgId && normalizeOrgId(invite.orgId) !== normalizeOrgId(requestedOrgId)) {
          sendJson(res, 403, { error: "Invite is not valid for this organization route." });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          inviteId: invite.inviteId,
          orgId: invite.orgId,
          email: invite.email,
          role: invite.role || "member",
          expiresAt: invite.expiresAt || null,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/auth/invite/accept") {
        const body = await parseJsonBody(req);
        const token = String(body?.token || "").trim();
        const password = String(body?.password || "");
        const name = String(body?.name || "").trim();
        if (!token || !password) {
          sendJson(res, 400, { error: "token and password are required." });
          return;
        }
        if (password.length < 10) {
          sendJson(res, 400, { error: "Password must be at least 10 characters." });
          return;
        }
        const accepted = await authStore.acceptInvite({ token, password, name });
        if (requestedOrgId && normalizeOrgId(accepted.user.orgId) !== normalizeOrgId(requestedOrgId)) {
          sendJson(res, 403, { error: "Invite org mismatch for this route." });
          return;
        }
        const session = await authStore.createSession({
          userId: accepted.user.userId,
          orgId: accepted.user.orgId,
          ttlHours: Number(process.env.AUTH_SESSION_TTL_HOURS || 72),
        });
        sendJson(res, 200, {
          ok: true,
          token: session.token,
          user: {
            userId: accepted.user.userId,
            email: accepted.user.email,
            name: accepted.user.name || "",
            role: accepted.user.role || "member",
            orgId: accepted.user.orgId,
          },
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/auth/me") {
        const ctx = await getAuthContext(req, requestedOrgId);
        if (!ctx) {
          sendJson(res, 401, { error: "Unauthorized" });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          user: {
            userId: ctx.user.userId,
            email: ctx.user.email,
            name: ctx.user.name || "",
            role: ctx.user.role || "member",
            orgId: ctx.orgId,
          },
          org: {
            orgId: ctx.orgId,
            name: String(process.env.ORG_DISPLAY_NAME || "GEOrge"),
            logoUrl: String(process.env.ORG_LOGO_URL || "/assets/destination-vancouver-logo.png"),
          },
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/auth/logout") {
        const ctx = await getAuthContext(req, requestedOrgId);
        if (ctx?.token) await authStore.revokeSession(ctx.token);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/auth/change-password") {
        const ctx = await getAuthContext(req, requestedOrgId);
        if (!ctx) {
          sendJson(res, 401, { error: "Unauthorized" });
          return;
        }
        const body = await parseJsonBody(req);
        const currentPassword = String(body?.currentPassword || "");
        const newPassword = String(body?.newPassword || "");
        if (!currentPassword || !newPassword) {
          sendJson(res, 400, { error: "currentPassword and newPassword are required." });
          return;
        }
        if (newPassword.length < 10) {
          sendJson(res, 400, { error: "New password must be at least 10 characters." });
          return;
        }
        if (!verifyPassword(currentPassword, ctx.user.passwordSalt, ctx.user.passwordHash)) {
          sendJson(res, 400, { error: "Current password is incorrect." });
          return;
        }
        await authStore.updatePasswordForUser(ctx.user.userId, newPassword);
        await authStore.revokeSessionsByUser(ctx.user.userId);
        const session = await authStore.createSession({
          userId: ctx.user.userId,
          orgId: ctx.orgId,
          ttlHours: Number(process.env.AUTH_SESSION_TTL_HOURS || 72),
        });
        sendJson(res, 200, { ok: true, token: session.token });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/users") {
        const ctx = await getAuthContext(req, requestedOrgId);
        if (!ctx || !ctx.isAdmin) {
          sendJson(res, 403, { error: "Admin access required." });
          return;
        }
        const users = await authStore.listUsersByOrg(ctx.orgId);
        sendJson(
          res,
          200,
          users.map((u) => ({
            userId: u.userId,
            email: u.email,
            name: u.name || "",
            role: u.role || "member",
            orgId: u.orgId,
            createdAt: u.createdAt || null,
          }))
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/users") {
        const ctx = await getAuthContext(req, requestedOrgId);
        if (!ctx || !ctx.isAdmin) {
          sendJson(res, 403, { error: "Admin access required." });
          return;
        }
        const body = await parseJsonBody(req);
        const email = String(body?.email || "").trim().toLowerCase();
        const password = String(body?.password || "");
        if (!email || !password) {
          sendJson(res, 400, { error: "email and password are required." });
          return;
        }
        const user = await authStore.createUser({
          orgId: ctx.orgId,
          email,
          name: String(body?.name || email),
          role: body?.role === "admin" ? "admin" : "member",
          password,
        });
        sendJson(res, 200, {
          ok: true,
          user: {
            userId: user.userId,
            email: user.email,
            name: user.name || "",
            role: user.role || "member",
            orgId: user.orgId,
          },
        });
        return;
      }

      if (req.method === "DELETE" && url.pathname.startsWith("/api/admin/users/")) {
        const ctx = await getAuthContext(req, requestedOrgId);
        if (!ctx || !ctx.isAdmin) {
          sendJson(res, 403, { error: "Admin access required." });
          return;
        }
        const userId = decodeURIComponent(url.pathname.slice("/api/admin/users/".length));
        if (!userId) {
          sendJson(res, 400, { error: "userId is required." });
          return;
        }
        if (String(userId) === String(ctx.user.userId)) {
          sendJson(res, 400, { error: "You cannot remove your own account." });
          return;
        }
        const users = await authStore.listUsersByOrg(ctx.orgId);
        const target = users.find((u) => String(u.userId) === String(userId));
        if (!target) {
          sendJson(res, 404, { error: "User not found." });
          return;
        }
        if (String(target.role || "") === "admin") {
          const adminCount = users.filter((u) => String(u.role || "") === "admin").length;
          if (adminCount <= 1) {
            sendJson(res, 400, { error: "Cannot remove the last administrator." });
            return;
          }
        }
        await authStore.deleteUserById({ orgId: ctx.orgId, userId });
        sendJson(res, 200, { ok: true, userId });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/geo-config") {
        const ctx = await getAuthContext(req, requestedOrgId);
        if (!ctx || !ctx.isAdmin) {
          sendJson(res, 403, { error: "Admin access required." });
          return;
        }
        const cfg = await getGeoConfig({ cwd, orgId: ctx.orgId });
        sendJson(res, 200, cfg);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/geo-config/versions") {
        const ctx = await getAuthContext(req, requestedOrgId);
        if (!ctx || !ctx.isAdmin) {
          sendJson(res, 403, { error: "Admin access required." });
          return;
        }
        const versions = await listGeoConfigVersions({ cwd, orgId: ctx.orgId, limit: 100 });
        sendJson(res, 200, versions);
        return;
      }

      if (req.method === "PUT" && url.pathname === "/api/admin/geo-config") {
        const ctx = await getAuthContext(req, requestedOrgId);
        if (!ctx || !ctx.isAdmin) {
          sendJson(res, 403, { error: "Admin access required." });
          return;
        }
        const body = await parseJsonBody(req);
        const cfg = await saveGeoConfig({
          cwd,
          orgId: ctx.orgId,
          config: body,
          actor: { userId: ctx.user.userId, email: ctx.user.email },
        });
        const versions = await listGeoConfigVersions({ cwd, orgId: ctx.orgId, limit: 10 });
        sendJson(res, 200, { ok: true, config: cfg, versions });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/appearance") {
        const ctx = await getAuthContext(req, requestedOrgId);
        if (!ctx || !ctx.isAdmin) {
          sendJson(res, 403, { error: "Admin access required." });
          return;
        }
        const appearance = await getAppearance({ cwd, orgId: ctx.orgId });
        sendJson(res, 200, appearance);
        return;
      }

      if (req.method === "PUT" && url.pathname === "/api/admin/appearance") {
        const ctx = await getAuthContext(req, requestedOrgId);
        if (!ctx || !ctx.isAdmin) {
          sendJson(res, 403, { error: "Admin access required." });
          return;
        }
        const body = await parseJsonBody(req);
        const appearance = await saveAppearance({
          cwd,
          orgId: ctx.orgId,
          appearance: body,
          actor: { userId: ctx.user.userId, email: ctx.user.email },
        });
        sendJson(res, 200, { ok: true, appearance });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/appearance/suggest") {
        const ctx = await getAuthContext(req, requestedOrgId);
        if (!ctx || !ctx.isAdmin) {
          sendJson(res, 403, { error: "Admin access required." });
          return;
        }
        const orgName = String(process.env.ORG_DISPLAY_NAME || ctx.orgId || "GEOrge");
        const appearance = await suggestAppearance({ orgId: ctx.orgId, orgName });
        sendJson(res, 200, { ok: true, appearance });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/scrub-placeholder-sources") {
        const ctx = await getAuthContext(req, requestedOrgId);
        if (!ctx || !ctx.isAdmin) {
          sendJson(res, 403, { error: "Admin access required." });
          return;
        }
        const batches = await listGeoBatches(cwd, ctx.orgId);
        let batchesScanned = 0;
        let batchesUpdated = 0;
        let samplesUpdated = 0;
        for (const b of batches) {
          batchesScanned += 1;
          const batch = await getGeoBatch(cwd, b.batchId, ctx.orgId);
          if (!batch || !Array.isArray(batch.samples) || batch.samples.length === 0) continue;
          let changed = false;
          const cleaned = batch.samples.map((s) => {
            const urls = (Array.isArray(s?.sourceUrls) ? s.sourceUrls : []).filter(
              (u) => typeof u === "string" && u.trim() && !isPlaceholderUrl(u)
            );
            const domains = (Array.isArray(s?.sourceDomains) ? s.sourceDomains : []).filter(
              (d) => !isPlaceholderDomain(d)
            );
            const before = JSON.stringify({
              sourceUrls: Array.isArray(s?.sourceUrls) ? s.sourceUrls : [],
              sourceDomains: Array.isArray(s?.sourceDomains) ? s.sourceDomains : [],
            });
            const after = JSON.stringify({ sourceUrls: urls, sourceDomains: domains });
            if (before !== after) {
              changed = true;
              samplesUpdated += 1;
            }
            return {
              ...s,
              sourceUrls: urls,
              sourceDomains: domains,
            };
          });
          if (!changed) continue;
          await updateGeoBatch({
            cwd,
            orgId: ctx.orgId,
            batchId: b.batchId,
            mutate: (cur) => ({
              ...cur,
              samples: cleaned,
              summary: summarizeBatch(cleaned),
            }),
          });
          batchesUpdated += 1;
        }
        sendJson(res, 200, { ok: true, batchesScanned, batchesUpdated, samplesUpdated });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/reset-requests") {
        const ctx = await getAuthContext(req, requestedOrgId);
        if (!ctx || !ctx.isAdmin) {
          sendJson(res, 403, { error: "Admin access required." });
          return;
        }
        const requests = await authStore.listResetRequestsByOrg(ctx.orgId);
        sendJson(
          res,
          200,
          requests.map((r) => ({
            requestId: r.requestId,
            email: r.email || "",
            requestedAt: r.requestedAt || null,
            status: r.status || "pending",
          }))
        );
        return;
      }

      if (
        req.method === "POST" &&
        url.pathname.startsWith("/api/admin/reset-requests/") &&
        url.pathname.endsWith("/resolve")
      ) {
        const ctx = await getAuthContext(req, requestedOrgId);
        if (!ctx || !ctx.isAdmin) {
          sendJson(res, 403, { error: "Admin access required." });
          return;
        }
        const m = url.pathname.match(/^\/api\/admin\/reset-requests\/([^/]+)\/resolve$/);
        const requestId = m?.[1] ? decodeURIComponent(m[1]) : "";
        const body = await parseJsonBody(req);
        const password = String(body?.password || "");
        if (!requestId || !password) {
          sendJson(res, 400, { error: "requestId and password are required." });
          return;
        }
        if (password.length < 10) {
          sendJson(res, 400, { error: "New password must be at least 10 characters." });
          return;
        }
        const reqItem = await authStore.resolveResetRequest({
          orgId: ctx.orgId,
          requestId,
          resolvedByUserId: ctx.user.userId,
        });
        const user = await authStore.findUserByEmail(ctx.orgId, reqItem.email);
        if (!user) {
          sendJson(res, 404, { error: "User for reset request not found." });
          return;
        }
        await authStore.updatePasswordForUser(user.userId, password);
        await authStore.revokeSessionsByUser(user.userId);
        sendJson(res, 200, { ok: true, requestId, userId: user.userId });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/invites") {
        const ctx = await getAuthContext(req, requestedOrgId);
        if (!ctx || !ctx.isAdmin) {
          sendJson(res, 403, { error: "Admin access required." });
          return;
        }
        const invites = await authStore.listInvitesByOrg(ctx.orgId);
        const base = getBaseAppUrl(req);
        sendJson(
          res,
          200,
          invites.map((i) => ({
            inviteId: i.inviteId,
            email: i.email || "",
            role: i.role || "member",
            status: i.status || "pending",
            createdAt: i.createdAt || null,
            expiresAt: i.expiresAt || null,
            inviteUrl: `${base}/${ctx.orgId}/invite/${i.token}`,
          }))
        );
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/registration-requests") {
        const ctx = await getAuthContext(req, requestedOrgId);
        if (!ctx || !ctx.isAdmin) {
          sendJson(res, 403, { error: "Admin access required." });
          return;
        }
        const base = getBaseAppUrl(req);
        const requests = await authStore.listRegistrationRequestsByOrg(ctx.orgId);
        sendJson(
          res,
          200,
          requests.map((r) => ({
            requestId: r.requestId,
            name: r.name || "",
            email: r.email || "",
            status: r.status || "pending",
            requestedAt: r.requestedAt || null,
            resolvedAt: r.resolvedAt || null,
            inviteUrl: r.inviteToken ? `${base}/${ctx.orgId}/invite/${r.inviteToken}` : "",
          }))
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/invites") {
        const ctx = await getAuthContext(req, requestedOrgId);
        if (!ctx || !ctx.isAdmin) {
          sendJson(res, 403, { error: "Admin access required." });
          return;
        }
        const body = await parseJsonBody(req);
        const email = String(body?.email || "").trim().toLowerCase();
        if (!email) {
          sendJson(res, 400, { error: "email is required." });
          return;
        }
        const existing = await authStore.findUserByEmail(ctx.orgId, email);
        if (existing) {
          sendJson(res, 400, { error: "User already exists for this email." });
          return;
        }
        const invite = await authStore.createInvite({
          orgId: ctx.orgId,
          email,
          name: String(body?.name || ""),
          role: body?.role === "admin" ? "admin" : "member",
          invitedByUserId: ctx.user.userId,
          ttlHours: Number(process.env.AUTH_INVITE_TTL_HOURS || 168),
        });
        const inviteUrl = `${getBaseAppUrl(req)}/${ctx.orgId}/invite/${invite.token}`;
        const emailResult = body?.sendEmail ? await maybeSendInviteEmail({ toEmail: email, inviteUrl, orgId: ctx.orgId }) : { delivered: false, reason: "Email send skipped." };
        sendJson(res, 200, {
          ok: true,
          invite: {
            inviteId: invite.inviteId,
            email: invite.email,
            role: invite.role,
            status: invite.status,
            createdAt: invite.createdAt,
            expiresAt: invite.expiresAt,
            inviteUrl,
          },
          email: emailResult,
        });
        return;
      }

      if (
        req.method === "POST" &&
        url.pathname.startsWith("/api/admin/invites/") &&
        url.pathname.endsWith("/revoke")
      ) {
        const ctx = await getAuthContext(req, requestedOrgId);
        if (!ctx || !ctx.isAdmin) {
          sendJson(res, 403, { error: "Admin access required." });
          return;
        }
        const m = url.pathname.match(/^\/api\/admin\/invites\/([^/]+)\/revoke$/);
        const inviteId = m?.[1] ? decodeURIComponent(m[1]) : "";
        if (!inviteId) {
          sendJson(res, 400, { error: "inviteId is required." });
          return;
        }
        const invite = await authStore.revokeInvite({ orgId: ctx.orgId, inviteId });
        sendJson(res, 200, { ok: true, inviteId: invite.inviteId, status: invite.status || "revoked" });
        return;
      }

      if (req.method === "DELETE" && url.pathname.startsWith("/api/admin/invites/")) {
        const ctx = await getAuthContext(req, requestedOrgId);
        if (!ctx || !ctx.isAdmin) {
          sendJson(res, 403, { error: "Admin access required." });
          return;
        }
        const inviteId = decodeURIComponent(url.pathname.slice("/api/admin/invites/".length));
        if (!inviteId) {
          sendJson(res, 400, { error: "inviteId is required." });
          return;
        }
        await authStore.deleteInvite({ orgId: ctx.orgId, inviteId });
        sendJson(res, 200, { ok: true, inviteId });
        return;
      }

      if (
        req.method === "POST" &&
        url.pathname.startsWith("/api/admin/registration-requests/") &&
        url.pathname.endsWith("/approve")
      ) {
        const ctx = await getAuthContext(req, requestedOrgId);
        if (!ctx || !ctx.isAdmin) {
          sendJson(res, 403, { error: "Admin access required." });
          return;
        }
        const m = url.pathname.match(/^\/api\/admin\/registration-requests\/([^/]+)\/approve$/);
        const requestId = m?.[1] ? decodeURIComponent(m[1]) : "";
        if (!requestId) {
          sendJson(res, 400, { error: "requestId is required." });
          return;
        }
        const requests = await authStore.listRegistrationRequestsByOrg(ctx.orgId);
        const reqItem = (Array.isArray(requests) ? requests : []).find((r) => r.requestId === requestId);
        if (!reqItem || String(reqItem.status || "") !== "pending") {
          sendJson(res, 404, { error: "Registration request not found." });
          return;
        }
        const existing = await authStore.findUserByEmail(ctx.orgId, reqItem.email);
        if (existing) {
          await authStore.rejectRegistrationRequest({
            orgId: ctx.orgId,
            requestId,
            resolvedByUserId: ctx.user.userId,
            reason: "User already exists.",
          });
          sendJson(res, 400, { error: "User already exists for this email." });
          return;
        }
        const invite = await authStore.createInvite({
          orgId: ctx.orgId,
          email: reqItem.email,
          name: reqItem.name || reqItem.email,
          role: "member",
          invitedByUserId: ctx.user.userId,
          ttlHours: Number(process.env.AUTH_INVITE_TTL_HOURS || 168),
        });
        await authStore.approveRegistrationRequest({
          orgId: ctx.orgId,
          requestId,
          resolvedByUserId: ctx.user.userId,
          inviteId: invite.inviteId,
          inviteToken: invite.token,
        });
        const inviteUrl = `${getBaseAppUrl(req)}/${ctx.orgId}/invite/${invite.token}`;
        const emailResult = await maybeSendInviteEmail({ toEmail: reqItem.email, inviteUrl, orgId: ctx.orgId });
        sendJson(res, 200, { ok: true, requestId, inviteId: invite.inviteId, inviteUrl, email: emailResult });
        return;
      }

      if (
        req.method === "POST" &&
        url.pathname.startsWith("/api/admin/registration-requests/") &&
        url.pathname.endsWith("/reject")
      ) {
        const ctx = await getAuthContext(req, requestedOrgId);
        if (!ctx || !ctx.isAdmin) {
          sendJson(res, 403, { error: "Admin access required." });
          return;
        }
        const m = url.pathname.match(/^\/api\/admin\/registration-requests\/([^/]+)\/reject$/);
        const requestId = m?.[1] ? decodeURIComponent(m[1]) : "";
        if (!requestId) {
          sendJson(res, 400, { error: "requestId is required." });
          return;
        }
        await authStore.rejectRegistrationRequest({
          orgId: ctx.orgId,
          requestId,
          resolvedByUserId: ctx.user.userId,
          reason: "Rejected by admin.",
        });
        sendJson(res, 200, { ok: true, requestId, status: "rejected" });
        return;
      }

      let authCtx = null;
      if (url.pathname.startsWith("/api/")) {
        authCtx = await getAuthContext(req, requestedOrgId);
        if (!authCtx) {
          sendJson(res, 401, { error: "Unauthorized" });
          return;
        }
      }

      if (req.method === "POST" && url.pathname.startsWith("/api/")) {
        const body = await parseJsonBody(req);

        if (url.pathname === "/api/message" || url.pathname === "/api/discuss") {
          if (!validateApiKey(req, body)) {
            sendJson(res, 403, { error: "Invalid API key" });
            return;
          }
          const text = String(body?.text || "").trim();
          if (!text) {
            sendJson(res, 400, { error: "text is required." });
            return;
          }
          const selected = String(body?.sessionId || "").trim();
          const sessionId = body?.newSession === true || !selected ? createSessionId() : selected;
          const jobId = crypto.randomUUID();
          const now = new Date().toISOString();
          jobs.set(jobId, {
            jobId,
            kind: url.pathname === "/api/discuss" ? "discussion" : "workflow",
            status: "queued",
            sessionId,
            createdAt: now,
            updatedAt: now,
          });
          queue.push({
            jobId,
            sessionId,
            text,
            kind: url.pathname === "/api/discuss" ? "discussion" : "workflow",
          });
          setTimeout(processQueue, 5);
          sendJson(res, 200, {
            ok: true,
            jobId,
            sessionId,
            status: "queued",
            kind: url.pathname === "/api/discuss" ? "discussion" : "workflow",
          });
          return;
        }
        if (url.pathname === "/api/geo/run") {
          if (!validateApiKey(req, body)) {
            sendJson(res, 403, { error: "Invalid API key" });
            return;
          }
          const providers = Array.isArray(body?.providers) ? body.providers : DEFAULT_PROVIDERS;
          const markets = Array.isArray(body?.markets) ? body.markets : DEFAULT_MARKETS;
          const orgGeoConfig = await getGeoConfig({ cwd, orgId: authCtx.orgId });
          const defaultPrompts = promptsFromGeoConfig(orgGeoConfig);
          const prompts = Array.isArray(body?.prompts) && body.prompts.length > 0 ? body.prompts : defaultPrompts;
          const repeats = Math.max(1, Number(body?.repeats || 2));
          const geoConfigSnapshot = normalizeGeoConfig(orgGeoConfig);
          const config = {
            providers,
            markets,
            prompts,
            repeats,
            openaiModel: body?.openaiModel || process.env.OPENAI_GEO_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
            geminiModel: body?.geminiModel || process.env.GEMINI_MODEL || "gemini-2.0-flash",
            geoConfigVersionId: String(orgGeoConfig?.configVersionId || "unversioned"),
            geoConfigHash: String(orgGeoConfig?.configHash || ""),
            geoConfigSnapshot,
          };
          const batchId = `geo-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto
            .randomUUID()
            .slice(0, 8)}`;
          await initGeoBatch({ cwd, batchId, config, orgId: authCtx.orgId });
          const jobId = crypto.randomUUID();
          const now = new Date().toISOString();
          jobs.set(jobId, {
            jobId,
            kind: "geo_batch",
            status: "queued",
            batchId,
            createdAt: now,
            updatedAt: now,
            progress: { completed: 0, total: 0 },
          });
          queue.push({
            jobId,
            kind: "geo_batch",
            batchId,
            geoConfig: config,
            orgId: authCtx.orgId,
          });
          setTimeout(processQueue, 5);
          sendJson(res, 200, {
            ok: true,
            jobId,
            batchId,
            status: "queued",
            kind: "geo_batch",
          });
          return;
        }

        sendJson(res, 404, { error: "Not found" });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/sessions") {
        const store = await storeReady;
        sendJson(res, 200, await store.listSessions());
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/api/session/")) {
        const store = await storeReady;
        const sessionId = decodeURIComponent(url.pathname.slice("/api/session/".length));
        const detail = await store.getSessionDetail(sessionId);
        if (!detail) {
          sendJson(res, 404, { error: "Session not found" });
          return;
        }
        sendJson(res, 200, detail);
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/api/job/")) {
        const jobId = decodeURIComponent(url.pathname.slice("/api/job/".length));
        const job = jobs.get(jobId);
        if (!job) {
          sendJson(res, 404, { error: "Job not found" });
          return;
        }
        sendJson(res, 200, job);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/geo/batches") {
        sendJson(res, 200, await listGeoBatches(cwd, authCtx.orgId));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/geo/config") {
        sendJson(res, 200, await getGeoConfig({ cwd, orgId: authCtx.orgId }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/appearance") {
        sendJson(res, 200, await getAppearance({ cwd, orgId: authCtx.orgId }));
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/api/geo/batch/")) {
        const batchId = decodeURIComponent(url.pathname.slice("/api/geo/batch/".length));
        const batch = await getGeoBatch(cwd, batchId, authCtx.orgId);
        if (!batch) {
          sendJson(res, 404, { error: "Batch not found" });
          return;
        }
        sendJson(res, 200, batch);
        return;
      }

      if (req.method === "GET" && url.pathname === "/geo") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(geoExecutivePage({ orgHint: requestedOrgId || "" }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(geoExecutivePage({ orgHint: requestedOrgId || "" }));
        return;
      }

      if (req.method === "GET" && routeInfo.kind === "org_home" && routeInfo.orgId) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(geoExecutivePage({ orgHint: routeInfo.orgId }));
        return;
      }

      if (req.method === "GET" && routeInfo.kind === "invite_page" && routeInfo.orgId && routeInfo.token) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(inviteAcceptPage({ orgHint: routeInfo.orgId, token: routeInfo.token }));
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      sendJson(res, 500, { error: err.message || "Internal server error" });
    }
  };
}

export function startDashboard({ cwd, port = 4173 }) {
  const server = http.createServer(createDashboardHandler({ cwd }));

  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Dashboard running at http://localhost:${port}`);
  });
  return server;
}
