import { z } from "zod";
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { embed, embeddingsAvailable } from "../embeddings.js";
import { createClaudeMcpServer } from "../runtimes/claude.js";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "../runtimes/types.js";

const NAMESPACE = "boop-knowledge";

const kindEnum = z.enum(["place", "fact", "note"]);

function makeEntryId(): string {
  return `kn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Small alias map so different phrasings of the same place collapse to one
// indexable key. Best-effort — extend as real data reveals collisions.
const KEY_ALIASES: Record<string, string> = {
  nyc: "new york",
  "new york city": "new york",
  manhattan: "new york",
  usa: "united states",
  us: "united states",
  "u.s.": "united states",
  "u.s.a.": "united states",
  america: "united states",
  uk: "united kingdom",
  "u.k.": "united kingdom",
  england: "united kingdom",
};

function normKey(s?: string): string | undefined {
  const trimmed = s?.trim().toLowerCase();
  if (!trimmed) return undefined;
  return KEY_ALIASES[trimmed] ?? trimmed;
}

function firstLine(text: string): string {
  return text.split("\n")[0].trim();
}

function formatResults(rows: any[]): string {
  // Group place listings by neighborhood/city; keep facts & notes flat.
  const allPlaces = rows.length > 0 && rows.every((r) => r.kind === "place");
  if (allPlaces) {
    const groups = new Map<string, any[]>();
    for (const r of rows) {
      const key = r.area || r.city || r.country || "Unsorted";
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }
    return [...groups.entries()]
      .map(([area, items]) => {
        const lines = items
          .map(
            (i) =>
              `  • ${i.title}${i.category ? ` (${i.category}` + (i.rating ? `, ${i.rating}★` : "") + ")" : i.rating ? ` (${i.rating}★)` : ""} — ${firstLine(i.body)} [${i.entryId}]`,
          )
          .join("\n");
        return `${area}:\n${lines}`;
      })
      .join("\n\n");
  }
  return rows
    .map((r) => {
      const loc = [r.area, r.city, r.country].filter(Boolean).join(", ");
      return `• [${r.kind}] ${r.title}${loc ? ` (${loc})` : ""}: ${firstLine(r.body)} [${r.entryId}]`;
    })
    .join("\n");
}

function buildSearchTool(conversationId: string): RuntimeTool {
  return defineRuntimeTool(
    NAMESPACE,
    "search_knowledge",
    `Search the user's perpetual second-brain store (places they've visited with anecdotes, plus durable facts/notes). Two modes, combinable:
• Structured listing — pass kind/country/city/area/category to get an EXHAUSTIVE list (e.g. all restaurants in NYC). Place results come back grouped by neighborhood, each with its anecdote and entry id.
• Fuzzy recall — pass a free "query" to semantically find something the user vaguely remembers ("that fact about my bike").
Pass both to scope a fuzzy search to a place (e.g. query + city). Use country/city DISPLAY names (e.g. "New York", "United States"); matching is case-insensitive.`,
    {
      query: z.string().optional().describe("Free text for fuzzy semantic recall."),
      kind: kindEnum.optional().describe("Restrict to place | fact | note."),
      country: z.string().optional(),
      city: z.string().optional(),
      area: z.string().optional().describe("Neighborhood/area, e.g. 'Greenwich Village'."),
      category: z.string().optional().describe("For places: restaurant/bar/cafe/etc."),
      limit: z.number().optional().default(50),
    },
    async (args) => {
      const countryKey = normKey(args.country);
      const cityKey = normKey(args.city);
      const hasFilters = Boolean(
        args.kind || countryKey || cityKey || args.area || args.category,
      );
      const hasQuery = Boolean(args.query?.trim());
      let rows: any[] = [];

      if (hasQuery && embeddingsAvailable()) {
        const vec = await embed(args.query!);
        if (vec) {
          // Over-fetch: the vector index only applies one scope filter, so we
          // refine the rest in JS and would otherwise run short.
          const overFetch = hasFilters
            ? Math.min((args.limit ?? 50) * 3, 100)
            : args.limit;
          const hits = await convex.action(api.knowledge.vectorSearch, {
            embedding: vec,
            limit: overFetch,
            kind: args.kind,
            countryKey,
            cityKey,
          });
          rows = hits
            .map((h) => h.record)
            .filter((r: any) => {
              if (args.kind && r.kind !== args.kind) return false;
              if (countryKey && r.countryKey !== countryKey) return false;
              if (cityKey && r.cityKey !== cityKey) return false;
              if (args.area && (r.area ?? "").toLowerCase() !== args.area.toLowerCase())
                return false;
              if (args.category && r.category !== args.category) return false;
              return true;
            })
            .slice(0, args.limit);
        }
      }
      if (rows.length === 0 && hasFilters) {
        rows = await convex.query(api.knowledge.listByLocation, {
          kind: args.kind,
          countryKey,
          cityKey,
          area: args.area,
          category: args.category,
          limit: args.limit,
        });
      }
      if (rows.length === 0 && hasQuery) {
        rows = await convex.query(api.knowledge.textSearch, {
          query: args.query!,
          limit: args.limit,
        });
      }

      await convex.mutation(api.memoryEvents.emit, {
        eventType: "knowledge.searched",
        conversationId,
        data: JSON.stringify({
          query: args.query ?? null,
          filters: { kind: args.kind, country: args.country, city: args.city, area: args.area, category: args.category },
          hits: rows.length,
        }),
      });

      if (rows.length === 0) return runtimeText("Nothing in the knowledge store matched.");
      return runtimeText(formatResults(rows));
    },
  );
}

function buildLogTool(conversationId: string): RuntimeTool {
  return defineRuntimeTool(
    NAMESPACE,
    "log_knowledge",
    `Save something durable to the user's PERPETUAL second-brain store (it never decays). Use for:
• Places/visits the user describes (restaurants, bars, cafes, hotels, museums, etc.) with an anecdote — FILL IN country/city/area by inferring from what they said + your geography knowledge. E.g. "Joe's Pizza in the West Village" → country="United States", city="New York", area="Greenwich Village", category="restaurant". Only ask the user when genuinely ambiguous.
• Any durable fact or note the user wants kept forever ("remember that…", "save this…").
Suggested place categories: restaurant, bar, cafe, bakery, hotel, museum, park, shop, attraction, other.
This logs exactly ONE entry. If the user mentions several places at once, call this tool once per place — never pack multiple venues into a single entry.
If this is a repeat visit to a place already in the store, pass appendToEntryId (from search_knowledge) to append the new anecdote instead of creating a duplicate.`,
    {
      kind: kindEnum.describe(
        "place = a venue/location with an anecdote; fact = a durable assertion; note = freeform dump.",
      ),
      title: z.string().describe("Place name, or a short headline for the fact/note."),
      body: z.string().describe("The anecdote, fact detail, or note text."),
      country: z.string().optional().describe("Inferred country (display form), for places."),
      city: z.string().optional().describe("Inferred city (display form), for places."),
      area: z.string().optional().describe("Neighborhood/area, e.g. 'Greenwich Village'."),
      category: z.string().optional().describe("For places: restaurant/bar/cafe/etc."),
      tags: z.array(z.string()).optional().describe("Optional freeform tags."),
      rating: z.number().min(0).max(5).optional().describe("Optional 0-5 rating."),
      visitedAt: z
        .string()
        .optional()
        .describe("ISO date (e.g. '2026-05-20') if the user said when; omit otherwise."),
      appendToEntryId: z
        .string()
        .optional()
        .describe("Existing entry id to append this anecdote to (repeat visit)."),
    },
    async (args) => {
      const embedText = [args.title, args.body, args.country, args.city, args.area, args.category]
        .filter(Boolean)
        .join("\n");
      const embedding = (await embed(embedText)) ?? undefined;

      if (args.appendToEntryId) {
        const id = await convex.mutation(api.knowledge.appendBody, {
          entryId: args.appendToEntryId,
          body: args.body,
          embedding,
        });
        if (!id) return runtimeText(`No entry found with id ${args.appendToEntryId}.`);
        await convex.mutation(api.memoryEvents.emit, {
          eventType: "knowledge.logged",
          conversationId,
          data: JSON.stringify({ entryId: args.appendToEntryId, appended: true }),
        });
        return runtimeText(`Appended to ${args.appendToEntryId}.`);
      }

      const entryId = makeEntryId();
      const visitedAt = args.visitedAt ? Date.parse(args.visitedAt) : NaN;
      await convex.mutation(api.knowledge.create, {
        entryId,
        kind: args.kind,
        title: args.title,
        body: args.body,
        country: args.country,
        city: args.city,
        area: args.area,
        countryKey: normKey(args.country),
        cityKey: normKey(args.city),
        category: args.category,
        tags: args.tags ?? [],
        rating: args.rating,
        visitedAt: Number.isNaN(visitedAt) ? undefined : visitedAt,
        embedding,
        source: "chat",
      });
      await convex.mutation(api.memoryEvents.emit, {
        eventType: "knowledge.logged",
        conversationId,
        data: JSON.stringify({
          entryId,
          kind: args.kind,
          city: args.city ?? null,
          category: args.category ?? null,
        }),
      });
      const where = [args.city, args.area].filter(Boolean).join(" · ");
      return runtimeText(`Logged ${entryId} (${args.kind}${where ? ` · ${where}` : ""}).`);
    },
  );
}

// Full tool set (write + read) for the interaction agent.
export function createKnowledgeTools(conversationId: string): RuntimeTool[] {
  return [buildLogTool(conversationId), buildSearchTool(conversationId)];
}

// Read-only tool set for execution agents / automations — they can search the
// store but never write to it.
export function createKnowledgeReadTools(conversationId: string): RuntimeTool[] {
  return [buildSearchTool(conversationId)];
}

export function createKnowledgeMcp(conversationId: string) {
  return createClaudeMcpServer(NAMESPACE, createKnowledgeTools(conversationId));
}
