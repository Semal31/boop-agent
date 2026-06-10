import { z } from "zod";
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { embed, embeddingsAvailable } from "../embeddings.js";
import { createClaudeMcpServer } from "../runtimes/claude.js";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "../runtimes/types.js";

const NAMESPACE = "boop-knowledge";

const kindEnum = z.enum(["place", "fact", "note", "drink"]);

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

// Up to this many results, every entry is rendered with its FULL body — the
// second brain must hand back complete notes, not teasers. Past it, listings
// fall back to one-line snippets (clearly marked) to keep 50-place lists
// readable; get_knowledge fetches any full entry by id.
const FULL_BODY_LIMIT = 5;
// In relevance-ordered (fuzzy query) results, the top hits are almost always
// what the user is asking about — include their full bodies even when the
// result set is long.
const QUERY_TOP_FULL = 3;

const SNIPPET_FOOTER =
  "(Bodies above are first-line snippets — call get_knowledge with an entry id for the full text.)";

function snippetLine(text: string): string {
  const trimmed = text.trim();
  const nl = trimmed.indexOf("\n");
  if (nl < 0) return trimmed;
  return `${trimmed.slice(0, nl).trim()} […]`;
}

function indentBody(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}

function formatEntryFull(r: any): string {
  const loc = [r.venue, r.area, r.city, r.country].filter(Boolean).join(", ");
  const meta = [r.category, r.rating != null ? `${r.rating}★` : undefined]
    .filter(Boolean)
    .join(", ");
  const header = `• [${r.kind}] ${r.title}${meta ? ` (${meta})` : ""}${loc ? ` — ${loc}` : ""} [${r.entryId}]`;
  const body = (r.body ?? "").trim();
  return body ? `${header}\n${indentBody(body)}` : header;
}

function snippetEntry(r: any): string {
  const loc = [r.venue, r.area, r.city, r.country].filter(Boolean).join(", ");
  return `• [${r.kind}] ${r.title}${loc ? ` (${loc})` : ""}: ${snippetLine(r.body)} [${r.entryId}]`;
}

export function formatResults(rows: any[], opts: { relevanceOrdered?: boolean } = {}): string {
  // Small result sets always come back complete — this is the "talk to your
  // second brain" path, where a truncated note is useless.
  if (rows.length <= FULL_BODY_LIMIT) {
    return rows.map(formatEntryFull).join("\n\n");
  }

  // Relevance-ordered (fuzzy) results: full text for the top hits, snippets
  // for the tail. Grouping would destroy the ranking, so keep them flat.
  if (opts.relevanceOrdered) {
    const top = rows.slice(0, QUERY_TOP_FULL).map(formatEntryFull).join("\n\n");
    const rest = rows.slice(QUERY_TOP_FULL).map(snippetEntry).join("\n");
    return `Top matches (full text):\n\n${top}\n\nOther matches:\n${rest}\n\n${SNIPPET_FOOTER}`;
  }

  // Structured listings: group place results by neighborhood/city and drinks
  // by type; keep facts & notes flat.
  const allPlaces = rows.every((r) => r.kind === "place");
  if (allPlaces) {
    const groups = new Map<string, any[]>();
    for (const r of rows) {
      const key = r.area || r.city || r.country || "Unsorted";
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }
    const grouped = [...groups.entries()]
      .map(([area, items]) => {
        const lines = items
          .map(
            (i) =>
              `  • ${i.title}${i.category ? ` (${i.category}` + (i.rating ? `, ${i.rating}★` : "") + ")" : i.rating ? ` (${i.rating}★)` : ""} — ${snippetLine(i.body)} [${i.entryId}]`,
          )
          .join("\n");
        return `${area}:\n${lines}`;
      })
      .join("\n\n");
    return `${grouped}\n\n${SNIPPET_FOOTER}`;
  }
  const allDrinks = rows.every((r) => r.kind === "drink");
  if (allDrinks) {
    const groups = new Map<string, any[]>();
    for (const r of rows) {
      const key = r.category || "Other";
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }
    const grouped = [...groups.entries()]
      .map(([type, items]) => {
        const lines = items
          .map((i) => {
            const where = [i.venue, i.city].filter(Boolean).join(", ");
            return `  • ${i.title}${i.rating ? ` (${i.rating}★)` : ""}${where ? ` @ ${where}` : ""} — ${snippetLine(i.body)} [${i.entryId}]`;
          })
          .join("\n");
        return `${type}:\n${lines}`;
      })
      .join("\n\n");
    return `${grouped}\n\n${SNIPPET_FOOTER}`;
  }
  return `${rows.map(snippetEntry).join("\n")}\n\n${SNIPPET_FOOTER}`;
}

function buildSearchTool(conversationId: string): RuntimeTool {
  return defineRuntimeTool(
    NAMESPACE,
    "search_knowledge",
    `Search the user's perpetual second-brain store (places they've visited with anecdotes, drinks they've had, plus durable facts/notes). Two modes, combinable:
• Structured listing — pass kind/country/city/area/category to get an EXHAUSTIVE list (e.g. all restaurants in NYC; all beers via kind="drink" + category="beer"). Place results come back grouped by neighborhood, drink results grouped by type — each with its anecdote and entry id.
• Fuzzy recall — pass a free "query" to semantically find something the user vaguely remembers ("that fact about my bike", "the negroni I liked").
Pass both to scope a fuzzy search (e.g. query + city). Use country/city DISPLAY names (e.g. "New York", "United States"); matching is case-insensitive.
Small result sets and top fuzzy matches include each entry's FULL body. Long listings show first-line snippets marked with […] — call get_knowledge with the entry id whenever you need the complete text.`,
    {
      query: z.string().optional().describe("Free text for fuzzy semantic recall."),
      kind: kindEnum.optional().describe("Restrict to place | fact | note | drink."),
      country: z.string().optional(),
      city: z.string().optional(),
      area: z.string().optional().describe("Neighborhood/area, e.g. 'Greenwich Village'."),
      category: z
        .string()
        .optional()
        .describe("For places: restaurant/bar/cafe/etc. For drinks: beer/cocktail/wine/etc."),
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
      let relevanceOrdered = false;

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
          relevanceOrdered = rows.length > 0;
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
        relevanceOrdered = rows.length > 0;
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
      return runtimeText(formatResults(rows, { relevanceOrdered }));
    },
  );
}

function buildGetTool(): RuntimeTool {
  return defineRuntimeTool(
    NAMESPACE,
    "get_knowledge",
    `Fetch ONE complete entry from the user's second-brain store by its entry id (the kn_… id shown in search_knowledge results). Returns the full body verbatim plus all metadata. Use whenever you need the entire text of a note/fact/anecdote — reciting steps or instructions back to the user, summarizing a saved recipe, appending to the right entry — rather than relying on a search snippet.`,
    {
      entryId: z.string().describe("Entry id from search_knowledge, e.g. kn_abc123_xyz."),
    },
    async (args) => {
      const entry = await convex.query(api.knowledge.get, { entryId: args.entryId.trim() });
      if (!entry) return runtimeText(`No entry found with id ${args.entryId}.`);
      const loc = [entry.venue, entry.area, entry.city, entry.country]
        .filter(Boolean)
        .join(", ");
      const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
      const lines = [
        `[${entry.kind}] ${entry.title} [${entry.entryId}]`,
        loc ? `Where: ${loc}` : undefined,
        entry.category ? `Category: ${entry.category}` : undefined,
        entry.rating != null ? `Rating: ${entry.rating}★` : undefined,
        entry.tags.length > 0 ? `Tags: ${entry.tags.join(", ")}` : undefined,
        entry.visitedAt != null ? `Visited: ${day(entry.visitedAt)}` : undefined,
        `Logged: ${day(entry.createdAt)}`,
        "",
        entry.body,
      ].filter((l) => l !== undefined);
      return runtimeText(lines.join("\n"));
    },
  );
}

function buildLogTool(conversationId: string): RuntimeTool {
  return defineRuntimeTool(
    NAMESPACE,
    "log_knowledge",
    `Save something durable to the user's PERPETUAL second-brain store (it never decays). Use for:
• Places/visits the user describes (restaurants, bars, cafes, hotels, museums, etc.) with an anecdote — FILL IN country/city/area by inferring from what they said + your geography knowledge. E.g. "Joe's Pizza in the West Village" → country="United States", city="New York", area="Greenwich Village", category="restaurant". Only ask the user when genuinely ambiguous.
• Drinks the user had (kind="drink"). Set title = the drink/beer name, category = the drink type (beer/cocktail/wine/spirit/…), body = what they thought, and rating if given. For a cocktail at a bar, set venue = the bar/restaurant and infer country/city/area from it like a place. For a beer at home or from a shop, just title + body + category="beer" (+ rating); omit venue/location.
• Any durable fact or note the user wants kept forever ("remember that…", "save this…").
Suggested place categories: restaurant, bar, cafe, bakery, hotel, museum, park, shop, attraction, other. Suggested drink categories: beer, cocktail, wine, spirit, cider, other.
This logs exactly ONE entry. If the user mentions several places/drinks at once, call this tool once per item — never pack multiple into a single entry.
If this is a repeat of something already in the store (revisit a place, had the same beer again), pass appendToEntryId (from search_knowledge) to append the new anecdote instead of creating a duplicate.`,
    {
      kind: kindEnum.describe(
        "place = a venue/location with an anecdote; drink = a beer/cocktail/etc. you had; fact = a durable assertion; note = freeform dump.",
      ),
      title: z.string().describe("Place name, drink name, or a short headline for the fact/note."),
      body: z.string().describe("The anecdote, the verdict on the drink, fact detail, or note text."),
      country: z.string().optional().describe("Inferred country (display form), for places/cocktail venues."),
      city: z.string().optional().describe("Inferred city (display form), for places/cocktail venues."),
      area: z.string().optional().describe("Neighborhood/area, e.g. 'Greenwich Village'."),
      category: z
        .string()
        .optional()
        .describe("For places: restaurant/bar/cafe/etc. For drinks: beer/cocktail/wine/etc."),
      venue: z
        .string()
        .optional()
        .describe("For drinks: the bar/restaurant where you had it (omit for a beer at home/from a shop)."),
      tags: z.array(z.string()).optional().describe("Optional freeform tags."),
      rating: z.number().min(0).max(5).optional().describe("Optional 0-5 rating."),
      visitedAt: z
        .string()
        .optional()
        .describe("ISO date (e.g. '2026-05-20') if the user said when; omit otherwise."),
      appendToEntryId: z
        .string()
        .optional()
        .describe("Existing entry id to append this anecdote to (repeat visit / same drink again)."),
    },
    async (args) => {
      const embedText = [
        args.title,
        args.body,
        args.venue,
        args.country,
        args.city,
        args.area,
        args.category,
      ]
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
        venue: args.venue,
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
      const where = [args.venue, args.city, args.area].filter(Boolean).join(" · ");
      return runtimeText(`Logged ${entryId} (${args.kind}${where ? ` · ${where}` : ""}).`);
    },
  );
}

// Full tool set (write + read) for the interaction agent.
export function createKnowledgeTools(conversationId: string): RuntimeTool[] {
  return [buildLogTool(conversationId), buildSearchTool(conversationId), buildGetTool()];
}

// Read-only tool set for execution agents / automations — they can search the
// store but never write to it.
export function createKnowledgeReadTools(conversationId: string): RuntimeTool[] {
  return [buildSearchTool(conversationId), buildGetTool()];
}

export function createKnowledgeMcp(conversationId: string) {
  return createClaudeMcpServer(NAMESPACE, createKnowledgeTools(conversationId));
}
