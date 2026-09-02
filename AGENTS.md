<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Where the reasoning lives

Two areas of this codebase carry decisions that the code cannot explain on its
own, and both have traps that look like tidying. Read the relevant handoff
**before** changing either — they are written to be skimmed, and each says up
front which section matters for which kind of change.

- **`LAUNCH_READINESS_HANDOFF.md`** — the outstanding work between here and two
  live leagues: two open production doors, the claims in `LAUNCH.md` that went
  false, and the actions the audit log still does not cover. **Read this one
  first** if you are picking the project up cold; it says which of the others
  you actually need.
- **`SCHEDULE_HANDOFF.md`** — the schedule generator: weekday balance, bye
  spacing, ice-time share, and why the phases are ordered as they are.
- **`EXPORTS_HANDOFF.md`** — the CSV and calendar exports, the single read path
  through `src/lib/queries/schedule.ts`, and what postponing a game does to its
  date. Section 4 describes a way to silently corrupt game rows while believing
  you are simplifying; read it before touching postponement or the one-off
  planner.
- **`ACCESS_CONTROL_HANDOFF.md`** — who can do what, and where: the
  `profile_leagues` membership model, the guards over every manage page and
  server action, and the RLS half that backs them. Its *Traps* section is the
  part to read first: the ways a guard here can look correct and do nothing —
  an RLS-refused `UPDATE` that reports no error, an audit entry filed under a
  league that resolves to null and is then hidden from every view that would
  show it. Read it before touching a guard, an RLS policy, or anything under
  `src/lib/auth`.

`docs/superpowers/specs/` holds the per-change design docs these summarise,
including the alternatives that were considered and rejected. Reach for a spec
when a handoff tells you *what* was decided and you need *why*.
