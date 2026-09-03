# Roster import and mid-season transfers

**Protocol — read this and nothing else to start.**

1. This file is self-contained. Its background is `ACCESS_CONTROL_HANDOFF.md`
   (the guard/RLS pairing and the null-`league_id` audit trap) and
   `LAUNCH_READINESS_HANDOFF.md` (what production still needs). Open them only
   where a section below says to. You do **not** need `SCHEDULE_HANDOFF.md` or
   `EXPORTS_HANDOFF.md`: nothing here touches the generator, and no export reads
   the stats views (checked — section 6).
2. ⛔ **Hazards, before any instruction:**
   - `supabase db reset --linked` **wipes production**. Use `db push`.
     `npm run db:reset` is the *local* one and is safe.
   - **This work begins with a deliberate wipe of the whole database.** That is
     the operator's decision and the operator's command, not an agent's. See
     *Order*.
   - **Migration numbers start at `0035`.** `0034_league_office.sql` exists and
     belongs to `docs/superpowers/specs/2026-09-03-league-office-design.md`.
     Both were untracked and in progress on another branch as this was written,
     so `git log` will not explain them. Confirm 0034 landed before pushing
     0035; if the league office was abandoned, renumber rather than leaving a
     gap.
   - **Section 2 is a live bug on `main`, not part of this feature.** It must be
     fixed *inside* this work, because this work rewrites the views it lives in.
3. Claims below are marked. "Watched" means it was run and the output read.
   "A reading" means it follows from the code and has not been executed.

## 1 — What this is

Two leagues are being brought into OBHL for the coming season. The database is
emptied first; nothing is being preserved. Last season's esportsdesk rosters are
wanted **only as a starting draft** for this season's teams — no stats, no
records, no schedule. The manager then edits rosters until they are right, and
occasionally moves a player between teams once the season is running.

That last part is the whole of the difficulty. The requirement, stated exactly:

> when [a player switches teams] their stats should move with them, though those
> stats should remain in totals in the team they were counted for and should not
> count towards the totals of the new team.

This reads as a contradiction and is not one. It separates two audiences:

- **The player's line on the league leaderboard** is their whole season and
  follows them. Jane plays 10 games for the Rangers (5G 3A), transfers, plays 8
  for the Kings (4G 6A) — the leaderboard shows **one** row: Jane, Kings, 18 GP,
  9G 9A, 18 PTS.
- **A team's page** shows only what was earned in that sweater. The Rangers page
  still shows Jane at 10 GP, 5G 3A. The Kings page shows 8 GP, 4G 6A. The
  Rangers' totals never lose her; the Kings' totals never gain her past.

Per-game attribution is already correct and needs no new machinery:
`game_rosters.team_id` records which team a player played that game for. Dates
are therefore **not** load-bearing anywhere in this design.

**Two projects, built in order.** *A* (import + de-duplication) is needed before
the season starts. *B* (transfers) is needed before the first game is played.
They ship separately, but B's model constrains A's, because merging duplicate
players is the same operation as transferring one — both re-point a player's
rows and both must leave per-team attribution intact.

## 2 — The bug this sits on top of

**Watched, 2026-09-03**, against the running local database:

```
psql -Atc "select pg_get_viewdef('public.v_goalie_stats'::regclass, true)"
  | grep -c home_goalie_id   →  0
  | grep -c empty_net        →  0
```

`0024_exclude_drafts_from_stats.sql` is the **last** migration to define
`v_goalie_stats` (watched: only `0007`, `0014`, `0015`, `0024` define it). Its
header says it rebuilt the views on "the same reasoning as 0014, whose
definitions these are" — and it did precisely that, taking **0014's** goalie view
rather than **0015's**. So it silently reverted two shipped features:

- `0015_goalie_of_record.sql` — the explicit goalie of record
  (`games.home_goalie_id` / `away_goalie_id`, and the `goalie_is_sub` flag).
- `0018_empty_net_rpc.sql` — subtracting empty-net goals from a goalie's
  goals-against.

The application still writes both, and still shows them back to the scorekeeper:

| Where | What it still does |
|---|---|
| `src/lib/actions/games.ts:231` | writes `home_goalie_id` / `away_goalie_id` |
| `src/lib/actions/games.ts:251` | calls `bump_game_empty_net` |
| `src/app/[league]/manage/score/[gameId]/page.tsx:152` | reads both back into the UI |

**Consequences (a reading):** the goalie of record silently falls back to "lowest
`player_id` among players dressed at position G", so picking a goalie changes
nothing on the leaderboard; and **GAA is inflated by empty-net goals** for every
goalie in every league.

This is fixed as part of section 6, not deferred. Section 6 rewrites both views;
rebuilding them from the reverted definitions would make the regression
permanent and much harder to spot later.

It also shrinks the transfer problem. With only the fallback branch alive, every
goalie appearance depends on a `team_players` inner join — so a departed goalie
loses **all** of the old team's record (section 5). Restoring 0015's explicit
branch means a goalie who was picked for a game keeps that game regardless.

## 3 — Piece A: the roster-only import

The existing scraper already returns exactly what is wanted.
`fetchEsportsdeskLeague` yields teams-with-players and is independent of
`fetchEsportsdeskSchedule` and `fetchEsportsdeskStats`.

**New file `src/lib/actions/import-rosters.ts`, exporting
`runRosterOnlyImport`.** A sibling to `runEsportsdeskImport`, not a flag on it:
`src/lib/actions/import.ts` is already ~410 lines, and its comments commit it to
being the faithful one-time migration. A "skip the good parts" parameter would
make one function serve two jobs with opposite definitions of success.

It creates, in this order:

1. league (name → `slugify`, rejecting an empty slug and a reserved one)
2. **manager membership** via `addLeagueMembership`
3. the `import_league` audit entry
4. season, `is_active: false`
5. teams + `season_teams`
6. players + `team_players`

Steps 1-3 keep `runEsportsdeskImport`'s ordering verbatim, and for its stated
reason: an imported league whose creator is not a member is a league nobody can
open, and there is no UI to delete one. The per-team jersey rule carries over
too — the first wearer of a number keeps it and later repeats get `null`,
because `unique (season_id, team_id, jersey_number)` would otherwise fail the
bulk insert. Postgres does not collide `null`s in a unique index, so any number
of unnumbered players is fine.

It never calls the schedule or stats scrapes. Positions come through as `F`
unless esportsdesk says otherwise; goalies are set afterwards in Rosters, as
today.

**UI:** `/[league]/manage/import` gains a mode toggle — *Full migration* vs
*Rosters only (new season setup)*. In rosters-only mode the preview hides the
game count, since no games will be read.

## 4 — Piece A: the duplicate-merge tool

esportsdesk has no stable person id, only names, and **two different people
genuinely share a name**. So the import never guesses: it writes one `players`
row per roster line, and a separate tool proposes merges for a human to decide.

**Scope is one league, structurally.** Candidate clusters are built from
`players` reachable from the current league through
`team_players → seasons → league_id`, grouped by normalized name (`normName`
already exists in `import.ts`). A player in another league is not in the
candidate set, so a cross-league merge is not a disabled button — it is
unreachable. This is what makes "the same human in two leagues is two records,
deliberately" a property of the schema's use rather than a rule someone has to
remember.

⚠️ This contradicts `supabase/migrations/0002_core.sql:43`, which asserts
"Identity is GLOBAL (not league-scoped)". Identity remains global *in the
schema* — `players` still has no `league_id` — but every operation that could
join two identities is league-scoped. **Correcting that comment is part of this
work.** A comment asserting the opposite of what the code now guarantees is
load-bearing for the next reader's model.

**`mergePlayers(keepId, mergeIds[])`** re-points five columns (watched — this is
every foreign key into `players`):

| Table | Column | On delete |
|---|---|---|
| `team_players` | `player_id` | cascade |
| `game_rosters` | `player_id` | cascade |
| `team_goalie_days` | `player_id` | cascade |
| `games` | `home_goalie_id`, `away_goalie_id` | set null |
| `profiles` | `player_id` | set null |

Three collisions need real answers rather than an upsert:

- **Both dressed for the same game** — `game_rosters` is unique on
  `(game_id, player_id)`. **Sum** goals/assists/PIM into the kept row and delete
  the other. For a genuine duplicate that is the only correct result: one human
  played one game.
- **Both on the same team in the same season** — `team_players` is unique on
  `(season_id, team_id, player_id)`. Keep the richer row (a jersey number, then
  captaincy, then status flags); delete the other.
- **On different teams in the same season** — not a merge conflict but a
  dual-roster. The operator picks which team is current; the other row becomes a
  departure (section 5). This is also what keeps the new partial unique index in
  section 5 satisfiable.

Audited as `merge_players`, with the absorbed ids in `old_data`. **It is not
revertible** — summed stat rows cannot be split back apart — and the UI says so
plainly rather than implying the audit log can undo it.

## 5 — Piece B: soft departure

`0035_roster_departures.sql`:

```sql
alter table team_players add column left_on date;
```

`null` means *currently on this team*. The old roster row **survives** a
transfer, and that single fact is what makes the two failure modes structurally
impossible rather than separately defended:

- **The goalie trap (a reading).** `v_goalie_stats` *inner* joins `team_players`
  on `(season_id, team_id, player_id)` where `position = 'G'`. Delete the old row
  and every goalie appearance for the old team — GP, W, L, T, GAA, shutouts —
  vanishes from the leaderboard while the games themselves remain. The row
  surviving is what keeps that join satisfied.
- **The skater trap (a reading).** `v_skater_stats` *left* joins the same row for
  `jersey_number` and `position`. Delete it and the old team's line survives with
  both columns `null`.

Index changes:

- **Drop** `unique (season_id, team_id, jersey_number)`; replace with the same
  index **partial on `left_on is null`**, so a departed player's number frees up
  for a new signing while their history keeps the number it was earned under.
- **Keep** `unique (season_id, team_id, player_id)`. A player returning to a
  former team **clears `left_on` on the existing row** rather than inserting a
  second one, so the constraint never needs relaxing.
- **Add** `unique (season_id, player_id) where left_on is null`. This is the one
  that earns its keep: it makes "the player's current team" *well-defined*
  rather than merely usual, so the leaderboard's current-team join in section 6
  can never return two rows. Section 4's dual-roster resolution exists so this
  index is satisfiable after a merge.

**`transferPlayer(formData)`** — season, player, from-team, to-team, optional
date:

1. Resolve `league_id` **before** any write. Per `ACCESS_CONTROL_HANDOFF.md`, an
   audit entry that resolves its own league after the row has moved lands with a
   null `league_id` and is then hidden by RLS and by every league-scoped view —
   including the one that would show the operator what happened.
2. Guard with `requireLeagueManagerOf` over the season **and both team ids**,
   exactly as `addRosterPlayer` does (`src/lib/actions/rosters.ts:33`) and for
   the same reason: these forms carry ids, never a league, so guarding the season
   alone lets a foreign `team_id` through.
3. On the old row: set `left_on`, clear `is_captain`, clear `is_default_goalie`.
4. Delete the old team's `team_goalie_days` rows for that player.
5. On the new team: insert, or clear `left_on` if a row already exists. Carry
   `position` over. If the wanted jersey number is taken on the new team, say so
   and let the operator choose — do not silently write `null`.
6. Audit `transfer_player`.

Step 3's `is_captain` clear is a **security fix, not tidiness** — see section 7.

## 6 — Piece B: the views

`0036_transfer_stats.sql` rebuilds `v_skater_stats` and `v_goalie_stats` from
**0015's** definitions (restoring the goalie of record and the empty-net
subtraction, section 2) **plus** 0024's `not is_draft and game_type = 'regular'`
filters. Both intents survive; neither is inferred from the other.

Then the split that produces the agreed leaderboard:

- **`v_skater_stats` and `v_goalie_stats` stay grouped per team**, exactly as
  today — `group by (season_id, player_id, team_id)`. Team pages already read
  them and do not change.
- **New `v_skater_season_totals` and `v_goalie_season_totals`** group by
  `(season_id, player_id)`, sum across teams, and join the current team through
  `team_players where left_on is null` for the name, colour, jersey and position.

Consumers (watched — this is the full list; no CSV export reads either view):

| Consumer | Reads after this change |
|---|---|
| `src/app/[league]/(public)/page.tsx:40` (home, top 8) | totals |
| `src/app/[league]/(public)/stats/page.tsx:24,25` | totals |
| `src/lib/actions/seasons.ts:319` (AI league summary) | totals |
| `src/lib/queries/teams.ts:72,78` (team pages) | **per-team, unchanged** |
| `src/lib/queries/players.ts:96,129,143` (player pages) | **both** — see below |

`getSkaterLeaders` and `getGoalieLeaders` in `src/lib/queries/stats.ts` switch to
the totals views; that covers the first three rows at once.

**The player page shows both**, and this is a deliberate choice rather than an
oversight: the season total line at the top (which is what "the stats moved with
her" means to the person reading their own page), and beneath it the per-team
breakdown, which is the only place in the app where the split is visible as a
split. `queries/players.ts:88` currently derives team and position from
`v_skater_stats` as a fallback for players with no roster row; that fallback must
read the per-team view, since the totals view's team column is the *current* one
and would defeat the purpose.

## 7 — The read sites

The unglamorous half, and where a rushed implementation fails. Every
`team_players` read must answer *active, or all?* (a reading — the list is from
grep, the classification is judgement):

**Filter to `left_on is null`** — these all mean "who is on this team now":
`src/app/[league]/manage/rosters/[teamId]/page.tsx`,
`manage/dashboard/page.tsx:169`, `manage/seasons/[seasonId]/page.tsx:89`,
`manage/people/page.tsx:62`, `manage/score/[gameId]/page.tsx`,
`src/lib/queries/teams.ts:66`, `src/lib/queries/players.ts:56`,
`src/lib/queries/games.ts`.

**`is_captain_of` (`supabase/migrations/0009_rls_roles.sql:16`) gets
`and tp.left_on is null`.** Without it a transferred captain keeps RLS **write
access to their former team** for the rest of the season. `transferPlayer`
clearing `is_captain` (section 5, step 3) closes the same hole from the
application side; both halves ship, per the codebase's standing pattern of an
app guard plus an independent RLS half.

**Deliberately left unfiltered:**

- `player_is_public` (`0008_rls_public.sql:29`) — a player who left a team is
  still a real person who appeared in a public league, and their page should
  still resolve.
- `src/lib/league/of-entity.ts` — it answers "which league does this row belong
  to", which a departure does not change.

**`src/lib/actions/audit.ts`** re-inserts `team_players` rows on revert and must
set `left_on` explicitly, or a reverted removal silently restores a player as
departed (or as active when they were not).

## 8 — Order

0. **Operator, not agent: empty the database.** While it is empty, close
   `LAUNCH_READINESS_HANDOFF.md` item 2 — the seeded accounts whose password is
   committed to this repo are a way in regardless of what is deployed, and an
   empty database is the cheapest moment to be rid of them. Item 1
   (`ENABLE_DEV_LOGIN`) and item 3 (`0033` not pushed) are unrelated to this work
   but block going live at all.
1. **A** — section 3, then section 4. Import both leagues, merge duplicates, edit
   rosters. Ships before the season starts.
2. **B** — section 5, then 6, then 7. Ships before the first game is played.
   Section 2's fix rides in section 6 and is not optional.

A is safe to ship without B **only because no games exist yet**. The moment a
game is final, merging two players who both dressed for it starts summing stat
rows, and the section 5 traps become reachable. If A ships and the season starts
before B lands, the merge tool must be taken down.

## 9 — Testing

- **Unit:** merge collision arithmetic (same-game rows sum; richer roster row
  wins; dual-roster becomes a departure); `transferPlayer` clears `is_captain`,
  `is_default_goalie` and the old `team_goalie_days` rows; the partial jersey
  index frees a departed number and still rejects a live collision.
- **Against a real database, not reasoned about:** a transferred goalie keeps the
  old team's GP, W/L, GAA and shutouts, and the restored explicit-goalie branch
  credits the picked goalie rather than the lowest `player_id`. Both of these are
  currently *readings* in this document; they become watched here or the design
  is unverified.
- **e2e:** roster-only import creates teams and players and no games; the
  transfer flow; the leaderboard shows one row for a transferred player while
  both team pages keep their share.
- Full verification is `npm test && npm run test:e2e`. ⚠️ Counts in
  `LAUNCH_READINESS_HANDOFF.md` move with every merge — re-measure, don't quote.

## 10 — Alternatives considered and rejected

**A `roster_stints` table replacing `team_players`' identity.** Temporally the
most correct, and the choice on a greenfield schema. Rejected: `team_players` is
the most-read table in the application (section 7 lists eight call sites, and
that is only the reads), and it carries four status columns added by `0019` and
`0023`. Replacing it means rewriting every RLS policy over it, the goalie-of-
record machinery in `0015`, and the audit revert path — to buy temporal
precision that `game_rosters.team_id` already makes unnecessary.

**A `player_transfers` log, with `team_players` holding only the current team.**
Looks tidiest and is the trap. The old roster row is still deleted, so both
failure modes in section 5 still fire, and the views would have to reconstruct
history from the log — strictly more logic, in the place it is hardest to verify.

**A boolean `is_active` instead of `left_on date`.** Sufficient for correctness,
since no attribution depends on dates. Rejected for costing nothing: a date
answers "when did this happen" for an operator reading a roster months later,
and orders multiple moves. `null` carries the same meaning a boolean would.

**Matching players by name at import time.** Rejected by the operator, and
correctly: two different people share a name, so an automatic match is wrong in
both directions — it splits one person in two, or merges two people into one, and
the second is much harder to undo once stats exist.

**Two leaderboard rows for a transferred player** (what the views do today, so
free). Rejected: neither row is the player's season, and a player who transfers
is pushed down the leaderboard for having done so.
