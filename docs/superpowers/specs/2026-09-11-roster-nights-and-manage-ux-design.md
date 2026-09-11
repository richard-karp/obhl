# Roster sections, player nights, and the manage UX pass

**Date:** 2026-09-11 · **Status:** spec, approved in chat, not built
**Predecessor for §6:** `docs/superpowers/specs/2026-09-08-ia-approach-c-schedule-subnav.md`
— approach C, which costed this exact route move and deferred it pending a
route-aware `revalidate-paths` guard. That guard landed (PR #52, on `main`), and
§6 here is approach C **minus the Build tab**: the user's decision is that
building a schedule belongs to season setup, not to a Schedule sub-tab.

## How claims here are marked

Every factual claim carries **[measured]** — a file opened, a command run, a
production query — or **[inferred]**. Nothing is unmarked.

⛔ **No code was changed to write this.** Production was read, never written.

---

## What the user asked for

Verbatim, five items:

1. Roster page in sections — Forwards, Defence, Goalies — sorted by points, then
   jersey number.
2. Replace the goalie schedule with a per-player **night** assignment, available
   when a league plays more than one night a week. For a goalie it makes them
   that night's default. Surface it on the roster page and on the player row.
3. The edit-player experience is wrong: "It doesn't really fit inside the
   container horizontally even in relatively wide viewports."
4. Schedule builder: default game times 7:00 / 8:20 / 9:40; manager-request
   fields clear on submit.
5. Build Schedule is part of creating a season; after a season starts the
   manager edits the schedule from the Schedule tab, with **all functionality
   available**. The manager row should not duplicate the main row's tabs.

Answers given in brainstorming, which this spec treats as settled:

- Nights are **the nights the season plays**, chosen explicitly when building the
  schedule.
- Goalie selection is **night assignment, or — if the team has one goalie — that
  goalie**. No team-wide default.
- The Goalies section shows **both** goaltending and G/A/PTS.
- Editing a player is **one dialog holding everything about that player**.
- The builder URLs **move under Schedule**.

---

## Production, measured

`npx supabase db query --linked`, 2026-09-11. This is the evidence the goalie
decision rests on.

| League | Season | Nights | Published games |
| --- | --- | --- | --- |
| `lcc-executive-hockey-league` | 2026 - 2027 (active) | **Tue** | 69 |
| `lcc-old-boys-hockey-league` | 2026-2027 (active) | **Mon, Thu** | 144 |

Goalies per team, active seasons, `left_on is null`:

| League | Teams with 1 goalie | Teams with 2 goalies | `is_default_goalie` set |
| --- | --- | --- | --- |
| Executive | 6 of 6 | 0 | 2 (green, grey) |
| Old Boys | 3 of 8 | **5 of 8** (Black, Green, Maroon, Red, Yellow) | 1 (White) |

✅ **All three `is_default_goalie` flags sit on teams with exactly one goalie.**
So the rule "one rostered goalie ⇒ that goalie" reproduces every one of them, and
dropping the column loses nothing in production. **[measured]**

`team_goalie_days` holds **6 rows**, all in Old Boys, all still rostered
**[measured]**:

| Team | Mon (1) | Thu (4) |
| --- | --- | --- |
| Black | Jonah Greenspoon | Louis Adler |
| Blue | Luka Kamnik | Luka Kamnik |
| Maroon | Bram Lesser | Wes Osterland |

Black and Maroon convert one-to-one. ⚠️ **Blue's Luka holds both days and is
Blue's only goalie** — under the new model he needs no night at all, and the
one-goalie rule covers him. That case is what fixes the conversion rule in §2.

### ⛔ Old Boys has already started. Executive has not.

**[measured]**, same session:

| League | First game | Games in the past | `season_is_started` |
| --- | --- | --- | --- |
| Old Boys | 2026-09-10 | **3** | **true** — builder is `locked` today |
| Executive | 2026-09-15 | 0 | false — builder still unlocked |

This is not background. It is the live case §6 is about: for Old Boys the
manager **already** cannot regenerate or replace, so `/schedule` is the only
surface that matters, and the missing "Move a game night" is a gap they can hit
today. It also means §6 can be QA'd against a real started season and a real
unstarted one without inventing fixtures.

⚠️ It also constrains the migration: it runs against a season that is under way.
It touches `seasons` and `team_players` only — never `games` — so it cannot trip
`season_is_started` or any of the `0026`/`0027`/`0045` guards. **[inferred]** from
those files' own conditions, which key on game rows.

### ⚠️ Both stats views are empty right now — 0 rows, 0 final games

**[measured]**: `v_goalie_stats` and `v_skater_stats` each return **0 rows**, and
`select count(*) from games where status='final' and not is_draft` is **0**,
against 213 published games. Controlled for a bad join by counting the views
directly, not by inferring from a left join returning nulls.

Consequences, both load-bearing for §3:

1. **Every rostered goalie in production — all 19 — is currently absent from
   `v_goalie_stats`.** So the zero-fill is not a nicety for an edge case; without
   it the Goalies section would be **empty on every team page in both leagues**
   on the day this ships.
2. A test that asserts "the Goalies section lists the team's goalies" passes
   against a seed with scored games and would still have caught nothing about
   production. The section must be asserted **with zero final games**, which is
   the state production is in.

---

## 1 · The season's nights

### The new column

```sql
alter table seasons
  add column game_nights smallint[] not null default '{}';
```

Values are `0=Sun … 6=Sat`, matching `team_goalie_days.day_of_week` (`0023`) and
`leagueWeekday()` **[measured]**.

### Who writes it

`generateSchedule` (`src/lib/actions/schedule.ts:394` reads the weekday
checkboxes into a `Set` **[measured]**) persists that set onto the season in the
same write that stores the draft. That is what "chosen explicitly when building
the schedule" means, and it costs the manager no new field: they already tick
these boxes.

### Read-time fallback

If `game_nights` is empty, `seasonNights()` returns the distinct weekdays of the
season's **published** games, in the league zone.

⚠️ Why the fallback exists: the esportsdesk importer never runs
`generateSchedule`, so an imported season would otherwise have no nights
forever. ⚠️ Its one wrinkle: a one-off Saturday final added by
`applyOneOffGame` would appear as a "night" for a season that has no stored
value. Acceptable — a season built here always has the stored value, which wins.

### Backfill

The migration seeds both live seasons from their published games' weekdays,
which is the same computation the fallback does, run once:

- Executive → `{2}`
- Old Boys → `{1,4}`

**[measured]** from the production query above.

### The gate

`game_nights.length >= 2` ⇒ night controls appear. One night, or none: nothing
appears anywhere — no column, no picker, no heading. Executive therefore sees no
change from item 2 at all; Old Boys is the league this is for.

---

## 2 · Player → night

### The new column

```sql
alter table team_players
  add column night_of_week smallint
    check (night_of_week between 0 and 6);
```

Nullable. Null means "no fixed night" — which is the truthful description of both
a player who plays every night and one nobody has assigned yet.

⛔ **No uniqueness constraint.** Two goalies may share a night. The old
`team_goalie_days` had `unique (team_id, season_id, day_of_week)` **[measured]**
and this deliberately does not reproduce it: a team that genuinely alternates two
goalies on one night must be representable, and refusing the save would be a
worse answer than an ambiguous default. §2's resolution order picks
deterministically when it happens.

### The conversion, in the migration

For each `team_goalie_days` row, set `team_players.night_of_week = day_of_week`
for the matching `(player_id, team_id, season_id)` row — **but only for a player
holding exactly one day row.** A player with several is left null.

Applied to production that yields **[inferred]** from the measured rows:

| Team | Player | Result |
| --- | --- | --- |
| Black | Jonah Greenspoon | `night_of_week = 1` |
| Black | Louis Adler | `night_of_week = 4` |
| Maroon | Bram Lesser | `night_of_week = 1` |
| Maroon | Wes Osterland | `night_of_week = 4` |
| Blue | Luka Kamnik | **null** — two rows; he is Blue's only goalie |

Then, in the same migration and after the conversion:

```sql
drop table team_goalie_days;
alter table team_players drop column is_default_goalie;
```

### Goalie resolution on the scoresheet

`src/app/[league]/(manage)/games/[gameId]/score/page.tsx:193-195` **[measured]**
currently computes `dayGoalie ?? defaultGoalie`. It becomes, in order:

1. the team's **only** rostered goalie, if it has exactly one;
2. otherwise the rostered goalie whose `night_of_week` equals the game's weekday
   (lowest jersey number first if two share it — see the no-uniqueness note);
3. otherwise **nobody** pre-selected.

⚠️ Rule 1 outranks rule 2 deliberately. A one-goalie team whose goalie is
assigned to Monday still gets them suggested for a Thursday game, which is what
"if there is only one goalie then they are the goalie" means.

⛔ This changes only the *suggestion*. `setGoalie` and the rest of the goalie
write path are untouched — and must stay untouched, per
`roster-editor.tsx:41-45`'s note about `0036` and `v_goalie_stats`.

### Code that must change when the columns go

**[measured]** — every site, from `grep -rn "team_goalie_days\|is_default_goalie" src/`:

| File | What |
| --- | --- |
| `src/lib/actions/rosters.ts:334, 460-486, 740-790, 919-960` | `setDefaultGoalie` and `setGoalieDay` are **deleted**; the departure and position-change paths stop clearing goalie machinery that no longer exists, and instead clear `night_of_week` on departure |
| `src/lib/actions/players.ts:406-441` | the merge's `team_goalie_days` unique-collision handling is **deleted** |
| `src/lib/actions/audit.ts:116, 173` | two restore payloads drop `is_default_goalie` and carry `night_of_week`; `od.is_default_goalie` in pre-migration snapshots is simply ignored |
| `src/app/[league]/(manage)/games/[gameId]/score/page.tsx:106, 118-122, 193-195` | the second query disappears; resolution per the order above |
| `src/components/manage/roster-editor.tsx:80, 90, 333-357, 402-467` | the Goalie Schedule card and Set Default button are deleted |
| `src/lib/db/types.ts` | regenerated |

⚠️ `rosters.ts:919-931` currently clears goalie state when a player moves **off**
goal. The equivalent question for the new column is whether moving F→D should
clear `night_of_week`: **no.** A night is a claim about when the person plays,
not about what they play. Only a departure clears it.

---

## 3 · The roster page

### Public team page — `(public)/teams/[slug]/page.tsx`

Today: one `TeamPlayerTable` of every rostered player sorted `pts desc, jersey
asc` (line 128 **[measured]**), then a separate "Goaltending" heading with
`GoalieStatsTable`.

After — three sections, in this order:

| Section | Columns |
| --- | --- |
| **Forwards** | `# · Player · Night · GP · G · A · PTS · P·G · PIM` |
| **Defence** | same |
| **Goalies** | `# · Goalie · Night · GP · W · L · T · GA · SO · GAA · G · A · PTS` |

- Sort inside every section: **PTS desc, then jersey asc** — the rule the page
  already uses, applied per section.
- The `Pos` column is dropped; the section heading says it.
- The `Night` column appears only when `game_nights.length >= 2`.
- The standalone "Goaltending" block is removed — its content is the Goalies
  section.

⚠️ **Goalies with no games must still appear.** `detail.goalies` comes from
`v_goalie_stats`, whose `goalie_appearances` CTE is built only from games with
`status = 'final'` (`0044_team_logo_in_stats_views.sql:101-132` **[measured]**),
so a rostered goalie who has not yet played a FINAL game is absent from it. The Goalies
section is built from the **roster** and left-joined to the goalie stats,
zero-filled. **[inferred]** — this is the same shape the page already uses for
skaters at lines 97-126.

⚠️ **Width.** Thirteen columns will not fit 390px. `W · L · T · SO · G · A` are
`hidden sm:table-cell`, and the section sits in the `overflow-x-auto` container
the repo already uses. The 390px guard in `e2e/02-auth.spec.ts:315` visits only
`/obhl/standings` and `/obhl/seasons` **[measured]** — a team page is added to
that loop, because this change puts the widest table in the app on a page nothing
measures.

✅ **`GoalieStatsTable` is not modified.** `/stats` still uses it
(`(public)/stats/page.tsx` **[measured]**). The Goalies section is a new
team-scoped component.

### Manage roster editor — `roster-editor.tsx`

Same three sections, same order. Each row becomes:

```
#  ·  Player + badges  ·  Position  ·  Night  ·  [Edit]  [Remove]
```

Everything else moves into the dialog (§4).

⚠️ `(public)/teams/[slug]/page.tsx:182-186`'s note that the roster appears twice
on purpose — season scoring above, "who is on the team and what can be done to
them" below — stays true and stays worth keeping.

### Spelling

The codebase says both: `"Defense"` at `team-player-table.tsx:13`,
`roster-editor.tsx:30` and `players/[playerId]/page.tsx:30`; `"Defence"` at
`duplicate-clusters.tsx:51` **[measured]**. Standardise on **Defence**, in one
shared constant. `e2e/04-rosters.spec.ts:133` maps `Defense: "D"` and changes
with it.

---

## 4 · The edit-player dialog

### Why the current one cannot be fixed in place

`EditPlayerForm` opens **inside the last table cell** — the cell already holds a
flex row of Rookie / Suspend / Injury+Set / Set Default / Make C / Edit /
Transfer / Remove (`roster-editor.tsx:216-380` **[measured]**). Its
`basis-full` gets the remainder of one cell of an eight-control row. The width
complaint is that structure, not the panel's styling.

### The shape

A `components/ui/dialog` (already in the repo, used by `remove-controls.tsx` and
`publish-controls.tsx` **[measured]**), titled with the player's name:

```
Number [12]   Position [Forward v]   Night [Tuesday v]      → one Save
─────────────────────────────────────────────────────────
[x] Captain   [ ] Rookie   [ ] Suspended                   → existing actions
Injury note [____________________]
─────────────────────────────────────────────────────────
Transfer to [Pick a team v]   [Transfer]                   → existing action
─────────────────────────────────────────────────────────
First [Marc] Last [Tremblay]
Renames them in every league they play in.   [Rename everywhere]
```

⛔ **NO NEW WRITE PATH.** Every control submits to an existing action in
`src/lib/actions/rosters.ts`. `roster-editor.tsx:41-45` is explicit about why —
`0036` exists because a second, naive transfer destroyed goalie records through
`v_goalie_stats`' inner join and reported no error. The dialog is a container.

⛔ **The rename keeps its own button and its own warning copy.**
`edit-player-form.tsx:15-24` **[measured]**: jersey and position are this team's;
the name is on `players`, which has no league. Folding the three into one Save
would hide a cross-league write inside a routine one. The separator and the
sentence stay.

⚠️ `night_of_week` saves alongside number and position — one `team_players`
UPDATE, so `updateRosterPlayer` gains a field rather than gaining a sibling.

---

## 5 · Schedule builder — two fixes

### Default ice times

7:00 / 8:20 / 9:40 pm ⇒ `"19:00, 20:20, 21:40"`, in **both** places
**[measured]**:

- `src/components/manage/schedule-generate-form.tsx:750` — the input's
  `defaultValue`
- `src/lib/actions/schedule.ts:410` — the action's fallback when the field is
  absent

⚠️ Both, or they disagree. `schedule-generate-form.tsx:612`'s docblock also
recites the old triple and goes stale with them.

⛔ **Do not touch the test fixtures.** `assignNights.test.ts` and
`balance.test.ts` use `["19:00","20:15","21:30"]` as arbitrary slot times
**[measured]**; they are not assertions about the default and rewriting them
would be churn. The one thing that must be checked is that no test asserts the
*form's* default.

### Clearing the manager-request fields

After `saveScheduleConstraint` returns `ok`, clear `constraint_team_id`,
`constraint_date`, `constraint_week_of`, `constraint_time`, `constraint_from`,
`constraint_to` — and leave `constraint_kind` alone, since a manager adding three
byes in a row wants the kind to stick.

⛔ **CLEAR THE NAMED FIELDS, NEVER `form.reset()`.** The generate form and the
constraints card are **one HTML form** — `ConstraintsCard`'s docblock
(`schedule-generate-form.tsx:107-146` **[measured]**) records that React 19's
form-reset on a submit that reaches a form action "wiped the first game night,
the games per team, the ice times and every weekday checkbox the manager had just
typed. Measured 2026-09-06 on Fall 2026." A `reset()` reintroduces that bug by
hand. Clear each input by name, from the `useEffect` that already watches
`addState`.

⚠️ `e2e/28-schedule-form-state.spec.ts:332` asserts "adding a manager request
keeps the fields already filled in" **[measured]** — it must stay green. It is
the regression test for exactly the bug the wrong fix would reintroduce.

---

## 6 · Navigation and routes

Approach C from the predecessor spec, **without the Build tab**, and therefore
without its tab strip.

### The staff row

`src/components/shared/staff-links.tsx:21-42` **[measured]**. The manager's list
loses four entries:

| Entry | Why it goes |
| --- | --- |
| `Schedule` | same URL as the public row's Schedule |
| `Teams` | same URL as the public row's Teams |
| `Rules` | same URL as the public row's Rules |
| `Build Schedule` | the builder is part of season setup now |

Leaving **Dashboard · People & Roles · Seasons · Announcements · Audit Log**,
plus the absolute New league and League Office links.

✅ This resolves, rather than restates, the "⚠️ THE DUPLICATION IS KNOWN AND
ACCEPTED" block at `staff-links.tsx:116-141` **[measured]** — including the
`aria-current="page"` doubling it describes on `/<league>/schedule`. That
docblock is rewritten to record that the duplication was removed on 2026-09-11
and why, not deleted.

⚠️ `staff-links.tsx:27-33` carries a `⛔ ORDER AND LABELS CHANGED 2026-09-07`
comment about `/schedule` coming before `/schedule-builder`. Both entries are
gone; the comment goes with them, and its reasoning — "in-season editing
shouldn't be hidden in the Schedule Builder tab" — is now carried by §6's own
note, since it is the same decision taken further.

⚠️ The scorekeeper's `LINKS` entry is `[]` **[measured]**; the predecessor spec's
warning about a scorekeeper `"Score Games"` entry is **stale** and does not apply.

### Route moves

| From | To | Lines |
| --- | --- | --- |
| `(manage)/schedule-builder/repair/page.tsx` | `(manage)/schedule/repair/page.tsx` | 110 |
| `(manage)/schedule-builder/one-off/page.tsx` | `(manage)/schedule/one-off/page.tsx` | 101 |
| `(manage)/schedule-builder/page.tsx` | **becomes a redirect** — see below | 72 |

✅ **A `(public)` page can parent `(manage)` children.** The repo ships it:
`(public)/games/[gameId]/page.tsx` and `(manage)/games/[gameId]/score/page.tsx`
**[measured]**, both exercised by `e2e/15-league-routing.spec.ts:87` and `:537`.
`(public)/schedule/page.tsx` alongside `(manage)/schedule/{repair,one-off}` is
the same shape one segment deeper.

✅ **No guard moves.** Both pages call `requireLeagueManager` directly
(`repair/page.tsx:40`, `one-off/page.tsx:35` **[measured]**) and stay inside
`(manage)`, keeping its `if (!user) redirect("/login")`. ⚠️ Do not "tidy up" a
per-page guard that looks redundant against the layout.

✅ **No tab strip is built.** This is where the design departs from approach C,
and it removes that spec's three named risks at once: no third `navigation`
landmark, no Radix-Tabs-over-routes trap (`team-tabs.tsx`, reverted at `9731234`
**[measured]**), and no new row of links to overflow at 390px. The two tools stay
reachable exactly as they are today — from the "Bigger changes:" sentence at
`(public)/schedule/page.tsx:264-276` **[measured]**.

### The bare builder URL

`(manage)/schedule-builder/page.tsx` is replaced by a ~15-line page that resolves
`getManageContext` and `redirect()`s to `/<league>/seasons/<season.id>`, or to
`/<league>/seasons` when the league has no season.

⚠️ **Deliberately a page, not a `next.config.ts` entry.** A config redirect
cannot look up which season to land on, and `/seasons?season=<id>` means nothing
to the seasons index. Keeping the route directory also keeps the
`revalidate-paths` walk satisfied for anything that still names it — though after
this change nothing should.

### `next.config.ts`

Two entries, `permanent: true`:

| From | To |
| --- | --- |
| `/:league/schedule-builder/repair` | `/:league/schedule/repair` |
| `/:league/schedule-builder/one-off` | `/:league/schedule/one-off` |

⛔ **Two explicit rules, not one wildcard.** `/:league/schedule-builder/:rest*`
is zero-or-more and would swallow the bare `/schedule-builder`, sending it to
`/schedule` instead of to the redirect page. The same hazard is already
documented at `next.config.ts:21-25` for the `/manage/` rule **[measured]**.

✅ No ordering hazard: all seven existing sources are anchored at both ends and
none begins `/:league/schedule-builder` **[measured]**.

### `revalidatePath` — 15 strings, two files

**[measured]** — `grep -rn 'revalidatePath("/\[league\]/schedule-builder' src/`
returns **15** today (the predecessor spec counted 14; it has grown):

| Kind | Sites | Change |
| --- | --- | --- |
| bare `/[league]/schedule-builder` | `schedule-edits.ts:177`; `schedule.ts:243, 297, 724, 732, 783, 1206, 1330, 1487, 1794, 2122` (11) | **delete** |
| `/[league]/schedule-builder/repair` | `schedule.ts:1490, 2123` | → `/[league]/schedule/repair` |
| `/[league]/schedule-builder/one-off` | `schedule.ts:1491, 1795` | → `/[league]/schedule/one-off` |

✅ **The 11 deletions are safe, and this is the measured reason:** every one of
them is immediately followed by `revalidatePath("/[league]/seasons/[seasonId]",
"page")` on the next line **[measured]** — `schedule-edits.ts:178`;
`schedule.ts:244, 298, 725, 733, 784, 1207, 1331, 1492, 1796, 2124`. Season setup
is the builder's only remaining home, and it is already being revalidated.

✅ **A miss is now caught.** `src/lib/actions/revalidate-paths.test.ts:69`
walks `src/app` and resolves every pattern against the real route tree
**[measured]** — the guard the predecessor spec set as its condition for
approving this move. A stale `"/[league]/schedule-builder/repair"` fails the unit
suite by name.

⚠️ Incidental, found while measuring: `schedule.ts:1797` and `:1798` are the
identical `revalidatePath("/[league]/schedule", "page")` twice **[measured]**.
Harmless. Out of scope; noted so the next reader does not think this change
introduced it.

### Hrefs — 8, in four files

**[measured]**, carried forward from the predecessor spec and re-checked:

| File | Current href | Becomes |
| --- | --- | --- |
| `schedule-builder-panel.tsx:434, 509` | `/${league}/schedule-builder/one-off` | `/${league}/schedule/one-off` |
| `schedule-builder-panel.tsx:453, 607` | `/${league}/schedule-builder/repair` | `/${league}/schedule/repair` |
| `(public)/schedule/page.tsx:266` | `/${slug}/schedule-builder/repair` | `/${slug}/schedule/repair` |
| `(public)/schedule/page.tsx:273` | `/${slug}/schedule-builder/one-off` | `/${slug}/schedule/one-off` |
| `repair/page.tsx:78` | `/${leagueSlug}/schedule-builder` | `/${leagueSlug}/schedule` |
| `one-off/page.tsx:74` | `/${leagueSlug}/schedule-builder` | `/${leagueSlug}/schedule` |

⚠️ The last two are `PageHeader` back-buttons labelled "Schedule Builder". They
are **repointed and relabelled to "Schedule"**, not deleted — with no tab strip,
they are the only way back, and `/schedule` is where the manager came from.

### §5's missing functionality — "make sure all functionality is available"

**[measured]** comparison of what a manager can do on each surface for a
**started** season:

| Control | `/schedule` today | Builder (locked mode) today |
| --- | --- | --- |
| Per-game edit panel | ✅ `page.tsx:251` | ✅ `panel.tsx:1044` (drafts only) |
| Restore a cancelled game | ✅ `page.tsx:163` | ✗ |
| Repair link | ✅ `page.tsx:266` | ✅ `panel.tsx:453` |
| One-off link | ✅ `page.tsx:273` | ✅ `panel.tsx:434` |
| **Move a game night** | ✗ | ✅ `panel.tsx:581-586` |

**One gap.** `RescheduleNightForm` is added to `/schedule` for
`canManageLeague`, gated on the season having published games, fed by
`getSeasonNights` — the same props the panel passes at `panel.tsx:581-586`
**[measured]**, including the server-computed `minDate` in the league zone.

✅ **No new revalidation needed.** `rescheduleNight` already revalidates
`/[league]/schedule` at `schedule.ts:1493` **[measured]**.

⛔ **`canManageLeague`, NOT `canScore`.** `(public)/schedule/page.tsx:167-172`
**[measured]** already carries this note for the edit panel: `canScore` admits
scorekeepers, who cannot reach these tools, and drawing a control whose only
outcome is a refusal "reads as a broken page rather than as a boundary." The
night form inherits it.

⚠️ The builder keeps its copy of the form. It is not removed from season setup —
a pre-season manager moving a draft night should not be sent to `/schedule`.

### Docs

`LAUNCH.md:248` names `/<league>/schedule-builder` in the launch runbook
**[measured]** and is repointed at season setup.

---

## The e2e scope

**[measured]** — `grep -rn "schedule-builder" e2e/*.ts`, by file:

| Spec | Refs | Nature |
| --- | --- | --- |
| `11-schedule-builder.spec.ts` | 4 | `goto("/obhl/schedule-builder")` ×3 + a heading |
| `14-one-off-game.spec.ts` | 4 | 1 builder goto, 2 one-off gotos, 1 comment |
| `15-league-routing.spec.ts` | 3 | the `moved` redirect array |
| `16-league-membership.spec.ts` | 2 | `MANAGE_PATHS` entries |
| `23-schedule-constraints.spec.ts` | 2 | goto + comment |
| `28-schedule-form-state.spec.ts` | 2 | goto + comment |
| `29-schedule-repair.spec.ts` | 8 | 4 builder gotos, 2 repair gotos, 1 URL regex, 1 comment block |
| `30-schedule-edits.spec.ts` | 9 | builder gotos |
| `31-stale-draft.spec.ts` | 1 | goto |

⚠️ **A builder `goto` does not become `/schedule/build` — there is no such
page.** It becomes `/obhl/seasons/<id>`, which those specs must resolve. That is
the one place this change is *more* work than approach C, which had a Build tab
to point at. Several specs already know a season id; the ones that do not get a
helper.

⚠️ **`16-league-membership.spec.ts:157-158` is not a substitution.** Those two
entries live in `MANAGE_PATHS` — paths that must bounce a manager of another
league — beside a comment (lines 159-161 **[measured]**) explaining that
`/schedule` is deliberately **absent** because it is public. After the move the
list holds `/schedule/one-off` and `/schedule/repair` while their parent
`/schedule` is still correctly absent, which reads as an oversight unless that
comment is rewritten. `/schedule/repair` is absent today and is added while the
file is open.

⚠️ **Three new rows** in `15-league-routing.spec.ts`'s `moved` array — the two
new redirects and the bare builder's page redirect. That spec's own docblock
(line 664 **[measured]**) says "nothing else in the suite would notice if it
were deleted", so an unasserted redirect is an untested one.

⚠️ **`13-goalie.spec.ts` is largely replaced.** Lines 119-161 **[measured]**
assert the Goalie Schedule card exists and survives; the card is deleted. The
spec is rewritten around the new resolution order, and must cover the
**one-goalie** branch and the **two-goalie, night-assigned** branch — the two
shapes production actually has.

⚠️ **`22-roster-editing.spec.ts` and `04-rosters.spec.ts`** drive the roster row's
inline controls and the flat table. Both change with §3 and §4.

⛔ **The re-verification cost dominates the edit cost.** `29-schedule-repair`
calls `test.slow()` four times; `11-schedule-builder:141` sets
`AFTER_GENERATE = { timeout: 45_000 }` because "the search alone can reach ~25s"
**[measured]**. e2e runs only via `scripts/e2e-locked.sh` with a distinct `PORT`
— worktrees share one Supabase — so these cannot be parallelised.

---

## Risks and one-way doors

### ⛔ The migration is the one-way door

`drop table team_goalie_days` and `drop column is_default_goalie` destroy data.
The conversion must run **in the same migration, before the drops**, and must be
verified against production's 6 rows and 3 flags before it ships. The measured
expectation is in §2's table: four nights set, Blue's Luka left null, three
`is_default_goalie` flags discarded as redundant.

⚠️ Per `AGENTS.md` and `[[production-reads-via-cli]]`: reads pass the auto-mode
classifier, writes are blocked. The production migration is applied by the user,
and this spec's job is to hand them a verification query whose expected output is
written down in advance.

### ⚠️ The green-suite trap, in its third costume

`AGENTS.md` records two features that passed full suites while doing nothing in
production: one rewrote `nightIndex` while only `scheduledAt` was persisted; one
ran a 10× shorter search in CI than in production. **The question to ask of this
change:** does a test that says "the Tuesday goalie is suggested" read
`night_of_week` from the same column the dialog writes, through the same
resolution the score page runs? A fixture that sets the column directly and a
page that reads a different one would both be green.

### ⚠️ Width, on the page nothing measures

The Goalies section is the widest table in the app and lands on a page the 390px
guard does not visit **[measured]**. Mitigation in §3; the guard's loop grows.

### ✅ Not one-way doors

The route move is reversible (move two directories back, delete two redirect
entries). The staff-row edit is a list. §5 is two literals and an effect.

### ✅ Untouched, and a diff here means something went wrong

`applyGameWrites`, `publishSchedule`, the `0045`/`0046` RPCs, the generator
(`assignNights.ts` and its phases), `GoalieStatsTable`, and
`e2e/27-one-chrome.spec.ts`.

---

## Explicitly out of scope

- **Deduplicating `ScheduleBuilderPanel`** between season setup and anywhere
  else. It renders at one URL after this change, which is a happy side effect,
  not the goal.
- **A Schedule sub-nav / tab strip.** Approach C's fourth tab is what the user
  moved to season setup; without Build there are two linked tools and a sentence
  that already links them.
- **`schedule.ts:1797-1798`'s duplicate revalidation.** Noted, not fixed.
- **The esportsdesk full importer.** `AGENTS.md` is explicit that it is not
  outstanding work. It gains a `game_nights` fallback for free and nothing else.
- **Any change to who may do what.** No guard, no RLS policy, no
  `profile_leagues` change. `ACCESS_CONTROL_HANDOFF.md` is not in play.

---

## Implementation order

Five pieces, two of them independent of everything else. **[inferred]** from the
dependency between the column and its consumers.

| # | Piece | Depends on |
| --- | --- | --- |
| 1 | §5 — default ice times, clearing the request fields | nothing |
| 2 | §6 — staff row, route moves, redirects, Move-a-game-night | nothing |
| 3 | §1 + §2 — migration, `game_nights`, `night_of_week`, scoresheet resolution | nothing |
| 4 | §3 — roster sections and the Night column | 3 |
| 5 | §4 — the edit dialog | 3 |

1 and 2 can ship before the migration exists, and 1 is small enough to be the
warm-up. ⛔ **3 is the one with the one-way door** and should not share a commit
with anything else — the migration wants to be revertible on its own.

⚠️ Per `[[concurrent-branches-in-one-tree]]` the user runs other sessions in this
tree; re-check the branch before every git write. Per
`[[worktrees-share-one-database]]` e2e runs serialised through
`scripts/e2e-locked.sh`.

---

## Success criteria

1. On Old Boys (Mon + Thu), a manager can assign any player to a night from the
   edit dialog, and the night shows on the roster row and on the public team
   page. On Executive (Tue only), no night control appears anywhere.
2. A two-goalie team's scoresheet pre-selects the goalie assigned to that game's
   weekday; a one-goalie team's pre-selects that goalie on every night; a
   two-goalie team with no assignments pre-selects nobody.
3. The team page shows Forwards, Defence and Goalies, each sorted PTS desc then
   jersey asc, with goaltending **and** G/A/PTS in the Goalies section, and a
   rostered goalie who has not yet played still listed.
4. Editing a player happens in one dialog that fits at 390px and at 1440px.
5. The generate form offers `19:00, 20:20, 21:40`; adding a manager request
   clears its own fields and leaves every generate field untouched
   (`28-schedule-form-state.spec.ts:332` still green).
6. The staff row shows Dashboard, People & Roles, Seasons, Announcements, Audit
   Log — and no entry whose URL the public row already names.
7. Both old builder sub-URLs 308 to `/schedule/{repair,one-off}` with query
   strings preserved, asserted in `15-league-routing.spec.ts`'s `moved` array;
   `/schedule-builder` lands on season setup.
8. `/schedule` carries the per-game edit panel, cancelled-game restore, **Move a
   game night**, and links to repair and one-off.
9. `grep -rn "schedule-builder" src/` returns no `href` and no `revalidatePath`
   string — only the redirect page's own directory.
10. `npm run typecheck`, `npx vitest run`, `npx eslint src e2e` clean; the
    affected e2e specs green via `scripts/e2e-locked.sh` — and per
    `[[one-green-run-proves-nothing]]`, the schedule specs run more than once.
11. No diff in `applyGameWrites`, `publishSchedule`, the `0045`/`0046` RPCs, or
    `e2e/27-one-chrome.spec.ts`.
