<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Where the reasoning lives

Two areas of this codebase carry decisions that the code cannot explain on its
own, and both have traps that look like tidying. Read the relevant handoff
**before** changing either — they are written to be skimmed, and each says up
front which section matters for which kind of change.

- **`SCHEDULE_HANDOFF.md`** — the schedule generator: weekday balance, bye
  spacing, ice-time share, and why the phases are ordered as they are.
- **`EXPORTS_HANDOFF.md`** — the CSV and calendar exports, the single read path
  through `src/lib/queries/schedule.ts`, and what postponing a game does to its
  date. Section 4 describes a way to silently corrupt game rows while believing
  you are simplifying; read it before touching postponement or the one-off
  planner.

`docs/superpowers/specs/` holds the per-change design docs these summarise,
including the alternatives that were considered and rejected. Reach for a spec
when a handoff tells you *what* was decided and you need *why*.
