import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { broadcast } from "./broadcast.js";
import {
  buildMcpServersForIntegrations,
  buildRuntimeToolsForIntegrations,
  listIntegrations,
} from "./integrations/registry.js";
import { createDraftStagingTools } from "./draft-tools.js";
import { createKnowledgeReadTools } from "./knowledge/tools.js";
import { EMPTY_USAGE, type UsageTotals } from "./usage.js";
import { getRuntimeConfig, type RuntimeConfig } from "./runtime-config.js";
import { runAgentRuntime } from "./runtimes/index.js";
import { buildPromptWithImages, fetchStoredBytes } from "./images/content-blocks.js";

const running = new Map<string, AbortController>();

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Composio surfaces the targeted account in a few different shapes depending on
// the tool. Pull whichever one is present so multi-account runs (e.g. 3 Gmail
// inboxes) make the chosen account visible per call.
function extractAccounts(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const accounts = new Set<string>();
  const collect = (v: unknown) => {
    if (typeof v === "string" && v.trim()) accounts.add(v.trim());
  };
  const obj = input as Record<string, unknown>;
  // Direct fields on the top-level call (single-execute, native Composio tools).
  collect(obj.account);
  collect(obj.connectedAccountId);
  collect(obj.connected_account_id);
  if (Array.isArray(obj.accounts)) obj.accounts.forEach(collect);
  // COMPOSIO_MULTI_EXECUTE_TOOL fans out: { tools: [{ account, ... }] }.
  if (Array.isArray(obj.tools)) {
    for (const t of obj.tools) {
      if (t && typeof t === "object") {
        const tt = t as Record<string, unknown>;
        collect(tt.account);
        collect(tt.connectedAccountId);
        collect(tt.connected_account_id);
      }
    }
  }
  return [...accounts];
}

function isBrowserFillTool(toolName: string): boolean {
  const shortName = toolName.split("__").pop() ?? toolName;
  return shortName === "browser_fill";
}

export function redactToolInputForLog(toolName: string, input: unknown): unknown {
  if (!isBrowserFillTool(toolName)) return input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  return {
    ...(input as Record<string, unknown>),
    text: "[redacted]",
  };
}

const EXECUTION_SYSTEM_BASE = `You are a focused background worker for the user.

Your job:
1. Perform the task you were given, end to end.
2. Use your tools — WebSearch, WebFetch, and any integrations loaded for this spawn — to investigate and act.
3. Return a concise, well-structured answer — not a data dump.

Research discipline:
- Prefer WebSearch for fresh/factual questions. WebFetch when you need the content of a known URL.
- Cite real URLs only — NEVER invent sources. If a page failed to load, say so.
- Cross-check when it matters: one search is rarely enough for a claim.

The user's second brain (read-only):
- search_knowledge reads the user's perpetual store of places they've visited
  (with anecdotes), drinks they've had (kind="drink", with category/venue), and
  durable facts/notes they've saved. Use it when a task could draw on what the
  user has personally logged — e.g. "suggest a restaurant they haven't tried"
  should first search_knowledge for places they HAVE logged, and "recommend a
  beer" can check what they've already rated.
- You can READ this store but cannot write to it.

Local browser:
- If the optional "browser" integration is loaded, Local browser use is enabled and it controls a local Patchright Chrome profile on the user's machine.
- Use browser tools only when native integrations or WebFetch/WebSearch are insufficient: login-only portals, JS-heavy apps, visual workflows, or services likely to detect bots.
- If you hit a login, MFA, or bot wall and the task requires the user's session, call browser_request_login. It opens a visible local Chrome instance and returns the exact handoff message to show the user.
- After browser_request_login, stop and tell the user what to do next. Do not claim the task is complete until they confirm they logged in.

MANDATORY: for any task that used WebSearch or WebFetch, end your response with
a "Sources:" section listing the ACTUAL URLs you fetched or found. Example:

  Sources:
  - https://www.lonelyplanet.com/japan/tokyo
  - https://www.japan-guide.com/e/e3008.html

No URLs = no sources section. Never write vague names like "Lonely Planet" or
"official guide" without the specific URL. The interaction agent relays your
output to the user verbatim, so if you don't include URLs, the user won't see
any.

Style:
- Optimize for iMessage delivery: short sentences, bullets over paragraphs, no tables.
- Prefer markdown with **bold** keywords and • bullets.
- Under 500 words unless explicitly asked for more.
- If you can't complete something, say why in one sentence.`;

// Appended when draft staging is enabled (interactive chats): the agent stages
// external actions for a human to approve in a later turn.
const DRAFT_SAFETY = `

Safety:
- Anything that sends a message, creates an event, or takes an external action: call save_draft with a JSON payload instead of the real send/create tool. Return the summary so the interaction agent can show it to the user.
- Only the interaction agent's send_draft tool commits. You never commit.`;

// Appended for unattended runs (e.g. automations): there is no approval turn
// and no interaction agent, so the agent must finish the task and return the
// result directly rather than staging a draft nobody can confirm.
const NO_DRAFT_SAFETY = `

Safety:
- This is an unattended run with no human in the loop — there is no draft or approval step, so never ask for confirmation.
- Complete the task and return the finished result directly. "Send me X" means produce X in your reply — it is not an external send.
- Still avoid irreversible external actions (sending email, posting messages, creating events). If the task genuinely needs one, do the safe parts and state plainly what you could not do and why.`;

export interface SpawnOptions {
  task: string;
  integrations: string[];
  conversationId?: string;
  name?: string;
  runtimeConfig?: RuntimeConfig;
  imageStorageIds?: string[];
  // Whether the agent should stage external actions as drafts for human
  // approval. True for interactive chats; false for unattended runs like
  // automations, where there is no approval turn. Defaults to true.
  stageDrafts?: boolean;
}

export type SpawnExecutionAgentOpts = SpawnOptions;

export interface SpawnResult {
  agentId: string;
  result: string;
  status: "completed" | "failed" | "cancelled";
}

export async function spawnExecutionAgent(opts: SpawnExecutionAgentOpts): Promise<SpawnResult> {
  const agentId = randomId("agent");
  const name = opts.name ?? (opts.integrations.join("+") || "general");
  const abort = new AbortController();
  running.set(agentId, abort);

  const shortId = agentId.slice(-6);
  const logAgent = (msg: string) => console.log(`[agent ${shortId}] ${msg}`);
  const taskPreview =
    opts.task.length > 120 ? opts.task.slice(0, 120) + "…" : opts.task;
  logAgent(
    `spawn: ${name} [${opts.integrations.join(", ") || "no integrations"}] images=${opts.imageStorageIds?.length ?? 0} — ${JSON.stringify(taskPreview)}`,
  );
  const agentStart = Date.now();
  const runtimeConfig = opts.runtimeConfig ?? (await getRuntimeConfig());

  await convex.mutation(api.agents.create, {
    agentId,
    conversationId: opts.conversationId,
    name,
    task: opts.task,
    runtime: runtimeConfig.runtime,
    model: runtimeConfig.model,
    reasoningEffort: runtimeConfig.reasoningEffort,
    billingMode: runtimeConfig.billingMode,
    mcpServers: opts.integrations,
  });
  broadcast("agent_spawned", { agentId, name, task: opts.task });

  await convex.mutation(api.agents.update, { agentId, status: "running" });

  const stageDrafts = opts.stageDrafts ?? true;
  const draftTools =
    stageDrafts && opts.conversationId ? createDraftStagingTools(opts.conversationId) : [];
  // Read-only access to the user's perpetual second brain (places + facts), so
  // automations/tasks can build on what the user has logged. Never writes.
  const knowledgeReadTools = createKnowledgeReadTools(opts.conversationId ?? "automation");
  const integrationServers =
    runtimeConfig.runtime === "claude"
      ? await buildMcpServersForIntegrations(opts.integrations, opts.conversationId)
      : {};
  const integrationTools =
    runtimeConfig.runtime === "codex"
      ? await buildRuntimeToolsForIntegrations(opts.integrations, opts.conversationId)
      : [];
  const mcpServers = integrationServers;
  const runtimeTools = [...draftTools, ...knowledgeReadTools, ...integrationTools];
  const runtimeToolNamespaces = [...new Set(integrationTools.map((tool) => tool.namespace))];
  const allowedTools = [
    "WebSearch",
    "WebFetch",
    "Skill",
    "mcp__boop-knowledge__*",
    ...Object.keys(mcpServers).flatMap((n) => [`mcp__${n}__*`]),
    ...(draftTools.length ? ["mcp__boop-drafts__*"] : []),
    ...runtimeToolNamespaces.flatMap((n) => [`mcp__${n}__*`]),
  ];

  let buffer = "";
  let usage: UsageTotals = { ...EMPTY_USAGE };
  let status: "completed" | "failed" | "cancelled" = "completed";
  let errorMsg: string | undefined;

  try {
    const executionPrompt = await buildPromptWithImages({
      text: opts.task,
      imageStorageIds: opts.imageStorageIds,
      fetchBytes: fetchStoredBytes,
    });
    const result = await runAgentRuntime(runtimeConfig, {
      prompt: executionPrompt,
      systemPrompt: EXECUTION_SYSTEM_BASE + (stageDrafts ? DRAFT_SAFETY : NO_DRAFT_SAFETY),
      claudeMcpServers: mcpServers,
      tools: runtimeTools,
      allowedTools,
      abortController: abort,
      mode: "execution",
      onText: async (text) => {
        buffer += text;
        await convex.mutation(api.agents.addLog, {
          agentId,
          logType: "text",
          content: text,
        });
      },
      onToolUse: async (toolName, input) => {
        const toolShort = toolName.replace(/^mcp__[a-z-]+__/, "");
        const accounts = extractAccounts(input);
        const acctSuffix = accounts.length ? ` [${accounts.join(", ")}]` : "";
        logAgent(`tool: ${toolShort}${acctSuffix}`);
        const logInput = redactToolInputForLog(toolName, input);
        await convex.mutation(api.agents.addLog, {
          agentId,
          logType: "tool_use",
          toolName,
          ...(accounts.length ? { accounts } : {}),
          content: JSON.stringify(logInput).slice(0, 2000),
        });
        broadcast("agent_tool", { agentId, toolName, accounts });
      },
      onToolResult: async (_toolName, text) => {
        await convex.mutation(api.agents.addLog, {
          agentId,
          logType: "tool_result",
          content: text.slice(0, 2000),
        });
      },
    });
    if (!buffer) buffer = result.text;
    usage = result.usage;
  } catch (err) {
    status = abort.signal.aborted ? "cancelled" : "failed";
    errorMsg = String(err);
    await convex.mutation(api.agents.addLog, {
      agentId,
      logType: "error",
      content: errorMsg,
    });
  } finally {
    running.delete(agentId);
  }

  const elapsed = ((Date.now() - agentStart) / 1000).toFixed(1);
  logAgent(
    `done (${status}, ${elapsed}s, in/out tokens ${usage.inputTokens}/${usage.outputTokens}, cache r/w ${usage.cacheReadTokens}/${usage.cacheCreationTokens}, $${usage.costUsd.toFixed(4)})`,
  );

  await convex.mutation(api.agents.update, {
    agentId,
    status,
    result: buffer,
    error: errorMsg,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    costUsd: usage.costUsd,
  });
  // Also append to the usage log so total-cost queries cover every layer.
  if (usage.costUsd > 0 || usage.inputTokens > 0) {
    await convex.mutation(api.usageRecords.record, {
      source: "execution",
      conversationId: opts.conversationId,
      agentId,
      runtime: runtimeConfig.runtime,
      billingMode: runtimeConfig.billingMode,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      costUsd: usage.costUsd,
      durationMs: Date.now() - agentStart,
    });
  }
  broadcast("agent_done", { agentId, status, result: buffer.slice(0, 200) });

  return { agentId, result: buffer || errorMsg || "(no output)", status };
}

export function cancelAgent(agentId: string): boolean {
  const abort = running.get(agentId);
  if (!abort) return false;
  abort.abort();
  return true;
}

export function runningAgentIds(): string[] {
  return [...running.keys()];
}

export async function retryAgent(agentId: string): Promise<SpawnResult | null> {
  const existing = await convex.query(api.agents.get, { agentId });
  if (!existing) return null;
  const originalRuntime = existing as typeof existing & Partial<RuntimeConfig>;
  const runtimeConfig =
    originalRuntime.runtime && originalRuntime.model && originalRuntime.billingMode
      ? {
          runtime: originalRuntime.runtime,
          model: originalRuntime.model,
          reasoningEffort: originalRuntime.reasoningEffort,
          billingMode: originalRuntime.billingMode,
        }
      : undefined;
  // V1 limitation: image refs are not persisted to executionAgents and
  // therefore are not replayed on retry. Re-trigger from the original
  // turn if you need the image inputs.
  return await spawnExecutionAgent({
    task: existing.task,
    integrations: existing.mcpServers,
    conversationId: existing.conversationId,
    name: existing.name,
    runtimeConfig,
  });
}

export function availableIntegrations(): string[] {
  return listIntegrations().map((i) => i.name);
}
