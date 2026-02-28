import "dotenv/config";
import { getGeoBatch, listGeoBatches } from "./lib/geo-measurement.js";
import { runScheduledGeoBatch } from "./lib/geo-scheduled-exec.js";

function getLocalDateParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: Number(get("hour") || "0"),
    key: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

function dayKeyFromIso(iso, timeZone) {
  const d = new Date(String(iso || ""));
  if (Number.isNaN(d.getTime())) return "";
  return getLocalDateParts(d, timeZone).key;
}

async function loadTodaysBatches({ cwd, orgId, dayKey, timeZone }) {
  const rows = await listGeoBatches(cwd, orgId);
  const todaysRows = rows.filter((r) => dayKeyFromIso(r.createdAt, timeZone) === dayKey);
  const detailed = [];
  for (const row of todaysRows) {
    const full = await getGeoBatch(cwd, row.batchId, orgId);
    detailed.push(full || row);
  }
  return detailed;
}

async function main() {
  const cwd = process.cwd();
  const orgId = String(process.env.GEO_SCHEDULE_ORG_ID || process.env.DEFAULT_ORG_ID || "vancouver");
  const timeZone = String(process.env.GEO_SCHEDULE_TIMEZONE || "America/Vancouver");
  const startHour = Math.max(0, Math.min(23, Number(process.env.GEO_WATCHDOG_START_HOUR || 8)));
  const maxAttempts = Math.max(1, Number(process.env.GEO_WATCHDOG_MAX_ATTEMPTS || 3));

  const now = new Date();
  const nowParts = getLocalDateParts(now, timeZone);
  if (nowParts.hour < startHour) {
    console.log(
      `Watchdog idle: local hour ${nowParts.hour} before start hour ${startHour} (${timeZone}).`
    );
    return;
  }

  const todays = await loadTodaysBatches({ cwd, orgId, dayKey: nowParts.key, timeZone });
  const hasDone = todays.some((b) => String(b?.status || "").toLowerCase() === "done");
  if (hasDone) {
    console.log(`Watchdog healthy: at least one completed batch found for ${nowParts.key}.`);
    return;
  }

  const attemptsSoFar = todays.filter(
    (b) => String(b?.config?.scheduleTrigger || "").toLowerCase() === "watchdog"
  ).length;
  if (attemptsSoFar >= maxAttempts) {
    const msg = `WATCHDOG_ALERT: no completed GEO batch for ${nowParts.key} (${timeZone}) after ${attemptsSoFar} watchdog attempts.`;
    console.error(msg);
    throw new Error(msg);
  }

  console.log(
    `Watchdog recovery attempt ${attemptsSoFar + 1}/${maxAttempts} for ${nowParts.key} (${timeZone}).`
  );
  await runScheduledGeoBatch({ cwd, trigger: "watchdog" });
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 1;
});
