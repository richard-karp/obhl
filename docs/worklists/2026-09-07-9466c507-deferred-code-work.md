# 9466c507 — the deferred code work: 6 gaps and IA approach C

**Protocol — read this and nothing else to resume.**

1. This file is self-contained. It is the dossier for work that is **parked, not
   in flight** — nothing here is half-done, and no item depends on another.
   ⛔ Do NOT read `docs/superpowers/specs/2026-09-07-manual-schedule-edits-design.md`
   (239 lines) unless you are doing item 7; its IA section is quoted below in full.
   ⛔ Do NOT read `LAUNCH_READINESS_HANDOFF.md` (1150+ lines) to find these items —
   its §5 row points here, and this file is the copy that is current.
2. ⛔ **Standing hazards, before any instruction:**
   - `supabase db reset --linked` **wipes production**. `npm run db:reset` is the
     local one and is safe. `supabase db push` is the user's to run, not an agent's.
   - **Publishing a schedule is a one-way door.** `season_is_started` (`0026`)
     locks generate, replace and remove permanently. Item 1 is about exactly this.
   - Export a distinct `PORT` and run e2e only via `scripts/e2e-locked.sh` —
     worktrees share one Supabase.
3. Every claim below is marked **measured** (watched appear on 2026-09-07) or
   **read** (a reading of the code, not run). Nothing is unmarked.
4. Verify the tree with: `npm run typecheck && npx vitest run && npx eslint src e2e`.
   Baseline 2026-09-07: typecheck clean, **480 unit tests passed**, eslint clean.

**Status: none started. Item 1 is the only one with a deadline attached to it,
and the deadline is behavioural rather than dated — it binds whenever a manager
generates a draft and publishes it later.**

---

## The one that can still cost a season

### 1. A draft that AGES between generate and publish is guarded by neither end

**Measured.** `isPastGameNight` (`src/lib/schedule/startDate.ts`) has exactly one
caller: `src/lib/actions/schedule.ts:399`, inside generate. `publishSchedule`
(`src/lib/actions/schedule.ts:716`) has no date check of any kind — its only
refusals are `started` and `no_draft`.

⚠️ **This is NOT the "publish is unguarded, go add a guard" item it looks like,
and an earlier reading of it by this session was wrong.** The guard's own
docstring makes the opposite case deliberately:

> ⚠️ Guard the GENERATE, not the publish. Refusing at publish is the obvious
> place and is worse: by then the manager has a draft they have reviewed and can
> do nothing with, and the message arrives too late to act on cheaply.

That reasoning is sound for the case it addresses — a manager typing a past date
into the generate form. **The uncovered case is different: a draft generated with
a perfectly valid future date, left standing, and published after that date has
passed.** Generate checked the date when the draft was made; publish never checks
it again. The window is however long the manager waits.

⛔ **This is precisely the shape of the schedule rebuild workflow** — generate and
review early in the week, publish later — so it is reachable by the intended
usage, not only by mistake.

**What a fix has to decide, and why it is not a one-liner:** refusing at publish
recreates exactly the failure the docstring rejects (a reviewed draft that cannot
be published, with no cheap action left). The likely-correct shape is a warning at
publish naming the stale night plus a one-click re-date, not a refusal — which is
a UI decision, so it needs the user. Do not just add a throw.

**Also still true, from `LAUNCH_READINESS_HANDOFF.md`:** any draft generated before
2026-09-05 never met the generate guard at all. Discard those; do not publish them.

---

## The two that hide the next bug

### 2. No e2e drives an edit of a DRAFT row

**Measured.** Every edit test in `e2e/30-schedule-edits.spec.ts` scopes to
`.eq("is_draft", false)` (lines 111, 146, 166, 223, 584). The test at line 453,
"edits still work with a draft staged over the published schedule", stages a draft
and then edits the **published** rows — which is the state that broke once, but is
not the same thing as editing a draft.

The manual-schedule-edits spec admits this against itself:

> ⚠️ **NOT covered, and this spec claimed otherwise:** editing a DRAFT row itself
> through the builder's panel. The components render there and the actions are
> scoped for it, but no test drives it.

So the draft edit path is shipped, scoped, and unexercised.

### 3. No CI job runs the suite at a shifted clock

**Measured.** `.github/workflows/ci.yml` runs `npm ci`, `npm run typecheck`,
`npm test`, and the e2e job. Nothing manipulates the clock.

⛔ **This is the gap that matters most for everything PR #44 just did.** The seeded
fixture is now clock-relative, which means its failure modes are reachable only at
particular clock positions. Proof it is not theoretical: `c7ec42d` on that branch
fixed a date-picker click that would have started failing on 2026-09-28 and on 105
of the following 800 days — and it passed a full green suite while latent, because
today's clock does not trigger it. Two task-level reviews also missed it.

**Cheapest useful shape:** a scheduled job that seeds with the three anchors in
`supabase/seed.sql` substituted to a fixed future date and runs the suite. ⚠️ Note
the trap found on 2026-09-07: substituting the anchors alone moves the fixture
without moving the clock that judges it, so `season_is_started` disagrees and specs
fail for unrelated reasons. Either move the container's clock, or accept that the
substitution route proves the seed's arithmetic and timezone handling only.

---

## The three small ones

### 4. `slot_on` resolves against two different slot lists

**Read**, and confirmed by a previous session on 2026-09-05; documented in
`LAUNCH_READINESS_HANDOFF.md`. `generateSchedule` matches pins against the FORM's
`slot_times`; `planOneOff`'s caller builds its list from the season AS PUBLISHED
(`leagueTimeKey(g.scheduledAt)`, with `--:--` standing in for a postponed game).
So a pin honoured at generation can fail to match during a one-off repair. Real,
deliberate on one side, low severity — not the silent-corruption shape its original
wording suggested.

### 5. Four never-triaged review findings

**All read, none reproduced.** Recorded from the sixth review of #24 and never
triaged since. Treat each as a claim to check, not a measurement:

- `refuteConstraints` misses `bye_in_week` on an all-zero-quota week.
- The constraints panel applies `forcedByeCredits` unconditionally, rather than
  only where a forced bye caused the breach.
- `save_rules` audit entries are not revertible — `old_data` holds what a revert
  needs, but `revertAuditEntries` (`src/lib/actions/audit.ts`) has no case and the
  audit page's `isRevertible` returns false.
- `saveRules`' read-then-upsert is not atomic, so two concurrent saves can file an
  audit entry whose `old_data` names something it did not overwrite. ⚠️ Left alone
  on purpose: closing it means a plpgsql function and a migration, a bad trade for
  an unmeasured race on a page edited a few times a season.

Also: `constraintCredits` / `teamMetrics` have **no production reader** — dead
until something renders them.

### 6. CI does not lint, and the Node version is not pinned

**Measured.** `.github/workflows/ci.yml` has no `npm run lint` step though the
script exists in `package.json`. There is no `.nvmrc` and no `engines` key, so the
workflow's `node-version: 22` is the de-facto source of truth. Both are one-line
fixes; the lint one may surface existing violations, so run it locally first.

---

## 7. IA approach C — deferred, not dismissed

The manual-schedule-edits spec chose approach B (fold in-season editing into Games)
and recorded C as the likely eventual shape. Quoted in full so this file stands
alone:

> - **C — one "Schedule" section with sub-nav.** Tabs over Games / Repair /
>   One-off / Build. Cleanest conceptually, and the likely eventual shape — but it
>   is a route restructure with three redirects and `27-one-chrome`'s assertions
>   to rewrite, proposed three days before a one-way-door deadline. Deferred, not
>   dismissed.

The deadline that deferred it was the 2026-09-10 schedule rebuild. Once that has
passed, the reason for deferring is gone and only the cost remains.

⛔ **This needs its own spec → plan → build cycle.** It is a route restructure, not
a refactor: three redirects in `next.config.ts` and the `27-one-chrome` assertions
to rewrite. It was explicitly declined as a fold-in to the fixture wrap-up on
2026-09-07. Do not attach it to an unrelated branch.

---

## Provenance

Assembled 2026-09-07 by session 9466c507, on the day PR #44 (the clock-relative
fixture) was opened. Items 4-6 were carried forward from
`LAUNCH_READINESS_HANDOFF.md`'s "From the sixth review of #24" section, which
remains their origin; items 1-3 and 7 were established or re-measured in this
session.

⚠️ **One thing this session did not fix and the next should decide on:**
`LAUNCH_READINESS_HANDOFF.md` declares its hot tier "capped at 130 lines" (line 31),
and the tier — everything above `## The items, and where they stand` — currently
runs to **163 lines**. Measured. It overran by 33 without anyone noticing, which is
the failure the cap exists to prevent. Either evict, or raise the number
deliberately and say why.
