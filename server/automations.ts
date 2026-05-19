import { Cron } from "croner";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { spawnExecutionAgent } from "./execution-agent.js";
import { sendImessage } from "./sendblue.js";
import { broadcast } from "./broadcast.js";
import { getUserTimezone } from "./timezone-config.js";

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Both helpers accept an optional IANA timezone — when present, croner
// evaluates the cron expression in that zone. Without it, croner falls back
// to the server's local zone, which is almost always wrong for users in a
// different timezone than the host machine.
export function nextRunFor(schedule: string, timezone?: string): number | null {
  try {
    const c = new Cron(schedule, { paused: true, ...(timezone ? { timezone } : {}) });
    const next = c.nextRun();
    return next ? next.getTime() : null;
  } catch {
    return null;
  }
}

export function validateSchedule(
  schedule: string,
  timezone?: string,
): { valid: boolean; error?: string } {
  try {
    new Cron(schedule, { paused: true, ...(timezone ? { timezone } : {}) }).nextRun();
    return { valid: true };
  } catch (err) {
    return { valid: false, error: String(err) };
  }
}

// How many past runs to show the agent, and how much of each result to keep.
// Long enough that a daily automation won't repeat for ~1 month; truncated so
// the injected history stays a bounded, modest addition to the task prompt.
const PRIOR_RUNS_LIMIT = 30;
const PRIOR_RESULT_MAXLEN = 600;

// Execution agents are stateless and have no memory tools, so a recurring task
// ("send me a car fact") has no idea what it already sent and loops back on
// itself. This pulls the automation's own recent completed outputs and appends
// them to the task with an instruction not to repeat. Best-effort: any failure
// just returns the original task unchanged.
async function withRunHistory(
  automationId: string,
  currentRunId: string,
  task: string,
): Promise<string> {
  let priorResults: string[];
  try {
    // +1 covers the run just created for this tick, filtered out below.
    const recent = await convex.query(api.automations.recentRuns, {
      automationId,
      limit: PRIOR_RUNS_LIMIT + 1,
    });
    priorResults = recent
      .filter((r) => r.runId !== currentRunId && r.status === "completed" && !!r.result)
      .slice(0, PRIOR_RUNS_LIMIT)
      .map((r) => {
        const text = r.result as string;
        return text.length > PRIOR_RESULT_MAXLEN
          ? text.slice(0, PRIOR_RESULT_MAXLEN) + "…"
          : text;
      });
  } catch (err) {
    console.error("[automations] run-history fetch failed", err);
    return task;
  }
  if (priorResults.length === 0) return task;
  const history = priorResults.map((r, i) => `${i + 1}. ${r}`).join("\n\n");
  return (
    `${task}\n\n` +
    `--- ALREADY SENT ON PREVIOUS RUNS (most recent first) ---\n` +
    `Do NOT repeat any of these. Pick something genuinely new and distinct:\n\n` +
    history
  );
}

async function runAutomation(a: {
  automationId: string;
  name: string;
  task: string;
  integrations: string[];
  schedule: string;
  timezone?: string;
  conversationId?: string;
  notifyConversationId?: string;
}): Promise<void> {
  const runId = randomId("run");
  await convex.mutation(api.automations.createRun, {
    runId,
    automationId: a.automationId,
  });
  broadcast("automation_started", { automationId: a.automationId, runId, name: a.name });

  // Advance the schedule UP FRONT, before the (often minutes-long) run. The
  // tick loop fires every 30s on `nextRunAt <= now`; if we only advanced it
  // after the run finished, every tick during the run would re-fire the same
  // automation and the user would get a duplicate text per extra run.
  // Pre-TZ automations have no stored timezone — fall back to the user's
  // current setting so they don't keep firing in the host zone.
  const tz = a.timezone ?? (await getUserTimezone());
  await convex.mutation(api.automations.markRan, {
    automationId: a.automationId,
    lastRunAt: Date.now(),
    nextRunAt: nextRunFor(a.schedule, tz) ?? undefined,
  });

  const taskWithHistory = await withRunHistory(a.automationId, runId, a.task);

  try {
    const res = await spawnExecutionAgent({
      task: `AUTOMATION "${a.name}": ${taskWithHistory}`,
      integrations: a.integrations,
      conversationId: a.conversationId,
      name: `auto:${a.name}`,
      // Unattended run: no approval turn, so the agent must return the
      // finished result instead of staging a draft nobody can confirm.
      stageDrafts: false,
    });
    await convex.mutation(api.automations.updateRun, {
      runId,
      status: res.status === "completed" ? "completed" : "failed",
      result: res.result,
      agentId: res.agentId,
    });

    if (a.notifyConversationId && res.result) {
      if (a.notifyConversationId.startsWith("sms:")) {
        const number = a.notifyConversationId.slice(4);
        const preamble = `[${a.name}]\n\n`;
        await sendImessage(number, preamble + res.result);
      }
      await convex.mutation(api.messages.send, {
        conversationId: a.notifyConversationId,
        role: "assistant",
        content: `[${a.name}]\n\n${res.result}`,
      });
    }

    broadcast("automation_completed", { automationId: a.automationId, runId });
  } catch (err) {
    await convex.mutation(api.automations.updateRun, {
      runId,
      status: "failed",
      error: String(err),
    });
    broadcast("automation_failed", { automationId: a.automationId, runId, error: String(err) });
  }
}

// Automations currently mid-run. `runAutomation` advances `nextRunAt` in Convex
// before spawning, but that mutation is async — this in-memory set closes the
// brief window where a second tick could fire the same automation before the
// advance lands.
const inFlight = new Set<string>();

export async function tickAutomations(): Promise<void> {
  const all = await convex.query(api.automations.list, { enabledOnly: true });
  const now = Date.now();
  const due = all.filter(
    (a) => a.nextRunAt !== undefined && a.nextRunAt <= now && !inFlight.has(a.automationId),
  );
  for (const a of due) {
    inFlight.add(a.automationId);
    // fire-and-forget so one slow automation doesn't block others
    runAutomation({
      automationId: a.automationId,
      name: a.name,
      task: a.task,
      integrations: a.integrations,
      schedule: a.schedule,
      timezone: a.timezone,
      conversationId: a.conversationId,
      notifyConversationId: a.notifyConversationId,
    })
      .catch((err) => console.error("[automations] run error", err))
      .finally(() => inFlight.delete(a.automationId));
  }
}

export function startAutomationLoop(intervalMs = 30_000): () => void {
  const timer = setInterval(() => {
    tickAutomations().catch((err) => console.error("[automations] tick error", err));
  }, intervalMs);
  return () => clearInterval(timer);
}
