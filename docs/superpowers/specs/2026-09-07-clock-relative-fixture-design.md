# The test fixture must be relative to the clock, not to 2026

**Date:** 2026-09-07 · **Status:** design, approved in chat, not yet built
**Decided by:** the user, 2026-09-07.

## The problem, and why it is not a date field

`supabase/seed.sql` pins **32 dates**. The one that matters is `seed.sql:178`:

```sql
values (v_league, 'Fall 2026', date '2026-09-15', date '2027-03-31', false, …)
```

Three e2e specs then restate it — `11-schedule-builder` fills it into "First game
night" six times, `23-schedule-constraints` and `28-schedule-form-state` hold it
as `const FIRST_NIGHT = "2026-09-15"`.

⛔ **ON 2026-09-16 THIS IS NOT A VALIDATION FAILURE, IT IS A SEASON THAT HAS
STARTED.** The obvious reading — "a past date in a field bounded below by today"
— is the smaller half. `season_is_started(Fall 2026)` flips to true, the builder
locks itself, and `11-`'s stated premise (`11-:22`, "the active season is in the
past, so these tests drive Fall 2026") becomes false. **Changing the `fill()`
values cannot fix that**, and a fix that only changes them will look right, pass
review, and fail on the 16th anyway.

Nine days from this writing.

## The same defect, further out

`14-one-off-game` and `29-schedule-repair` seed their own seasons at
`2027-01-05`. Identical failure, ~4 months away. `30-schedule-edits` already
computes its year (`getUTCFullYear() + 2`) and is the pattern to copy.

## The shape: anchors, not a uniform future

⚠️ **"ALWAYS IN THE FUTURE" IS THE WRONG RULE AND WOULD BREAK MORE THAN IT
FIXED.** The seed deliberately holds both kinds of season, and each role is
load-bearing:

| Season            | Rows               | Role                                                 | Anchor                |
| ----------------- | ------------------ | ---------------------------------------------------- | --------------------- |
| Spring (league 1) | 15 games, 10 final | scoring, standings, recap, cancelled-game visibility | `current_date − 120d` |
| Spring (league 2) | 6 games, 4 final   | the second-league half of the same                   | `current_date − 119d` |
| Fall 2026         | 0 games            | **unstarted**, generatable — the builder specs       | `date_trunc('week', current_date + 14) + 1` (+9…+15d) |

Those 14 finalized games are what every scoring assertion runs against. Move
Spring forward and the fixture holds results that have not happened yet. Fall is
the exact opposite: it exists to be unstarted.

**Every timestamp inside a season becomes an offset from that season's anchor**,
so the fixture keeps its internal shape.

### ⛔ Two traps in the offsets

**1. THE GAPS ARE DELIBERATE. DO NOT REGENERATE AN EVEN CADENCE.** League 1's
game nights are `05-12, 05-19, 05-26, 06-09, 06-16` — **`06-02` is missing**.
League 2's are `05-13, 05-20, 06-10` — `05-27` and `06-03` are missing. Those
gaps are bye weeks, and the spacing and bye-distribution assertions read them. A
rewrite that emits "anchor + 7n" for n in 0..4 produces a different fixture that
still looks plausible. Offsets must be transcribed per row from the existing
dates, not computed from a rule.

**2. `-04` IS A HARDCODED EDT OFFSET AND WILL BE WRONG HALF THE YEAR.** Every
timestamp is written `timestamptz '2026-05-12 19:00-04'`. Today's anchor is in
EDT; `current_date − 120d` in January is EST. Keep the literal `-04` and every
game silently moves an hour — which is not cosmetic, because `leagueDateKey`
buckets by the league's local day and a 21:30 game shifted an hour can land on
the wrong night, changing games-per-night for a schedule whose whole test suite
asserts games-per-night.

**The fix: build the timestamp in the league's zone and let Postgres resolve the
offset**, e.g. `(anchor + interval '7 days' + time '19:00') at time zone
'America/Toronto'`. The zone name is stable across DST; the numeric offset is
not.

## ⛔ The season NAMES stay literal, and that is a decision

`'Spring 2026'` and `'Fall 2026'` are names, not dates — and **17 assertions
across 8 specs match them literally**, several as visible UI text
(`getByText("Fall 2026")`, `getByRole("row", { name: /Fall 2026/ })`).

**They keep their current literal form.** In this fixture a season name is an
IDENTIFIER — the handle a spec uses to find its season — not a claim about when
the season runs. Computing the name from the anchor year would force all 17 sites
to stop matching literals, including UI-text assertions that would then have
nothing stable to assert, and would buy nothing: no test reads meaning from the
year in the name.

⚠️ **THE CONSEQUENCE, STATED SO NOBODY "FIXES" IT:** after this change a season
called "Fall 2026" will start in whatever year is eight days from now. That looks
wrong and is not. `seed.sql` must carry a comment at each name saying so,
otherwise the next person to read the fixture will pin the dates back to match
the names and reintroduce exactly this bug.

## How the specs learn the dates

**Chosen: read `starts_on` from the database.**

The bug being fixed _is_ a spec restating a date the seed owns. Reading it back
makes the seed the single source of truth, and a spec can no longer disagree with
the fixture it runs against. Costs one query per spec, in files that already open
an admin client.

**Rejected: recompute the same offsets in each spec.** No query, but the formula
would live in five files and would drift the first time one of them changed —
which is the defect this document exists to remove, reintroduced in a new place.

## What is NOT changing

- The fixture's **shape**: same leagues, seasons, teams, game count, bye weeks,
  ice times, results, standings. Only the dates move, together.
- The three test-only seasons that specs create for themselves
  (`One-Off Test`, `Repair Test`, `Edit Test`) keep their own seeding; `14-` and
  `29-` only stop pinning the year.
- No application code. This is fixture and test scaffolding only.
- ⛔ **`24-password-auth` is untouched.** Its reset loop is complete and was
  wrongly believed to be a gap; see below.

## Out of scope, recorded so it is not re-litigated

⚠️ **The password-reset e2e already exists** — `24-password-auth.spec.ts:218`
requests the link, pulls the real message from Mailpit, follows the verify link,
sets a new password and signs in with it. It was scoped into this work on the
belief that the leg was unproven; it is not, and nothing should be added.

The residual risk is the one that test names itself: a `redirectTo` outside
Supabase's allow-list is refused **silently** — no error — and the mail points at
the Site URL instead, so the person lands signed in on `/` with the token spent.
Locally it passes only because `config.toml` allows `http://localhost:3000/**`.
**That is a production dashboard check, not something an e2e can cover.**

## Testing

The fixture is what every spec runs against, so the verification is the **full
e2e suite**, not a targeted subset. A partial run cannot show that the fixture
still holds its shape.

⚠️ **And one check the suite cannot make: run it twice, with the machine clock
set forward past the old pinned dates.** The whole point is that the fixture no
longer has an expiry, and a green run today proves only today. If setting the
clock is impractical, seed with an injected anchor instead and assert the derived
rows land where they should.

Baseline to beat: **221 passed, 1 skipped, 0 failed** (watched, 2026-09-07).

## Success criteria

1. No literal year remains in any **date or timestamp** in `seed.sql`. Season
   NAMES keep theirs, deliberately — see the section above — and each carries a
   comment saying the year in the name is not a claim about the dates.
2. `11-`, `23-`, `28-` read the season's dates from the database rather than
   restating them; no `2026-09-15` remains in `e2e/`.
3. `14-` and `29-` compute their season years the way `30-` does.
4. Bye-week gaps and ice times are identical to today's fixture, verified row by
   row rather than by eye.
5. Game times land on the same league-local nights regardless of DST.
6. The full suite is green, and green again with the clock moved forward.
