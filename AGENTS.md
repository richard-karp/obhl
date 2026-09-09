<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Standing gate: an agent cannot merge a workflow change

⛔ **`gh pr merge` fails on any PR touching `.github/workflows/`** — GitHub
refuses it from an OAuth app without `workflow` scope, with
`refusing to allow an OAuth App to create or update workflow ...`. It is not a CI
failure and not a conflict, and no amount of re-running fixes it. Such a PR needs
a human in the web UI, or `gh auth refresh -s workflow`. Measured 2026-09-09 on
PR #51, which is open for exactly this reason.

# Where the reasoning lives

Four areas of this codebase carry decisions that the code cannot explain on its
own, and each has traps that look like tidying. Read the relevant handoff
**before** changing one — they are written to be skimmed, and each says up
front which section matters for which kind of change.

- **`LAUNCH_READINESS_HANDOFF.md`** — the outstanding work between here and two
  live leagues: the schedule rebuild and its one-way door, the `LAUNCH.md` phases
  nobody has verified, and the half of the auth work that needs a domain and a
  dashboard rather than a checkout. **Read this one first** if you are picking
  the project up cold; it says which of the others you actually need, and its
  first 130 lines are written to be the only thing you need to resume.
- **`SCHEDULE_HANDOFF.md`** — the schedule generator: weekday balance, bye
  spacing, ice-time share, and why the phases are ordered as they are.
- **`EXPORTS_HANDOFF.md`** — the CSV and calendar exports, the single read path
  through `src/lib/queries/schedule.ts`, the single *write* path for a schedule
  edit through `src/lib/schedule/gameWrites.ts` (§2 — an UPDATE by id, never an
  upsert — the write itself is the `apply_game_writes` RPC from `0045`, one
  transaction), the `?team=` filter both season exports must carry, and what
  postponing a game does to its date. Section 4 describes a
  way to silently corrupt game rows while believing you are simplifying; read it
  before touching postponement or the one-off planner. §6 holds the seed's
  home/away skew, which will pass a team filter that only works on half the
  games — read it before writing any test that filters by team.
- **`ACCESS_CONTROL_HANDOFF.md`** — who can do what, and where: the
  `profile_leagues` membership model, the guards over every manage page and
  server action, and the RLS half that backs them. Its *Traps* section is the
  part to read first: the ways a guard here can look correct and do nothing —
  an RLS-refused `UPDATE` that reports no error, an audit entry filed under a
  league that resolves to null and is then hidden from every view that would
  show it. Read it before touching a guard, an RLS policy, or anything under
  `src/lib/auth`.

⛔ **The esportsdesk importer has never been run end to end — by any test or any
person.** `src/lib/actions/import.test.ts` (19 tests) and `seasons.test.ts` (7)
stub the fetch and the database deliberately, and both e2e import specs stop at
the form, so a green suite says nothing about the real parser or the real
writes. Six review rounds found six bugs in that path, four of them after a
previous fix had "closed" it. It creates a **public league with no delete UI**,
so treat a change there as unverified until someone imports a real esportsdesk
URL. Steps: `docs/superpowers/specs/2026-09-08-league-creation-at-the-root-design.md`,
under *Acceptance*.

`docs/superpowers/specs/` holds the per-change design docs these summarise,
including the alternatives that were considered and rejected. Reach for a spec
when a handoff tells you *what* was decided and you need *why*.
