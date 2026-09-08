# 9466c507 — the deferred code work: 6 gaps and IA approach C

**Protocol — read this and nothing else to resume.**

1. This file is self-contained. Every item still open here is **parked, not in
   flight** — nothing is half-done, and no item depends on another. Item 1 is the
   exception and is marked SHIPPED; it is kept for its reasoning, not as work.
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
   - ⚠️ **A fresh worktree has no `.env.local`** (it is gitignored), and without
     it `playwright.config.ts` loads no Supabase keys, so e2e fails in a way that
     looks like a broken app. Measured 2026-09-08. Copy it:
     `cp /Users/richardkarp/dev/obhl/.env.local .env.local`.
3. Every claim below is marked **measured** (watched appear on 2026-09-07) or
   **read** (a reading of the code, not run). Nothing is unmarked.
4. Verify the tree with: `npm run typecheck && npx vitest run && npx eslint src e2e`.
   ⚠️ **THE BASELINE DEPENDS ON YOUR BRANCH, AND BOTH NUMBERS ARE REAL.** Measured
   2026-09-08: `origin/main` gives **472** tests over 38 files; PR #44's branch
   (`test/clock-relative-fixture`) gives **480** over 37, because that PR DELETES
   `src/lib/schedule/writeGames.test.ts`. An earlier revision of this line called
   480 fabricated and said no tree had ever produced it — that was wrong. It was
   counted on #44, and it is exact. Use 472 only while #44 is unmerged.
   ⚠️ eslint has the same expiry, from the same cause: the two pre-existing
   `no-unused-vars` warnings that are the floor today live IN that deleted file,
   so the moment #44 lands `npx eslint src e2e` is clean with no floor at all.

**Status, 2026-09-08. Item 1 SHIPPED (PR #46, in review). ⚠️ THE OTHER SIX ARE NO
LONGER UNSTARTED — every one has been taken to a decision, so read this file as
the reasoning behind them rather than as a queue:**

- **2** — draft-row edit e2e: **PR #49**. ⛔ Note for anyone extending it: the
  obvious version of that test PASSES against a fully broken guard. A night swap
  is count-preserving whatever rows the server validated, and with the wrong
  scope the touched rows fall out of `rows`, so `after` comes back identical and
  `legalAfter`/`preserved` degrade to no-ops that permit anything. Only asserting
  a REFUSAL catches it.
- **3** — clock-shifted CI: **PR #51**, based on #44 rather than `main`.
- **4** — `slot_on` against two slot lists: **CLOSED, no change needed.** The
  divergence is deliberate on both sides and already documented at
  `schedule.ts:1432-1444`, which names all three callers and why each takes the
  list it does.
- **5** — triaged, and it is five claims rather than one task. The
  `refuteConstraints` miss is real, reproduced with a control, and fixed in
  **PR #53**. The dead `constraintCredits`/`teamMetrics` are deleted in **PR #54**.
  The `forcedByeCredits` claim is **overstated** — the credits ARE conditioned on
  forced byes; the real mismatch is the team-set one `presentSpacing` already
  documents and floors. The `save_rules` revert and the `saveRules` race are left
  alone deliberately, the first because it ADDS capability rather than fixing a
  defect.
- **6** — CI lint + Node pin: **PR #48**, and its own CI ran the new lint step
  green on a GitHub runner.
- **7** — approach C: spec in **PR #50**, which recommends deferring again for a
  better reason and corrects this file's cost estimate (see item 7 below). Its
  unblocker shipped separately as **PR #52**.

None of them has a deadline — item 1 held the only one, and it was behavioural
rather than dated.

---

## ✅ 1. The one that could still cost a season — SHIPPED

**A draft that AGES between generate and publish.** Fixed on 2026-09-08 in
PR #46 (`feat/stale-draft-publish-guard`, six commits). This entry is kept as a
record rather than deleted, because the reasoning is what makes the code
readable and two reviews turned on it.

**What shipped**, and it is the shape this file argued for — a warning plus a
one-click re-date, never a bare refusal:

- `src/lib/schedule/staleDraft.ts` — pure, 15 unit tests. Answers "has the
  draft's first game already been played over, and how many whole weeks must the
  schedule move to be publishable again".
- `publishSchedule` reads those dates before the terminal RPC and refuses only
  **unacknowledged** staleness: the confirm dialog submits the night it warned
  about, so a tab that never rendered the warning cannot slip past it. A read
  failure fails closed, retried once (`readWithOneRetry`).
- `redateDraftSchedule` moves every night by the same whole number of weeks via
  `moveNightTo` + `writeGames` (draft-scoped, audited, one transaction) — every
  matchup, weeknight and ice time preserved, wall-clock so DST cannot shift it.
- `StaleDraftNotice` + the publish dialog carry the warning; `e2e/31-stale-draft.spec.ts`
  drives all five paths.

⛔ **THE THING TO KNOW IF YOU TOUCH IT: staleness is an INSTANT, not a calendar
day.** `season_is_started` fires on `scheduled_at < now()`. A day-granular check
— which is what `isPastGameNight` correctly does at generate — misses the hours
between a night's face-off and midnight, and worse, its one-click remedy could
land a draft on a game that had already started, creating the exact state the
button exists to escape. Both directions are pinned in `staleDraft.test.ts`.

**What it deliberately does NOT do**, all stated in the UI rather than left to be
discovered:

- The weeks off and holidays from the generate form are not stored anywhere, so
  a moved night can land on one. The banner says so; the new dates all render.
- Saved date-keyed requests (`bye_on`, `slot_on`, …) stop resolving after a move.
  Also in the banner.
- A draft over `MAX_GAME_WRITES` (200) cannot be moved and is refused up front
  with discard-and-regenerate as the way forward. Not chunked on purpose: a
  half-moved season is worse than a refusal.
- A move that overruns `ends_on` is reported, not refused — the builder already
  permits publishing an overrunning draft, so refusing here would be stricter
  than the publish it exists to enable.

**Also still true, from `LAUNCH_READINESS_HANDOFF.md`:** any draft generated
before 2026-09-05 never met the generate guard at all. Those now trip the publish
warning rather than passing silently, but discarding them is still the right
move — the warning offers a move forward, not a reason to keep them.

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
fixes.

✅ **The "run it locally first" step is done (2026-09-08):** `npx eslint src e2e`
on `main` is clean apart from two `@typescript-eslint/no-unused-vars` warnings in
`src/lib/schedule/writeGames.test.ts:29` (`_fn`, `_args`) — warnings, not errors,
so a lint step gates green today. ✅ **`npm run lint` is now measured too
(2026-09-08).** It is bare `eslint`, which resolves its own file set from the flat
config — genuinely a different set from `eslint src e2e` — and it is equally
clean: 0 errors, same two warnings. PR #48 ships the step, pins Node via `.nvmrc`
in both jobs, and its CI ran `npm run lint` green on a real GitHub runner.

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

⛔ **This needs its own spec → plan → build cycle.** It is a route restructure,
not a refactor. That spec now exists — **PR #50** — and it corrects the cost this
file and the quote above both gave.

⚠️ **`27-one-chrome` costs ZERO.** Measured 2026-09-08: `e2e/27-one-chrome.spec.ts`
contains the string `schedule-builder` zero times, and never did in either of its
two commits (`8455541`, `c4bca1d`) — confirmed against a control grep that does
find `schedule` in the same file. The claim was wrong when written, not stale.
The real exposure it never named is **14 `revalidatePath` strings** that fail
SILENTLY when a route moves; `revalidate-paths.test.ts` passed on a stale path
until **PR #52** made it walk `src/app`. Measured e2e rewrite cost is 18 lines
across 5 files.

It was explicitly declined as a fold-in to the fixture wrap-up on 2026-09-07. Do
not attach it to an unrelated branch.

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
