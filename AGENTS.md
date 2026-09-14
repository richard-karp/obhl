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

# Standing gate: a test config may not override a search constant

⛔ **`vitest.config.ts` pinned `OBHL_SLOT_RESTARTS=2000` while `assignNights.ts`
defaulted to `20000`.** The schedule generator's Phase S therefore ran a 10x
longer search in production than in any test, and the two searches return
different schedules: at 20,000 the ice-time clustering feature's own tests fail
with `expected 13 to be less than or equal to 6`. PR #62 shipped a feature that
worked only at CI's restart count — the league saw its worst team go 14 -> 13,
not 14 -> 4, and the maintainer reported it as "not much better than before".
Measured and fixed 2026-09-09; `assignNights.test.ts` now asserts the variable is
unset.

**The rule:** a test config may raise a **timeout** freely. It may not set a
constant that shapes a search, a budget, or a result. The moment it does, every
assertion downstream stops being evidence about the product.

This is the second costume of the same mistake. The first was a feature that
rewrote `nightIndex` while only `scheduledAt` was persisted: 364 tests green,
nothing shipped. **Ask of any green suite: is this the program the user runs?**

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
  `src/lib/auth`. ⛔ It now also carries the one rule in this codebase that has
  **no RLS half on purpose** — the scorekeeper day restriction behind
  `/tonight`. Read that entry before "fixing" what looks like a missing
  policy. ⚠️ It also carries _Closing the night_: the cron that finalizes games
  left open, and the one client it must use — the default one silently does
  nothing and files false audit entries. ⚠️ Before adding any page under
  `/manage/`, check its second segment against `next.config.ts`'s redirects: a
  legacy one silently eats some of those paths.

⚠️ **The esportsdesk importer is rosters-only, and its unit tests stub the
network and the database.** `import.test.ts` covers three outcomes — the clean
redirect, a `teams.insert` failure reported as a shortfall, and a failed
membership grant — and the importer's other failure branches are untested.
`esportsdesk.test.ts` proves the roster parser against saved HTML. Neither can
see a change in esportsdesk's markup. The one real run (2026-09-09) found a
silent data loss the stubs could not — unnumbered players printed as `-`
matched nothing (fixed in PR #60). Treat a green suite here as saying nothing
about a live source, and remember what a bad run leaves behind: the import
creates a **public league with no delete UI**. The full migration (schedule,
results, stats) was removed on 2026-09-13; it had never run against a real
source.

`docs/superpowers/specs/` holds the per-change design docs these summarise,
including the alternatives that were considered and rejected. Reach for a spec
when a handoff tells you *what* was decided and you need *why*.
