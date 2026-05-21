import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api.js";
import {
  EmptyState,
  HeaderPill,
  PanelPage,
  mutedTextClass,
  panelCardClass,
  subtlePanelClass,
} from "./PanelPrimitives.js";

type Kind = "all" | "place" | "fact" | "note";

const KIND_OPTIONS: { value: Kind; label: string }[] = [
  { value: "all", label: "All" },
  { value: "place", label: "Places" },
  { value: "fact", label: "Facts" },
  { value: "note", label: "Notes" },
];

const KIND_BADGE: Record<string, { dark: string; light: string }> = {
  place: {
    dark: "text-emerald-400 bg-emerald-400/10 border-emerald-500/20",
    light: "text-emerald-600 bg-emerald-50 border-emerald-200",
  },
  fact: {
    dark: "text-blue-400 bg-blue-400/10 border-blue-500/20",
    light: "text-blue-600 bg-blue-50 border-blue-200",
  },
  note: {
    dark: "text-slate-400 bg-slate-400/10 border-slate-500/20",
    light: "text-slate-600 bg-slate-50 border-slate-200",
  },
};

function distinct(values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v)))].sort((a, b) =>
    a.localeCompare(b),
  );
}

export function KnowledgePanel({ isDark }: { isDark: boolean }) {
  const [kindFilter, setKindFilter] = useState<Kind>("all");
  const [countryFilter, setCountryFilter] = useState("all");
  const [cityFilter, setCityFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const records = useQuery(api.knowledge.listByLocation, {
    kind: kindFilter !== "all" ? (kindFilter as any) : undefined,
    limit: 1000,
  });

  const allRecords = records ?? [];
  const countries = distinct(allRecords.map((r: any) => r.country));
  const cities = distinct(
    allRecords
      .filter((r: any) => countryFilter === "all" || r.country === countryFilter)
      .map((r: any) => r.city),
  );

  const filtered = allRecords.filter((r: any) => {
    if (countryFilter !== "all" && r.country !== countryFilter) return false;
    if (cityFilter !== "all" && r.city !== cityFilter) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return (
        (r.title ?? "").toLowerCase().includes(q) ||
        (r.body ?? "").toLowerCase().includes(q) ||
        (r.area ?? "").toLowerCase().includes(q) ||
        (r.category ?? "").toLowerCase().includes(q) ||
        (r.tags ?? []).some((t: string) => t.toLowerCase().includes(q))
      );
    }
    return true;
  });

  const btnActive = isDark
    ? "bg-zinc-100 text-zinc-950 shadow-sm"
    : "bg-white text-zinc-950 shadow-sm";
  const btnInactive = isDark
    ? "text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
    : "text-zinc-500 hover:bg-white/70 hover:text-zinc-800";
  const selectClass = `rounded-xl border px-2.5 py-1.5 text-xs focus:outline-none ${
    isDark
      ? "border-white/10 bg-[#17171a] text-zinc-300"
      : "border-zinc-200 bg-white text-zinc-700"
  }`;

  return (
    <PanelPage
      eyebrow="Store"
      title="Knowledge"
      description="The perpetual second brain — places visited and durable facts/notes."
      stat={
        <HeaderPill isDark={isDark}>
          {filtered.length}/{allRecords.length}
        </HeaderPill>
      }
    >
      <div className={panelCardClass(isDark, "flex flex-wrap items-center gap-2 px-3 py-3")}>
        <div
          className={`segmented-control flex items-center rounded-2xl border p-1 ${
            isDark ? "border-white/10 bg-[#17171a]" : "border-zinc-200 bg-zinc-100"
          }`}
        >
          {KIND_OPTIONS.map((k) => (
            <button
              key={k.value}
              onClick={() => setKindFilter(k.value)}
              className={`segmented-button rounded-xl px-2.5 py-1 text-xs ${
                kindFilter === k.value ? btnActive : btnInactive
              }`}
            >
              {k.label}
            </button>
          ))}
        </div>

        <select
          value={countryFilter}
          onChange={(e) => {
            setCountryFilter(e.target.value);
            setCityFilter("all");
          }}
          className={selectClass}
        >
          <option value="all">All countries</option>
          {countries.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>

        <select
          value={cityFilter}
          onChange={(e) => setCityFilter(e.target.value)}
          className={selectClass}
        >
          <option value="all">All cities</option>
          {cities.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>

        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search knowledge…"
          className={`min-w-[200px] flex-1 rounded-xl border px-3 py-1.5 text-sm focus:outline-none ${
            isDark
              ? "border-white/10 bg-[#17171a] text-zinc-300 placeholder:text-zinc-600"
              : "border-zinc-200 bg-white text-zinc-700 placeholder:text-zinc-400"
          }`}
        />
      </div>

      <div className={panelCardClass(isDark, "overflow-hidden")}>
        {records === undefined ? (
          <div className="p-5 space-y-3">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className={subtlePanelClass(isDark, "h-14 shimmer")} />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState isDark={isDark}>No entries match your filters</EmptyState>
        ) : (
          <div className={`divide-y ${isDark ? "divide-white/10" : "divide-zinc-100"}`}>
            {filtered.map((r: any) => {
              const isExpanded = expandedId === r.entryId;
              const kindBadge = KIND_BADGE[r.kind] ?? { dark: "", light: "" };
              const breadcrumb = [r.country, r.city, r.area].filter(Boolean).join(" › ");
              return (
                <div
                  key={r.entryId}
                  className={`px-5 py-3 cursor-pointer transition-colors ${
                    isDark ? "hover:bg-white/5" : "hover:bg-zinc-50"
                  }`}
                  onClick={() => setExpandedId(isExpanded ? null : r.entryId)}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${
                        isDark ? kindBadge.dark : kindBadge.light
                      }`}
                    >
                      {r.kind}
                    </span>
                    {r.category && (
                      <span className={`text-[10px] font-semibold ${mutedTextClass(isDark)}`}>
                        {r.category}
                      </span>
                    )}
                    {typeof r.rating === "number" && (
                      <span className={`text-[10px] mono ${isDark ? "text-amber-300" : "text-amber-600"}`}>
                        {r.rating}★
                      </span>
                    )}
                    <span className={`text-[10px] mono ml-auto ${mutedTextClass(isDark)}`}>
                      {new Date(r.createdAt).toLocaleDateString()}
                    </span>
                  </div>

                  <div className={`text-sm font-medium ${isDark ? "text-zinc-100" : "text-zinc-900"}`}>
                    {r.title}
                  </div>
                  {breadcrumb && (
                    <div className={`text-[11px] ${mutedTextClass(isDark)}`}>{breadcrumb}</div>
                  )}
                  <p
                    className={`mt-1 text-sm ${isExpanded ? "" : "line-clamp-2"} ${
                      isDark ? "text-slate-300" : "text-slate-700"
                    }`}
                  >
                    {r.body}
                  </p>

                  {isExpanded && (
                    <div className="mt-3 space-y-2 text-xs slide-down">
                      {Array.isArray(r.tags) && r.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {r.tags.map((t: string) => (
                            <span
                              key={t}
                              className={subtlePanelClass(isDark, "px-1.5 py-0.5 text-[10px]")}
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                      <div className={`grid grid-cols-2 gap-x-6 gap-y-1 ${mutedTextClass(isDark)}`}>
                        <div>
                          ID:{" "}
                          <span className={`mono ${isDark ? "text-slate-400" : "text-slate-600"}`}>
                            {r.entryId}
                          </span>
                        </div>
                        <div>
                          Source:{" "}
                          <span className={isDark ? "text-slate-400" : "text-slate-600"}>
                            {r.source}
                          </span>
                        </div>
                        {r.visitedAt && (
                          <div>
                            Visited:{" "}
                            <span className={isDark ? "text-slate-400" : "text-slate-600"}>
                              {new Date(r.visitedAt).toLocaleDateString()}
                            </span>
                          </div>
                        )}
                        <div>
                          Created:{" "}
                          <span className={isDark ? "text-slate-400" : "text-slate-600"}>
                            {new Date(r.createdAt).toLocaleString()}
                          </span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </PanelPage>
  );
}
