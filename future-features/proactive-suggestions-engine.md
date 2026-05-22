# Proactive Suggestions Engine

**Date:** 2026-05-21
**Status:** Proposed
**Topic:** Let Boop reach out *unprompted*, at most once a week, with one useful suggestion mined from the perpetual knowledge store (`knowledgeEntries`).

---

## 1. Goals

Boop accumulates durable knowledge in the second brain (places, facts, notes) but
never surfaces it unprompted. This adds a conservative engine that occasionally
texts the user one genuinely useful suggestion drawn from that store — e.g. "you've
logged a dozen places in one city but nothing outside one neighborhood," or
resurfacing a fact saved long ago.

The guiding value is **trust, not volume**. The proactive *email* watcher's stated
philosophy carries over verbatim:

> "false positives erode trust faster than missing one notice" / "when in doubt → stay silent."

Every default is set so the worst case for an opted-in user is ~1 useful message
per week, never at night.

## 2. Non-goals

- Not a chatty assistant. Hard cap of **one** nudge per tick, at most weekly.
- No web research or tool use in the proactive path — suggestions come only from
  local knowledge/memory data.
- No new "intent inference" from free-text memory at launch (deferred; see §6).
- Does not touch the decaying `memoryRecords` consolidation/decay loops.

## 3. Architecture overview

A dedicated `server/proactive-engine.ts` module — **structurally** parallel to
`server/automations.ts` (its own gated tick loop) but **semantically** parallel to
`server/proactive-email.ts` (cheap deterministic candidates → one background LLM
decide/compose call with no tools → conservative dispatch).

We reuse *functions*, not the automations table: the engine runs free Convex reads
plus one background LLM call — not a tool-wielding execution agent — so folding it
into `automations` would couple two unrelated control flows and risk the existing
dedup / `nextRunAt`-advance invariants.

Cadence is a **single global, settings-driven cron** ("when may Boop nudge"), not
per-row — so there is no new config table, just settings keys plus a
`proactiveNudges` history table.

```
startProactiveEngineLoop (~15-min tick; every early-exit is a cheap no-op)
  │
  ├─ enabled?              (proactive_suggestions_enabled, default OFF)
  ├─ BOOP_USER_PHONE set?  (else return before spending tokens)
  ├─ cadence due?          (advance next_at UP FRONT — see automations.ts)
  ├─ within window?        (quiet hours + timezone-set safety gate)
  ├─ spacing floor ok?     (min hours since last SENT nudge)
  │
  ├─ run generators ──► Candidate[]  (free Convex reads over knowledgeEntries)
  ├─ dedup filter    ──► drop entryIds sent within dedup_days
  │
  ├─ one Haiku compose/decide (mode:"background", no tools, silence-biased)
  │       └─ {send, summary?, chosenGenerator?, entryIds?}
  │
  └─ dispatch + record  (dispatchProactiveMessage → iMessage; row in proactiveNudges)
```

An in-flight boolean guard **plus** advancing `next_at` before the slow LLM call
prevents the 15-min tick from double-firing during a multi-second run (same
invariant as `server/automations.ts:104-113`).

## 4. Reused building blocks (do not reinvent)

| Concern | Reuse | Location |
|---|---|---|
| Dispatch to iMessage | Extract+export `dispatchProactiveMessage(content)` from `dispatchProactiveNotice` | `server/proactive-email.ts:291-330` |
| Enable-flag pattern | Mirror `isProactiveEnabled()` (30s TTL cache) — but **default off** | `server/proactive-email.ts:135-154` |
| Background LLM call + usage record | Classifier shape: `runAgentRuntime(cfg, {prompt, systemPrompt, tools:[], mode:"background"})`, JSON parse, `usageRecords.record({source:"proactive"})` | `server/proactive-email.ts:183-261` |
| Cadence math (TZ-aware) | `nextRunFor(cron, tz)`, `validateSchedule(cron, tz)` | `server/automations.ts:17-37` |
| Timezone | `getUserTimezone()`, `describeUserNow()` | `server/timezone-config.ts` |
| Dedup idea | `withRunHistory` "feed recent outputs, say don't repeat" | `server/automations.ts:50-83` |
| Knowledge reads | `api.knowledge.countsByKind`, `api.knowledge.listByLocation` | `convex/knowledge.ts` |
| Dashboard list panel | Pattern of query + `timeAgo` + `EmptyState` + `PanelPage` | `debug/src/components/AutomationsPanel.tsx` |

> Note: `knowledgeEntries` has **no index on `rating`/`visitedAt`/`updatedAt`** —
> only `by_entry_id`, `by_kind`, `by_kind_location`, `by_createdAt`, `by_embedding`.
> The launch generators sort in JS over a kind-scoped page (personal-scale, like
> `countsByKind`) and need only `countsByKind`, `listByLocation`, and `createdAt`,
> so they are embedding-free and cheap.

## 5. Settings & defaults

Read via small TTL-cached helpers (the `isProactiveEnabled` template).
**Distinct from the email watcher's `proactive_enabled` — never reuse that key.**

| Key | Default (row absent) | Meaning |
|---|---|---|
| `proactive_suggestions_enabled` | **`"false"` (OFF)** | Master switch. The key conservative default; requires explicit opt-in. |
| `proactive_suggestions_cron` | `"0 18 * * 0"` (Sun 6pm local) | Cadence, evaluated in user TZ via `nextRunFor`. |
| `proactive_suggestions_quiet_start` / `_quiet_end` | `"21"` / `"9"` | Hour-of-day quiet window; never dispatch inside it. |
| `proactive_suggestions_min_spacing_hours` | `"72"` | Hard floor between *sent* nudges, independent of cron. |
| `proactive_suggestions_dedup_days` | `"30"` | Don't reuse the same `entryId` within this window. |
| `proactive_suggestions_next_at` | computed | Derived epoch-ms next-fire (advanced up front), so the loop is a cheap timestamp compare. |

## 6. Generators (launch set)

Pure read-only functions returning `Candidate[]` (`{ generator, entryIds, factText }`);
each degrades to `[]` on an empty/small store. The compose step receives all
surviving candidates and picks **at most one** (returns `chosenGenerator`); never
more than one nudge per tick.

- **`underexplored_area`** — `countsByKind()`; if `place < 8` → `[]` (small store →
  silent). `listByLocation({ kind:"place", limit:1000 })`; group by `cityKey`; for
  the top city, group by `area`; surface when one area dominates and others are
  sparse/absent.
  `factText`: *"You've logged {n} places in {city}, almost all in {area} — nothing
  yet in the rest of {city}."*
  `entryIds`: a few representative entries from the dominant area, so dedup keys on
  the *observation* rather than a single venue.

- **`resurface_fact`** — `listByLocation({ kind:"fact", limit:1000 })` (optionally
  also `kind:"note"`); sort by `createdAt` asc; pick the oldest not surfaced within
  `dedup_days`.
  `factText`: *"A while back you saved: \"{title}\" — {first ~140 chars of body}."*
  `entryIds: [entryId]`. Cheapest, most reliable; the safe fallback when the area
  generator is empty.

**Deferred (v2):** *revisit a highly-rated place* (needs rating/visitedAt JS sort)
and *intent cross-reference* (string-matching memory `content` for travel/visit
language — fuzzy, higher false-positive risk; there is no first-class
"wants-to-visit" memory segment).

### `COMPOSE_PROMPT`

Haiku, `mode:"background"`, no tools. Given the surviving candidates + recent
*sent*-nudge summaries + a timezone-anchored "now", return
`{ send: boolean, summary?, chosenGenerator?, entryIds? }`. Strong default to
`{ send:false }`. Output style: warm, ≤200 chars, plain text, second person,
"texting a friend." Instruction to **not** repeat any recent nudge.

## 7. Components / files

**Create**

1. `convex/schema.ts` *(edit)* — add the `proactiveNudges` table (mirror
   `automationRuns`, `schema.ts:277-292`):
   ```ts
   proactiveNudges: defineTable({
     nudgeId: v.string(),
     generator: v.string(),          // "underexplored_area" | "resurface_fact"
     status: v.union(v.literal("sent"), v.literal("suppressed")),
     summary: v.string(),            // iMessage text ("" when suppressed)
     entryIds: v.array(v.string()),  // knowledge entryId strings (dedup key)
     reason: v.optional(v.string()), // why suppressed / debug
     sentAt: v.number(),
   })
     .index("by_nudge_id", ["nudgeId"])
     .index("by_sentAt", ["sentAt"]),
   ```
   `entryIds` stores the string `entryId` (not the Convex `_id`).
   `status:"suppressed"` makes the "Boop chose silence" path auditable. `by_sentAt`
   powers both the dedup window and the dashboard.

2. `convex/proactiveNudges.ts` *(new)* — mirror `convex/automations.ts:102-153`:
   `record({nudgeId, generator, status, summary, entryIds, reason?})` (insert
   `sentAt: Date.now()`); `recent({limit?})` (`by_sentAt` desc, default 50 —
   dashboard); `recentSince({sinceMs})` (`by_sentAt` range, status `"sent"` only —
   dedup + spacing).

3. `server/proactive-engine.ts` *(new)* — gated tick loop + generators +
   `COMPOSE_PROMPT`. Exports `startProactiveEngineLoop(intervalMs = 15*60_000)` and
   `runProactiveEngineNow({ force? })` (runs candidates → dedup → Haiku → dispatch
   once, bypassing cadence/window/spacing when `force`; still honors dedup).

4. `debug/src/components/ProactivePanel.tsx` *(new)* — read-only history via
   `useQuery(api.proactiveNudges.recent, {})`: generator badge, summary, entryIds,
   `timeAgo(sentAt)`, sent-vs-suppressed styling, `EmptyState` before any tick.

**Edit**

5. `server/proactive-email.ts` — extract+export `dispatchProactiveMessage(content)`;
   leave `dispatchProactiveNotice` as a thin wrapper so the email path is unchanged.
6. `server/index.ts` — call `startProactiveEngineLoop()` beside
   `startAutomationLoop()` (line 36); add a `POST /proactive/run` test endpoint near
   the `/consolidate` one (`index.ts:138-149`) that fire-and-forgets
   `runProactiveEngineNow({ force:true })`.
7. `server/self-tools.ts` — add `set_proactive_suggestions` (namespace `boop-self`):
   toggle `proactive_suggestions_enabled`, optionally set cron/quiet/spacing
   (validate cron via `validateSchedule`). Extend the `get_config` blob
   (`self-tools.ts:49-77`) with a `proactiveSuggestions: { enabled, cron, quietStart,
   quietEnd, minSpacingHours, nextAt }` section.
8. `server/interaction-agent.ts` — (a) mention `set_proactive_suggestions` in the
   self-inspection routing section (~line 44 + 194-210); (b) **add
   `mcp__boop-self__set_proactive_suggestions` to the `allowedTools` whitelist
   (532-557)** — without it the dispatcher silently cannot call the tool.
9. `debug/src/App.tsx` — register the panel: `"proactive"` in the `View` union
   (32-41), `NAV_ICONS` (60-70), `NAV` (72-82), the import (20-28), and
   `{view === "proactive" && <ProactivePanel isDark={isDark} />}` near line 318.
10. `debug/src/components/SettingsPanel.tsx` — add a `proactive_suggestions_enabled`
    toggle to `SETTINGS[]` (43-59) via `ToggleRow`; copy must distinguish it from
    "Proactive email surfacing" and note it defaults off.
11. `CLAUDE.local.md` *(local-only docs)* — add a "Proactive suggestions engine"
    subsection mirroring the second-brain writeup.

## 8. Edge cases & risks

- **Empty/small store → silent.** Thresholds in §6; zero candidates → record a
  `suppressed` row (reason "no fresh candidates"), send nothing. This is the
  dominant first-weeks state.
- **`BOOP_USER_PHONE` unset → return before spending tokens.** Early check in the
  tick so a phoneless deploy never burns a Haiku call.
- **Timezone unset → gate off.** When `describeUserNow().isExplicit === false`,
  suppress dispatch entirely (avoid a 3am nudge in the wrong zone).
- **Dedup correctness.** Keyed on `entryIds` over `dedup_days`, using **sent**
  nudges only (suppressed don't block retries). The area generator must emit stable
  representative `entryIds`. The compose step's "don't repeat recent summaries" is a
  second line of defense.
- **Cost.** Gated ticks are free Convex reads. A passing tick = one Haiku background
  call + one cheap `kind:"proactive"` interaction-agent tone-pass. Weekly cron + 72h
  floor caps spend at ~1 pair/week.
- **Flag collision.** New master key is `proactive_suggestions_enabled`;
  `usageRecords.source:"proactive"` is shared with the email watcher (acceptable;
  per-feature attribution is a future enum widening).
- **Double-fire.** Advance `next_at` before the Haiku/dispatch + in-flight boolean
  guard.

## 9. Verification (end-to-end, local)

1. **Codegen:** `npx convex dev --once` regenerates `_generated` (gitignored) so
   `api.proactiveNudges.*` exist; typecheck server + `debug` build.
2. **Force a tick:** flag on + `BOOP_USER_PHONE` set to a test number →
   `curl -X POST localhost:3456/proactive/run`; watch `journalctl -u boop -f` for the
   gate trace + Haiku JSON; confirm a `proactiveNudges` row and (if sent) the
   iMessage lands in the same `sms:+1…` thread.
3. **Empty-store silence:** point at a store with `<8` places and no aged facts →
   force tick → expect a `suppressed` row and no iMessage.
4. **Dedup + spacing:** force two ticks back-to-back → second suppresses (entryId
   within `dedup_days`). Separately, non-`force` second tick within 72h → bails
   before Haiku.
5. **Quiet hours / TZ:** set the user timezone so local time is inside the quiet
   window → non-`force` tick blocks dispatch; clear the timezone → unset-TZ safety
   gate keeps it silent.
6. **Text control:** "turn on proactive suggestions" / "what's my proactive config?"
   → `set_proactive_suggestions` flips the flag, `get_config` reflects it.
7. **Dashboard:** open the **Proactive** tab → history renders sent + suppressed with
   generator badges + timestamps; `EmptyState` before any tick; the Settings toggle
   flips the `settings` row.
</content>
