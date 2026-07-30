# One published schedule per season

## Problem

There is no `schedules` entity. A schedule is `games` rows scoped by
`season_id`, and `is_draft` is the entire lifecycle model. Publishing is a bulk
column flip:

```sql
update games set is_draft = false where season_id = ? and is_draft = true
```

Nothing owns the invariant "a season has at most one published schedule", so
nothing enforces it:

- `generateSchedule` deletes only drafts and never reads the season's published
  games. It builds a fresh season from the start date regardless of what is
  already live.
- `ScheduleBuilderPanel` queries drafts only, so it cannot tell that a published
  schedule exists, and renders the generate form unconditionally.
- `publishSchedule` flips every draft live without checking for already-published
  games.
- No database constraint stands in the way. `games` carries only
  `games_distinct_teams`.

So Generate → Publish → Generate → Publish leaves the season holding two
complete overlapping schedules. Both are `is_draft = false`, so both appear on
the schedule page, in the CSV export, in both `.ics` feeds and in the scoring
list, and both feed standings once played — every team's GP doubles.

The same gap has a second face: `is_draft` is one-way. Every `.delete()` against
`games` in the codebase is filtered `is_draft = true`, so there is no unpublish,
no revert-to-draft, and no way to remove a published game at all.

## Goals

1. A season has at most one published schedule.
2. Before the season starts, publishing a new schedule removes the previous one.
3. Once the season has started, the full schedule cannot be replaced.
4. A played game is never deleted.

## Non-goals

- **Partial mid-season reschedule.** Regenerating the remaining games from a
  date forward is a schedule-*generator* change, not a publish-path change: the
  generator would need seeding with games-played and home/away already accrued
  so the back half balances against the front half. It was judged rare enough
  not to build. Leaving it out is what makes goal 4 structural rather than a
  rule the code has to remember (see §1).
- **A standalone unpublish.** Deleting the live schedule without replacing it is
  not offered. Nothing asks for it, and every path that deletes live games
  should have a replacement ready to take their place.
- **Deleting an individual published game.** `Cancel` and `Postpone` already
  cover the real cases and are non-destructive.
- **Blocking the esportsdesk import.** It creates its own season and inserts
  `status = 'final'` rows directly. Under §1's rule such a season reads as
  started immediately, which is the correct outcome, and no import code changes.

---

## 1. What "started" means, and why goal 4 falls out of it

A season is started when any published game has been played or acted on. This
ships in `0026_replace_published_schedule.sql` alongside §2's function, which
calls it:

```sql
create or replace function public.season_is_started(p_season uuid)
returns boolean language sql stable security invoker set search_path = public as $$
  select exists (
    select 1 from games
     where season_id = p_season and not is_draft
       and (scheduled_at < now()
            or status <> 'scheduled'
            or home_goals > 0 or away_goals > 0)
  );
$$;
```

Three predicates, each covering the others' blind spot:

- `scheduled_at < now()` — a night has passed. This is the load-bearing one: a
  game played last night that nobody has scored yet is still a played game.
- `status <> 'scheduled'` — someone acted on it. Catches a game finished early
  with a future date, and a postponed game, whose `scheduled_at` is null and so
  invisible to the first predicate.
- `home_goals > 0 or away_goals > 0` — a score exists. Both columns are
  `not null default 0`, so this is a plain comparison.

**Goal 4 is a consequence of this rule, not a separate rule.** A replace only
runs when *no* published game matches any predicate. A single played game flips
the season to started and removes the delete path entirely. There is no code
path that walks a set of games deciding which to keep, so there is no such code
path to get wrong.

Rejected alternatives:

- **`seasons.starts_on` has passed.** The column is nullable and is only a
  *default* for the generator's first game night — the real first game can land
  much later. A season created during setup with a past `starts_on` would lock
  itself immediately.
- **State only, no date check** (`status <> 'scheduled'` or goals). A night that
  was played and not yet scored still reads as "not started", and republishing
  would erase it.

## 2. `replace_published_schedule`

`0026_replace_published_schedule.sql`:

```sql
create or replace function public.replace_published_schedule(p_season uuid)
returns table (deleted int, published int, refused text)
language plpgsql security invoker set search_path = public as $$
declare
  v_deleted int := 0;
  v_published int := 0;
begin
  -- Serialize publishes per season. Without it two managers publishing at once
  -- can both pass the checks below, and the second wipes what the first just
  -- promoted.
  perform pg_advisory_xact_lock(hashtext(p_season::text));

  if season_is_started(p_season) then
    return query select 0, 0, 'started'::text;
    return;
  end if;

  -- Nothing to promote. Without this a stale form submit — draft discarded in
  -- another tab — deletes the live schedule and publishes nothing in its place,
  -- emptying the season.
  if not exists (select 1 from games where season_id = p_season and is_draft) then
    return query select 0, 0, 'no_draft'::text;
    return;
  end if;

  delete from games where season_id = p_season and not is_draft;
  get diagnostics v_deleted = row_count;

  update games set is_draft = false where season_id = p_season and is_draft;
  get diagnostics v_published = row_count;

  return query select v_deleted, v_published, null::text;
end;
$$;

grant execute on function public.season_is_started(uuid) to authenticated;
grant execute on function public.replace_published_schedule(uuid) to authenticated;
```

**Why a function and not two calls from the action.** Replacing is a delete
followed by an update. Run as two PostgREST calls, a failure between them —
dropped connection, deploy restart — leaves the season with *zero* games: the old
schedule deleted, the new one still in draft, and the public schedule page, both
calendar feeds and the CSV all empty. The manager's browser sees a failed
request and nothing else. Inside one function the two steps commit together or
neither does. This is the same reasoning that produced `postpone_game` and
`restore_game` in `0025`.

**Why the started check is inside the transaction.** The rule is time-based.
`scheduled_at < now()` can tick over between a check in TypeScript and the write
that follows it, so a game 30 seconds from its start time would let a replace
through on a season that has just started. Evaluating it in the same transaction
as the delete closes that gap.

**Why the advisory lock.** Two concurrent publishes can both observe drafts
present and neither's snapshot see the other, after which the second deletes
what the first just promoted. `pg_advisory_xact_lock` serializes per season and
releases at commit.

**Why refusals return rather than raise.** The action maps `refused` to a
message for the manager. `started` and `no_draft` are both ordinary outcomes of
a stale page, not faults.

## 3. Actions

**`publishSchedule`** calls the function, maps the result, and audits.

| `refused` | message |
|---|---|
| `started` | "The season is under way — the schedule can no longer be replaced." |
| `no_draft` | "There's no draft to publish." |
| null, `deleted = 0` | "Published N games." |
| null, `deleted > 0` | "Replaced the published schedule — removed D games, published N." |

A replace deleting D live games is the most destructive manager action in the
app, so it calls `logAudit` — the pattern `games.ts` already uses for finalize,
reopen and recap. A first publish (`deleted = 0`) is not destructive and is not
audited, matching the existing bar.

**`generateSchedule`** calls `season_is_started` and returns early when true. A
locked season should not accept a draft it can never publish. This is a second
gate on the same rule, not a second copy of it.

## 4. The read path

`src/lib/queries/schedule.ts` gains:

```ts
export type SchedulePublishState = {
  liveCount: number;
  draftCount: number;
  started: boolean;
  firstLiveDate: string | null;
  lastLiveDate: string | null;
  lineupsAtRisk: number;
};

export async function getPublishState(
  seasonId: string,
  opts: { client?: DbClient } = {},
): Promise<SchedulePublishState>
```

It takes its options as an object whose `client` defaults to the RLS client, per
the rule documented at the top of that file; the manager-gated callers here pass
the admin client. No `isUuid` guard is needed — that rule covers helpers
interpolating a team id into a PostgREST `.or()` string, and this filters
`season_id` with `.eq()`.

Adding a manager-facing read to that file is consistent with it: `getSeasonNights`
already serves the one-off planner. The file's rule is that it is the single
place anything reads `games`, not that it is export-only.

**The split between SQL and TypeScript.** `started` comes from
`season_is_started` via RPC, so the rule has exactly one definition. The
aggregates — counts, date range, lineups at risk — are ordinary PostgREST reads
in TypeScript. A wrong count renders a slightly wrong sentence; a wrong rule
deletes a season. Only the second belongs where it must be authoritative.

`lineupsAtRisk` counts `game_rosters` rows attached to the season's live games.
Those rows cascade on game delete (`0004_games.sql:36`), so a replace silently
discards any lineup a captain set in advance. This is only reachable before the
season starts, but it is real and the confirm dialog names it.

## 5. UI

`ScheduleBuilderPanel` reads drafts only today, which is precisely why it cannot
see the problem. It takes `getPublishState` and renders one of five modes:

| live | draft | started | what the manager sees |
|---|---|---|---|
| — | — | — | Generate form, "No draft schedule" *(unchanged)* |
| — | ✓ | — | Generate form, **Publish N games** — one click *(unchanged)* |
| ✓ | — | — | Generate form, plus "Published: N games, Sep 15 – Mar 02" |
| ✓ | ✓ | — | Generate form, **Replace published schedule** → confirm dialog |
| ✓ | any | ✓ | Locked panel; Discard offered if a stale draft exists |

Only row four is destructive, and only it gets a dialog — a season's first
publish stays one click. The dialog (built on the existing
`components/ui/dialog.tsx`) states the live count and date range being deleted,
the draft count replacing it, that team calendar feeds will change, and — when
`lineupsAtRisk > 0` — that captains' pre-set lineups go with the games. Plain
Cancel / Replace; no typed confirmation.

The locked panel explains that the schedule is live and points at the tools that
do work: Reschedule / Postpone / Cancel on `/score/[gameId]`, and the one-off
planner for slotting in a final or semifinal.

`revalidatePath` calls are unchanged from the current `publishSchedule` —
`/schedule-builder`, `/seasons/[id]`, `/schedule` and `/`.

## 6. Verification

**Unit (vitest).** The testable seam is the mode decision, extracted as a pure
`publishMode(state: SchedulePublishState)` returning one of the five modes above.
This follows the same instinct that produced `checkOneOffWrite` and
`buildOneOffRows` — pull the decision out of the I/O and test it there.

**End-to-end (`e2e/11-schedule-builder.spec.ts`).** Two cases:

1. Publish, regenerate, replace → the season holds one schedule's worth of
   games, not two. This is the reported bug, and it fails before the change.
2. A started season shows the locked panel instead of the generate form.

**SQL.** The two functions are not covered by the vitest suite, which tests pure
TypeScript modules. Rather than imply coverage that does not exist, verify by
hand against a local `db reset`:

- Season with a future-dated live schedule and a draft → replace succeeds, live
  count equals the former draft count.
- Same, but one live game's `scheduled_at` moved into the past → returns
  `started`, both counts zero, nothing deleted.
- Same, but one live game set to `final` with a future date → returns `started`.
- Live schedule present, no drafts → returns `no_draft`, nothing deleted.
- A season whose games were created by the esportsdesk import → returns
  `started`.

This is the posture `EXPORTS_HANDOFF.md` §6 takes about its own migration
backfill: state what was actually verified and how to repeat it.

## 7. Deployment note

`main` and the hosted database both carry `0025`. This adds `0026`, and it is
additive — two new functions, no schema change and no backfill. Schema ahead of
code is harmless here: the functions simply go uncalled until the app ships.
