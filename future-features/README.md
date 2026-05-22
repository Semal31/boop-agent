# future-features

Proposed feature designs for **this fork** of Boop — written and owned by the
fork maintainer, kept deliberately separate from the upstream design docs under
[`docs/`](../docs).

Each file is a self-contained design spec for something we *might* build. A doc
living here means "proposed / not yet implemented" — it is not a record of
shipped behavior (see `CHANGELOG.md` and `ARCHITECTURE.md` for what actually
exists).

**Conventions**

- One Markdown file per feature: `future-features/<feature-name>.md`.
- Start each doc with a header: title, `**Date:**`, `**Status:**`
  (`Proposed` → `Accepted` → `Implemented`/`Dropped`), and a one-line `**Topic:**`.
- This is a **public** repo. Keep specs feature-only — no personal data, secrets,
  real phone numbers, or private cross-project context. Use placeholders
  (`+1…`, `user@example.com`) and env-var names instead of values. See the
  pre-commit checklist in [`CLAUDE.md`](../CLAUDE.md).

**Index**

- [Proactive Suggestions Engine](./proactive-suggestions-engine.md) — let Boop
  reach out unprompted (≤1×/week) with a useful suggestion mined from the
  perpetual knowledge store. *Status: Proposed.*
</content>
