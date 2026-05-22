import { action, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

// The perpetual "second brain" store. See the comment on `knowledgeEntries` in
// schema.ts — this table is intentionally excluded from the decay/consolidation
// loops, so there is no lifecycle/tier handling here.

const kindV = v.union(
  v.literal("place"),
  v.literal("fact"),
  v.literal("note"),
  v.literal("drink"),
);

const COUNTS_SCAN_LIMIT = 5000;

export const create = mutation({
  args: {
    entryId: v.string(),
    kind: kindV,
    title: v.string(),
    body: v.string(),
    country: v.optional(v.string()),
    city: v.optional(v.string()),
    area: v.optional(v.string()),
    countryKey: v.optional(v.string()),
    cityKey: v.optional(v.string()),
    category: v.optional(v.string()),
    venue: v.optional(v.string()),
    tags: v.array(v.string()),
    rating: v.optional(v.number()),
    visitedAt: v.optional(v.number()),
    embedding: v.optional(v.array(v.float64())),
    source: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("knowledgeEntries")
      .withIndex("by_entry_id", (q) => q.eq("entryId", args.entryId))
      .unique();
    if (existing) return existing._id;
    const now = Date.now();
    return await ctx.db.insert("knowledgeEntries", {
      ...args,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const update = mutation({
  args: {
    entryId: v.string(),
    title: v.optional(v.string()),
    body: v.optional(v.string()),
    country: v.optional(v.string()),
    city: v.optional(v.string()),
    area: v.optional(v.string()),
    countryKey: v.optional(v.string()),
    cityKey: v.optional(v.string()),
    category: v.optional(v.string()),
    venue: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    rating: v.optional(v.number()),
    visitedAt: v.optional(v.number()),
    embedding: v.optional(v.array(v.float64())),
  },
  handler: async (ctx, args) => {
    const { entryId, ...rest } = args;
    const entry = await ctx.db
      .query("knowledgeEntries")
      .withIndex("by_entry_id", (q) => q.eq("entryId", entryId))
      .unique();
    if (!entry) return null;
    // Only patch fields the caller actually supplied.
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    for (const [k, val] of Object.entries(rest)) {
      if (val !== undefined) patch[k] = val;
    }
    await ctx.db.patch(entry._id, patch);
    return entry._id;
  },
});

// Append an anecdote to an existing entry (e.g. a repeat visit to a place)
// rather than creating a duplicate row.
export const appendBody = mutation({
  args: {
    entryId: v.string(),
    body: v.string(),
    embedding: v.optional(v.array(v.float64())),
  },
  handler: async (ctx, args) => {
    const entry = await ctx.db
      .query("knowledgeEntries")
      .withIndex("by_entry_id", (q) => q.eq("entryId", args.entryId))
      .unique();
    if (!entry) return null;
    await ctx.db.patch(entry._id, {
      body: `${entry.body}\n\n${args.body}`,
      embedding: args.embedding ?? entry.embedding,
      updatedAt: Date.now(),
    });
    return entry._id;
  },
});

export const remove = mutation({
  args: { entryId: v.string() },
  handler: async (ctx, args) => {
    const entry = await ctx.db
      .query("knowledgeEntries")
      .withIndex("by_entry_id", (q) => q.eq("entryId", args.entryId))
      .unique();
    if (!entry) return null;
    await ctx.db.delete(entry._id);
    return entry._id;
  },
});

// Back-fill an embedding without touching updatedAt-sensitive fields.
export const setEmbedding = mutation({
  args: { entryId: v.string(), embedding: v.array(v.float64()) },
  handler: async (ctx, args) => {
    const entry = await ctx.db
      .query("knowledgeEntries")
      .withIndex("by_entry_id", (q) => q.eq("entryId", args.entryId))
      .unique();
    if (!entry) return null;
    await ctx.db.patch(entry._id, { embedding: args.embedding });
    return entry._id;
  },
});

export const get = query({
  args: { entryId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("knowledgeEntries")
      .withIndex("by_entry_id", (q) => q.eq("entryId", args.entryId))
      .unique();
  },
});

export const getByIds = query({
  args: { ids: v.array(v.id("knowledgeEntries")) },
  handler: async (ctx, args) => {
    const out = [];
    for (const id of args.ids) {
      const r = await ctx.db.get(id);
      if (r) out.push(r);
    }
    return out;
  },
});

// Exhaustive structured listing. Uses the by_kind_location prefix index for the
// country/city scope, then refines area (case-insensitive) and category in JS.
// `.take(limit)` (default 1000) is high enough that personal-scale lists are
// never silently truncated; callers can read `length === limit` if they care.
export const listByLocation = query({
  args: {
    kind: v.optional(kindV),
    countryKey: v.optional(v.string()),
    cityKey: v.optional(v.string()),
    area: v.optional(v.string()),
    category: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 1000;
    // The by_kind_location prefix is [kind, countryKey, cityKey, area]; eq must
    // be applied in order, so branch per available prefix depth. (The Convex
    // IndexRangeBuilder is progressively typed and can't be reassigned across
    // .eq() calls, so each chain is its own expression.) cityKey is only
    // chainable when countryKey is also present.
    let rows;
    if (args.kind && args.countryKey && args.cityKey) {
      rows = await ctx.db
        .query("knowledgeEntries")
        .withIndex("by_kind_location", (q) =>
          q.eq("kind", args.kind!).eq("countryKey", args.countryKey!).eq("cityKey", args.cityKey!),
        )
        .order("desc")
        .take(limit);
    } else if (args.kind && args.countryKey) {
      rows = await ctx.db
        .query("knowledgeEntries")
        .withIndex("by_kind_location", (q) =>
          q.eq("kind", args.kind!).eq("countryKey", args.countryKey!),
        )
        .order("desc")
        .take(limit);
    } else if (args.kind) {
      rows = await ctx.db
        .query("knowledgeEntries")
        .withIndex("by_kind_location", (q) => q.eq("kind", args.kind!))
        .order("desc")
        .take(limit);
    } else {
      rows = await ctx.db.query("knowledgeEntries").order("desc").take(limit);
    }
    return rows.filter((r) => {
      if (args.countryKey && r.countryKey !== args.countryKey) return false;
      if (args.cityKey && r.cityKey !== args.cityKey) return false;
      if (args.area && (r.area ?? "").toLowerCase() !== args.area.toLowerCase())
        return false;
      if (args.category && r.category !== args.category) return false;
      return true;
    });
  },
});

// Substring fallback for fuzzy recall when embeddings are unavailable.
export const textSearch = query({
  args: { query: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;
    const q = args.query.toLowerCase();
    const recent = await ctx.db
      .query("knowledgeEntries")
      .withIndex("by_createdAt")
      .order("desc")
      .take(COUNTS_SCAN_LIMIT);
    return recent
      .filter(
        (r) =>
          r.title.toLowerCase().includes(q) ||
          r.body.toLowerCase().includes(q) ||
          r.tags.some((t) => t.toLowerCase().includes(q)),
      )
      .slice(0, limit);
  },
});

export const vectorSearch = action({
  args: {
    embedding: v.array(v.float64()),
    limit: v.optional(v.number()),
    kind: v.optional(kindV),
    countryKey: v.optional(v.string()),
    cityKey: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<Array<{ _id: Id<"knowledgeEntries">; score: number; record: any }>> => {
    // Convex vector filters support eq/or but not AND across fields, so apply
    // only the single most-selective scope here; the tool layer refines the
    // remaining fields (kind/area/category) in JS over the hydrated records.
    const filter = args.cityKey
      ? (q: any) => q.eq("cityKey", args.cityKey)
      : args.countryKey
        ? (q: any) => q.eq("countryKey", args.countryKey)
        : args.kind
          ? (q: any) => q.eq("kind", args.kind)
          : undefined;
    const results = await ctx.vectorSearch("knowledgeEntries", "by_embedding", {
      vector: args.embedding,
      limit: args.limit ?? 20,
      ...(filter ? { filter } : {}),
    });
    const records = await ctx.runQuery(api.knowledge.getByIds, {
      ids: results.map((r) => r._id),
    });
    const byId = new Map(records.map((r: any) => [r._id, r]));
    return results
      .map((r) => ({ _id: r._id, score: r._score, record: byId.get(r._id) }))
      .filter((r) => r.record);
  },
});

export const countsByKind = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db
      .query("knowledgeEntries")
      .withIndex("by_createdAt")
      .order("desc")
      .take(COUNTS_SCAN_LIMIT);
    return {
      place: all.filter((r) => r.kind === "place").length,
      fact: all.filter((r) => r.kind === "fact").length,
      note: all.filter((r) => r.kind === "note").length,
      drink: all.filter((r) => r.kind === "drink").length,
      total: all.length,
      truncated: all.length === COUNTS_SCAN_LIMIT,
      scanLimit: COUNTS_SCAN_LIMIT,
    };
  },
});
