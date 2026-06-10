import { describe, it, expect } from "vitest";
import { formatResults } from "../server/knowledge/tools.js";

const RECIPE_BODY =
  "Steps:\n1. 20 drops bergamot\n2. 10 drops cedarwood\n3. 5 drops vanilla\n4. Top with 50ml perfumer's alcohol\n5. Rest 3 weeks";

function note(i: number, body = RECIPE_BODY) {
  return {
    entryId: `kn_test_${i}`,
    kind: "note",
    title: `Note ${i}`,
    body,
    tags: [],
  };
}

function place(i: number, body = "Great margherita\nCash only, expect a line") {
  return {
    entryId: `kn_place_${i}`,
    kind: "place",
    title: `Spot ${i}`,
    body,
    city: "New York",
    area: "Greenwich Village",
    category: "restaurant",
    tags: [],
  };
}

describe("formatResults — full bodies for small result sets", () => {
  it("includes every line of a multi-line body when few results", () => {
    const out = formatResults([note(1)]);
    expect(out).toContain("20 drops bergamot");
    expect(out).toContain("Rest 3 weeks");
    expect(out).not.toContain("[…]");
  });

  it("renders full bodies for up to 5 results of mixed kinds", () => {
    const rows = [note(1), note(2), place(3), note(4), note(5)];
    const out = formatResults(rows);
    expect(out.match(/Rest 3 weeks/g)).toHaveLength(4);
    expect(out).toContain("Cash only, expect a line");
  });
});

describe("formatResults — relevance-ordered (fuzzy query) results", () => {
  it("gives full text for top matches and marked snippets for the tail", () => {
    const rows = Array.from({ length: 8 }, (_, i) => note(i));
    const out = formatResults(rows, { relevanceOrdered: true });
    // Top 3 in full…
    expect(out.match(/Rest 3 weeks/g)).toHaveLength(3);
    // …tail as snippets that signal there is more.
    expect(out).toContain("Steps: […]");
    expect(out).toContain("get_knowledge");
  });
});

describe("formatResults — long structured listings", () => {
  it("keeps grouped place listings compact but marks truncated bodies", () => {
    const rows = Array.from({ length: 10 }, (_, i) => place(i));
    const out = formatResults(rows);
    expect(out).toContain("Greenwich Village:");
    expect(out).toContain("Great margherita […]");
    expect(out).not.toContain("Cash only");
    expect(out).toContain("get_knowledge");
  });

  it("does not add a truncation marker to single-line bodies", () => {
    const rows = Array.from({ length: 10 }, (_, i) => note(i, "one-liner fact"));
    const out = formatResults(rows);
    expect(out).toContain("one-liner fact [kn_test_0]");
    expect(out).not.toContain("one-liner fact […]");
  });
});
