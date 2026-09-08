# IA approach C — one Schedule section with sub-nav

**Date:** 2026-09-08 · **Status:** spec, not approved, not built
**Predecessor:** `docs/superpowers/specs/2026-09-07-manual-schedule-edits-design.md`,
which chose approach B and recorded C as "the likely eventual shape".
**Written because:** the 2026-09-10 schedule rebuild that deferred C is past, so
the reason for deferring is gone and only the cost remains. This spec makes that
cost concrete and decidable.

## How claims here are marked

Every factual claim carries **[measured]** — a file this session opened, a
command it ran, a git object it read — or **[inferred]** — a reading of how the
code would behave, not a run. Nothing is unmarked. Where a measurement
contradicts the predecessor spec, it says so.

⛔ **No code was changed to write this.** No route moved, `next.config.ts` was
not edited, no e2e assertion was rewritten. That is the next cycle's work, if
there is one.

---

## The proposal, as inherited

> - **C — one "Schedule" section with sub-nav.** Tabs over Games / Repair /
>   One-off / Build. Cleanest conceptually, and the likely eventual shape — but it
>   is a route restructure with three redirects and `27-one-chrome`'s assertions
>   to rewrite, proposed three days before a one-way-door deadline. Deferred, not
>   dismissed.

Two of that paragraph's three cost claims are checkable. One holds. One does
not. The third — the deadline — has expired. See **What the predecessor got
wrong** below.

## What changes for the user

Today a manager working on a schedule uses two top-level staff-row entries and
two unrelated URL stems. **[measured]** — `staff-links.tsx:33-34`:

```
{ path: "/schedule",         label: "Schedule" },
{ path: "/schedule-builder", label: "Build Schedule" },
```

⚠️ Note the labels. The predecessor spec calls `/schedule` **"Games" in
`staff-links.tsx`** (line 165). It is not; it is labelled "Schedule", and
`staff-links.tsx:116-120`'s own docblock still says "Games" too. **[measured]**
Both are stale against the file's `LINKS` array. The tab labels below therefore
use the words on screen today, not the predecessor's.

### After

One staff-row entry, "Schedule", and four tabs beneath the page heading:

| Tab | URL | Who reaches it |
| --- | --- | --- |
| **Games** | `/<league>/schedule` | public; managers additionally get the edit panel |
| **Repair** | `/<league>/schedule/repair` | league manager |
| **One-off** | `/<league>/schedule/one-off` | league manager |
| **Build** | `/<league>/schedule/build` | league manager |

Nothing a manager cannot do today becomes possible. **[inferred]** Every page
keeps its own content, its own guard and its own server work; only the URL
parent and a strip of links are new. This is a naming and wayfinding change, not
a capability change — which is the single most important input to the
recommendation at the end.

⛔ **The Games tab keeps the bare `/schedule`; it does NOT become
`/schedule/games`.** That alternative costs a fourth redirect and breaks eight
things that are correct today: `next.config.ts:71-75` (`/:league/score` →
`/:league/schedule`), `nav-links.tsx:11`, seven `revalidatePath("/[league]/schedule")`
call sites, and `src/lib/games/shared.ts:16`'s `PUBLIC_PATHS` entry.
**[measured]** — all read this session. Leaving Games at the bare path costs
nothing and keeps every one of them true.

---

## The route tree today

**[measured]** — `find src/app -type f`, this session.

```
src/app/[league]/
├── layout.tsx                      SiteHeader + StaffLinks, for everything below
├── (public)/
│   ├── layout.tsx                  requireVisibleLeague + SiteFooter
│   └── schedule/page.tsx           → /<league>/schedule            (270 lines)
├── (manage)/
│   ├── layout.tsx                  if (!user) redirect("/login")
│   └── schedule-builder/
│       ├── page.tsx                → /<league>/schedule-builder            (72)
│       ├── repair/page.tsx         → /<league>/schedule-builder/repair    (110)
│       └── one-off/page.tsx        → /<league>/schedule-builder/one-off   (101)
└── rosters/[teamId]/page.tsx       in NEITHER group, deliberately
```

⛔ **THE FOUR PAGES ARE NOT SIBLINGS, AND THE PREDECESSOR SPEC NEVER SAYS SO.**
`/schedule` is a **public** page under `(public)`; the other three are **manage**
pages under `(manage)`. **[measured]** They are three of the four tabs of a
"Schedule" section that would straddle the app's only guard boundary. That is
the structural fact approach C turns on, and it was not in the inherited
paragraph at all.

Concretely, the two groups differ in three ways that a tab switch would expose
**[measured]**, all read this session:

| | `(public)/layout.tsx` | `(manage)/layout.tsx` |
| --- | --- | --- |
| Gate | `requireVisibleLeague(league)` (line 42) | `if (!user) redirect("/login")` (line 28) |
| `<main>` | `px-4 py-6 sm:py-8` (line 46) | `px-4 py-8` (line 38) |
| Footer | `<SiteFooter>` (line 49) | none |

### ✅ One URL segment CAN span both route groups — this repo already ships it

The obvious first objection to approach C is that `/schedule` cannot be a
`(public)` page and simultaneously the parent of three `(manage)` pages. It can,
and the pattern is live in production today. **[measured]**:

- `src/app/[league]/(public)/games/[gameId]/page.tsx` → `/<league>/games/<id>`
- `src/app/[league]/(manage)/games/[gameId]/score/page.tsx` → `/<league>/games/<id>/score`

Both are exercised by the suite: `e2e/15-league-routing.spec.ts:87` drives
`/harbor/games/<id>`, and `:526` drives `/harbor/games/<id>/score`.
**[measured]** — lines read verbatim.

So `(public)/schedule/page.tsx` alongside `(manage)/schedule/{build,repair,one-off}/page.tsx`
is the same shape one segment deeper, and it needs no new Next.js behaviour.
**[inferred]** from that precedent — route groups are stripped from the URL, and
the four resulting paths are distinct, so nothing collides.

⚠️ **What that costs, and it is a real cost.** A layout cannot span the two
groups. `(manage)/schedule/layout.tsx` would wrap three tabs; the Games tab
sits in the other group and would not inherit it. **[inferred]** So the tab
strip is a **component each of the four pages renders**, not a layout — and the
Games tab renders inside a footer'd `main` with different vertical padding while
the other three do not. The same seam exists today between `/games/<id>` and
`/games/<id>/score` and nobody has complained, but nothing asserts it either:
**no e2e in the suite mentions the footer or the `contentinfo` role**
**[measured]** — `grep -rn "footer\|contentinfo" e2e/*.ts` returns nothing.

---

## What the predecessor got wrong

### ⛔ `27-one-chrome` has no assertions to rewrite. Zero.

The inherited paragraph names `27-one-chrome`'s assertions as one of the two
headline costs. **[measured]** — `e2e/27-one-chrome.spec.ts` is 116 lines and
contains the string `schedule-builder` **zero times**. Every URL it visits:

```
/  /obhl  /obhl/standings  /obhl/dashboard  /obhl/seasons  /obhl/schedule  /harbor
```

`/obhl/schedule` (line 75) is the only schedule URL, and under approach C it does
not move. The spec's named links are `"Seasons"` (line 49), `"Manage"`,
`"View site"` and `"Sign out"` — none of which approach C touches.

And this is not a recent state. **[measured]** — the file has exactly two commits
(`8455541`, `c4bca1d`), and `git show <sha>:e2e/27-one-chrome.spec.ts | grep -c
schedule-builder` returns `0` for both. **No version of that file has ever
referenced the builder URLs.** The cost claim was wrong when it was written, not
merely stale.

### ⛔ The cost the predecessor did NOT name is the one that can fail silently

There are **14** `revalidatePath` calls naming a builder route. **[measured]** —
`grep -rn 'revalidatePath("/\[league\]/schedule-builder' src/ | wc -l` → 14:

| File | Lines |
| --- | --- |
| `src/lib/actions/schedule.ts` | 236, 290, 646, 654, 694, 907, 1064, **1067**, **1068**, 1371, **1372**, 1699, **1700** |
| `src/lib/actions/schedule-edits.ts` | **177** |

(Bold = the sub-routes `/repair` and `/one-off`; the rest are the bare builder.)

⛔ **A path that matches no route revalidates nothing, silently.** That is stated
in the repo's own words — `src/lib/actions/revalidate-paths.test.ts:8-11`
**[measured]**:

> "This catches the one that gets missed in a sweep — a stale `/seasons` would
> fail silently, since a path that matches no route simply revalidates nothing."

⛔ **And that guard would NOT catch a missed rename here.** **[measured]** — I
read all five of its assertions (lines 62-99). They check: ≥40 calls found; every
path starts with `/[league]` or is allowlisted; no path under the removed
`/manage/` prefix; a `type` argument wherever the path has a dynamic segment; no
`${` interpolation. A leftover `"/[league]/schedule-builder"` **satisfies every
one of them**. The file was written to catch exactly this failure mode after the
`/manage/` flatten, in a shape that does not generalise to the next rename.

So the true risk profile of approach C is the inverse of the inherited one: the
named cost is zero, and the unnamed cost is 14 strings whose failure is invisible
to the type checker, to eslint, to the unit suite, and to a manual click-through
that happens not to be looking at a stale page.

### ⚠️ An earlier spec's "keep separate" verdict does NOT rule this out

`docs/superpowers/specs/2026-09-05-unified-url-space-design.md:101` **[measured]**:

> | `/schedule` 131 | `/manage/schedule-builder` 72 | **0.55×** | a calendar vs a generator — keep separate |

That verdict is about **merging** — folding the generator's content into the
calendar page — and the paragraph beneath it (lines 103-106) says so: "Merging a
view with a tool because they concern the same rows is how a 400-line page with
two unrelated modes gets built."

Approach C is not that. It is the verdict one row above **[measured]**, line 100:

> | `/games/[gameId]` 45 | `/manage/score/[gameId]` 290 | 6.4× | a summary vs a scoresheet — **nest, don't merge** |

Approach C nests. The four pages keep their four bodies. ✅ **So approach C is
consistent with the repo's own precedent rather than in tension with it** — worth
recording, because the 0.55× row reads at a glance like a prior rejection of this
exact change and is not.

---

## The full inventory of code that moves

All line numbers **[measured]** — each line was printed verbatim this session.

### Route files — three directory moves

| From | To | Lines |
| --- | --- | --- |
| `src/app/[league]/(manage)/schedule-builder/page.tsx` | `.../(manage)/schedule/build/page.tsx` | 72 |
| `src/app/[league]/(manage)/schedule-builder/repair/page.tsx` | `.../(manage)/schedule/repair/page.tsx` | 110 |
| `src/app/[league]/(manage)/schedule-builder/one-off/page.tsx` | `.../(manage)/schedule/one-off/page.tsx` | 101 |

✅ **No guard moves with them.** All three call `requireLeagueManager` directly —
`schedule-builder/page.tsx:27`, `repair/page.tsx:40`, `one-off/page.tsx:35`
**[measured]** — and they stay inside `(manage)`, so the layout's
`if (!user) redirect("/login")` is unchanged too. This is the property
`2026-09-05-unified-url-space-design.md:118-120` names: "The protection travels
with the page, so moving pages between route groups cannot drop a guard."

⚠️ Its paired trap (lines 122-124) applies verbatim: **do not "tidy up" a
per-page guard that looks redundant against the new layout.**

### Link hrefs — eight, in four files

| File:line | Current href |
| --- | --- |
| `src/components/manage/schedule-builder-panel.tsx:394` | `/${league}/schedule-builder/one-off` |
| `src/components/manage/schedule-builder-panel.tsx:413` | `/${league}/schedule-builder/repair` |
| `src/components/manage/schedule-builder-panel.tsx:469` | `/${league}/schedule-builder/one-off` |
| `src/components/manage/schedule-builder-panel.tsx:567` | `/${league}/schedule-builder/repair` |
| `src/app/[league]/(public)/schedule/page.tsx:213` | `/${slug}/schedule-builder/repair` |
| `src/app/[league]/(public)/schedule/page.tsx:220` | `/${slug}/schedule-builder/one-off` |
| `src/app/[league]/(manage)/schedule-builder/repair/page.tsx:78` | `/${leagueSlug}/schedule-builder` |
| `src/app/[league]/(manage)/schedule-builder/one-off/page.tsx:74` | `/${leagueSlug}/schedule-builder` |

⚠️ The last two are **"Schedule Builder" back-buttons in the `PageHeader`**. With
a tab strip above them they become redundant with the Build tab, so the honest
change deletes them rather than repointing them. **[inferred]** — that is a
judgement about the resulting UI, not a measurement.

### Nav — one file

`src/components/shared/staff-links.tsx:33-34` **[measured]**: the two entries
collapse to one, `{ path: "/schedule", label: "Schedule" }`.

✅ The active-state logic needs no change. `staff-links.tsx:75` is
`pathname === href || pathname.startsWith(href + "/")` **[measured]**, so
`/obhl/schedule/build` lights the single "Schedule" entry by construction —
which is the correct behaviour and is free. **[inferred]** from reading the
predicate.

⚠️ `staff-links.tsx:42` gives a **scorekeeper** `{ path: "/schedule", label: "Score Games" }`
**[measured]**. A scorekeeper must not be offered the three manage tabs — the
tab strip has to be gated on `canManageLeague`, not rendered unconditionally by
the Games page. `schedule/page.tsx:134-139` already carries a docblock about
exactly this trap for the edit panel ("`canManageLeague`, NOT `canScore`")
**[measured]**; the tab strip inherits it.

### Revalidation — 14 strings, two files

Enumerated in the table above. Every one is a literal that must be rewritten.

### New code

One tab-strip component, ~40-60 lines. **[inferred]** sizing, from the two
comparable components in the repo: `nav-links.tsx` is 62 lines and
`team-tabs.tsx` was 62 **[measured]** — `git show 3e692fa:src/components/manage/team-tabs.tsx`.

⛔ **BUILD IT AS A LINK ROW, NOT ON `components/ui/tabs.tsx`.** This repo has
already tried Radix `<Tabs>` over URL-conditional server content and reverted it.
`team-tabs.tsx` existed from `3e692fa` to `9731234` and its docblock enumerates
three concrete failures, all of them a blank content area **[measured]**:

> - BACK from `?tab=manage` returned a payload with no manage panel while the
>   retained state still said "manage";
> - arrow-keying onto the trigger set the value on FOCUS without navigating;
> - with `activationMode="manual"`, Enter activated the tab without following the link.

`9731234`'s message calls the removal "the two blank-panel bugs the tab caused
are gone by construction, along with the client component that existed only to
keep the tab and the URL from disagreeing." **[measured]**

The shape that works here is `nav-links.tsx`'s: real `<Link>`s to real routes,
active state from `usePathname()`, no client state at all. Approach C's tabs are
route tabs, which is the case Radix Tabs is the wrong tool for.

⚠️ **A third `navigation` landmark needs a name.** `staff-links.tsx:109-111`
records that `aria-label` is load-bearing because two unnamed landmarks are
indistinguishable to a screen reader **[measured]**. A "Schedule" strip makes
three. ✅ No spec breaks on it: the two unnamed `getByRole("navigation").first()`
calls are `e2e/15-league-routing.spec.ts:158` (on `/obhl/standings`) and `:643`
(on `/obhl/teams/sharks`) **[measured]** — neither is a schedule page.

### Docs

`LAUNCH.md:230` **[measured]** names `/<league>/schedule-builder` in the Phase 6
launch runbook. It is operator-facing and would go stale.

---

## The redirect table

Three entries added to `next.config.ts`'s `redirects()`, `permanent: true`,
matching the five already there. **[inferred]** — the shapes follow the existing
entries read at `next.config.ts:27-76`.

| From | To |
| --- | --- |
| `/:league/schedule-builder` | `/:league/schedule/build` |
| `/:league/schedule-builder/repair` | `/:league/schedule/repair` |
| `/:league/schedule-builder/one-off` | `/:league/schedule/one-off` |

⛔ **Three explicit rules, NOT one wildcard.** A single
`/:league/schedule-builder/:rest*` → `/:league/schedule/:rest*` would map the
bare `/schedule-builder` (zero trailing segments) to `/schedule` — the Games tab
— when it must land on Build. **[inferred]**, and it is the exact hazard
`next.config.ts:21-25` already documents for the `/manage/` rule, where
`:rest*` being zero-or-more is called out as deliberate. Here it would be wrong.

✅ **No ordering hazard against the existing five.** All five current sources are
anchored at both ends and none begins `/:league/schedule-builder`
**[measured]** — read at `next.config.ts:30, 39, 52, 67, 72`.

### What happens to a bookmark or deep link that exists today

**[inferred]** throughout — no HTTP request was made to verify, and the redirects
do not exist yet.

| A manager has bookmarked | What happens |
| --- | --- |
| `/<league>/schedule-builder` | 308 → `/<league>/schedule/build`. Query string carried, per `next.config.ts:15`. |
| `/<league>/schedule-builder/repair` | 308 → `/<league>/schedule/repair` |
| `/<league>/schedule-builder/one-off` | 308 → `/<league>/schedule/one-off` |
| `/<league>/manage/schedule-builder/one-off` | **two hops**: → `/<league>/schedule-builder/one-off` → `/<league>/schedule/one-off` |
| `/<league>/schedule`, `/<league>/score` | unchanged |

⚠️ The two-hop chain is not new and not a problem. `next.config.ts:36-37` already
documents the same pattern for `/rules/edit`: "an old
`/<league>/manage/rules/edit` takes both hops". **[measured]**

✅ **And the existing test of that chain survives untouched.**
`e2e/15-league-routing.spec.ts:655-687` asserts with `maxRedirects: 0` and checks
only the **first** hop's `location` **[measured]** — so its
`["/obhl/manage/schedule-builder/one-off", "/obhl/schedule-builder/one-off"]`
row (lines 662-663) still passes after the restructure, because that first hop is
unchanged. **[inferred]** from reading the assertion at lines 684-686.

⚠️ **But the three new redirects would then be untested.** That same test's
docblock (lines 649-653) is explicit **[measured]**: "The redirect in
`next.config.ts` is the only thing keeping those alive, and **nothing else in the
suite would notice if it were deleted**." Approach C must add three rows to
`moved` or it ships three redirects with the same blind spot.

---

## The e2e rewrite scope, enumerated

**[measured]** — every line below was printed verbatim from the tree this
session. Nothing here is estimated.

### Mandatory — 18 lines, 5 files. `27-one-chrome` is not among them.

| File | Line | Current text | Change |
| --- | --- | --- | --- |
| `e2e/11-schedule-builder.spec.ts` | 100 | `await page.goto("/obhl/schedule-builder");` | → `/obhl/schedule/build` |
| | 120 | `await page.goto("/obhl/schedule-builder");` | → `/obhl/schedule/build` |
| | 479 | `await page.goto("/obhl/schedule-builder");` | → `/obhl/schedule/build` |
| `e2e/14-one-off-game.spec.ts` | 97 | `await page.goto("/obhl/schedule-builder");` | → `/obhl/schedule/build` |
| | 226 | `await page.goto("/obhl/schedule-builder/one-off");` | → `/obhl/schedule/one-off` |
| | 281 | `await page.goto("/obhl/schedule-builder/one-off");` | → `/obhl/schedule/one-off` |
| `e2e/16-league-membership.spec.ts` | 155 | `"/schedule-builder",` | → `"/schedule/build",` |
| | 156 | `"/schedule-builder/one-off",` | → `"/schedule/one-off",` |
| `e2e/29-schedule-repair.spec.ts` | 232 | `await page.goto("/obhl/schedule-builder");` | → `/obhl/schedule/build` |
| | 292 | `await page.goto("/obhl/schedule-builder");` | → `/obhl/schedule/build` |
| | 316 | `await page.goto("/obhl/schedule-builder");` | → `/obhl/schedule/build` |
| | 337 | `await page.goto("/obhl/schedule-builder/repair");` | → `/obhl/schedule/repair` |
| | 408 | `await page.goto("/obhl/schedule-builder/repair");` | → `/obhl/schedule/repair` |
| | 449 | `await page.goto("/obhl/schedule-builder");` | → `/obhl/schedule/build` |
| | 451 | `await expect(page).toHaveURL(/\/schedule-builder\/repair/);` | → `/\/schedule\/repair/` |
| `e2e/30-schedule-edits.spec.ts` | 294 | `await page.goto("/obhl/schedule-builder");` | → `/obhl/schedule/build` |
| | 460 | `await page.goto("/obhl/schedule-builder");` | → `/obhl/schedule/build` |
| | 494 | `await page.goto("/obhl/schedule-builder");` | → `/obhl/schedule/build` |

Seventeen are plain `goto` substitutions; one (`29:451`) is a regex.

⚠️ **`16-league-membership.spec.ts:155-156` deserves a second look, not a
substitution.** Those two entries live in `MANAGE_PATHS`, a list of paths that
must bounce a manager of another league to `/` (lines 148-179 **[measured]**),
and the list carries a comment at 157-159 explaining that `/schedule` is
deliberately **absent** because it is public. After the restructure the list
holds `/schedule/build` and `/schedule/one-off` while their parent `/schedule` is
still correctly absent — which reads as an oversight unless the comment is
rewritten to say why. `/schedule/repair` is absent today and should probably be
added while the file is open. **[inferred]**

### Conditional — 2 more lines, if the Build page's heading changes

| File | Line | Current | Note |
| --- | --- | --- | --- |
| `e2e/11-schedule-builder.spec.ts` | 105 | `page.getByRole("heading", { name: "Schedule Builder" }),` | Only if `schedule-builder/page.tsx:64`'s `title="Schedule Builder"` becomes "Schedule". |
| | 118 | `test("scorekeeper cannot reach /schedule-builder", ...` | Test title only — cosmetic, but it names a URL that will no longer exist. |

⚠️ Whether line 105 changes is a design decision this spec does not make. If
each tab keeps its own `PageHeader` title, the heading stays "Schedule Builder"
and line 105 is free. If the section gets one heading with tabs beneath it, the
four `PageHeader` titles at `schedule/page.tsx:161`, `schedule-builder/page.tsx:64`,
`repair/page.tsx:73` and `one-off/page.tsx:69` **[measured]** all become tab
labels and line 105 changes. **The second is what "one Schedule section with
sub-nav" means**, so budget for it.

### Additions — 3 rows

Three new entries in `e2e/15-league-routing.spec.ts`'s `moved` array (line 658),
so the three new redirects are covered the way the `/manage/` ones are.

### Comments that become false — 3 blocks

`e2e/11-schedule-builder.spec.ts:101-103`, `e2e/14-one-off-game.spec.ts:98`, and
`e2e/29-schedule-repair.spec.ts:445-448` all narrate the current URL space
**[measured]**. They are not assertions and will not fail; they will just be
wrong.

### ⛔ The re-verification cost is larger than the edit cost

The five specs above are among the slowest in the suite. **[measured]**:
`29-schedule-repair.spec.ts` calls `test.slow()` on the tests at lines 288, 333,
404 and 441; `11-schedule-builder.spec.ts:141` defines
`AFTER_GENERATE = { timeout: 45_000 }` and its docblock (lines 124-140) explains
that a generate runs Phase S at five candidates and "the search alone can reach
~25s before anything renders". Four of the five files carry the comment
`/** See 11-schedule-builder.spec.ts — Phase S runs five candidates. */`
(`23:29`, `28:95`, `29:118`, `30:35`).

⚠️ And per the worklist's standing hazard, e2e runs only via
`scripts/e2e-locked.sh` with a distinct `PORT`, because worktrees share one
Supabase — so these cannot be parallelised across sessions. **18 one-line string
edits, verified by the most expensive specs in the repo.**

---

## Risks and one-way doors

### ⛔ One silent-failure mode, currently unguarded

The 14 `revalidatePath` strings. A missed one type-checks, lints, passes all five
convention assertions in `revalidate-paths.test.ts`, and revalidates nothing —
surfacing later as a stale builder page after a publish, at a moment nobody
connects to this change. **[measured]** for the guard's blind spot; **[inferred]**
for the user-visible symptom.

This is the single largest risk in approach C, and it is cheap to close — see the
recommendation.

### ⚠️ A fourth row of links, at a viewport nothing tests

The repo has a documented horizontal-overflow history: `staff-links.tsx:166-181`
records `documentElement` at 399px against a 390px viewport, traced to the league
switcher's select **[measured]**, and `site-header.tsx:36-73` carries a full
pixel budget for the header bar.

`e2e/02-auth.spec.ts:313-321` is the 390px guard, and it visits **`/obhl/standings`
and `/obhl/seasons`** **[measured]**. Neither is a schedule page. So a four-tab
strip added to `/schedule*` lands on the one surface the overflow test does not
look at. **[inferred]** — the risk is that the strip overflows at 390px and no
existing test notices.

✅ Mitigation is known and cheap: give the strip `overflow-x-auto` with
`min-w-0 flex-1`, the shape `staff-links.tsx:182-190` already uses and justifies
**[measured]**, and add `/obhl/schedule` to the 390px loop.

### ⚠️ A visible seam between the Games tab and the other three

Different `<main>` padding and a footer on one tab but not the others, because
the two route groups own different layouts (table above, **[measured]**). The
same seam ships today between `/games/<id>` and `/games/<id>/score` and has
drawn no complaint **[inferred]** — but tabs invite rapid switching in a way a
click-through to a scoresheet does not, so it will be more noticeable here.

### ✅ No one-way doors

**[inferred]**, and stated deliberately because the predecessor deferred this
work for proximity to one. Approach C:

- writes no migration and touches no RLS policy;
- touches no schedule-generation, publish, or game-write code — none of
  `applyGameWrites`, `publishSchedule` or the `0045`/`0046` RPCs appears in the
  inventory above;
- cannot trip `season_is_started`, which fires on game dates, not on URLs;
- is reversible by moving three directories back and deleting three redirect
  entries.

The only durable commitment is that `/<league>/schedule-builder` becomes a
permanent redirect source, so no future route may claim that path. Redirects are
matched before the filesystem — `next.config.ts:11-13` **[measured]**.

### ⚠️ "Cleanest conceptually" is partly unearned

Approach C does **not** remove the duplication it looks like it should.
`ScheduleBuilderPanel` renders at two URLs today — the standalone builder page
and the season setup hub, `src/app/[league]/(manage)/seasons/[seasonId]/page.tsx:281`
**[measured]**, and the component's own docblock at
`schedule-builder-panel.tsx:54` names both call sites. After approach C it still
renders at two URLs: `/schedule/build` and `/seasons/<id>`. **[inferred]** The
tab strip tidies the schedule stem and leaves that alone.

---

## Explicitly out of scope

- **Any change to what the four pages do.** No new capability, no changed guard,
  no changed write path. If a task in the plan edits `applyGameWrites`, the plan
  is wrong.
- **Merging any two of the four pages.** `2026-09-05-unified-url-space-design.md:103-106`
  argues that case and this spec accepts it. Nest, do not merge.
- **Deduplicating `ScheduleBuilderPanel` between `/schedule/build` and
  `/seasons/<id>`.** Named above as a limit, not as work.
- **The season-setup hub's URL.** `/seasons/<id>` keeps its embedded builder.
- **`27-one-chrome.spec.ts`.** Measured at zero cost; it should end the change
  byte-identical, and a diff touching it is a signal something went wrong.
- **The staff-row stale comments** at `staff-links.tsx:116-120` (the "Games"
  labels). Wrong today, independently of this change. Fix them or don't, but
  they are not approach C.
- **Items 1-6 of the deferred worklist.** Item 3 (a clock-shifted CI job) and
  item 6 (CI lint) would both make this change safer to verify, and neither is
  part of it.

---

## Cost estimate

**[inferred]** — an estimate, anchored on two measured comparables in this repo.

| Comparable | Files | Diff | **[measured]** by |
| --- | --- | --- | --- |
| `fbb0802` — drop `/manage/` from every staff URL | 60 | +332 / −262 | `git show --stat` |
| `6d369c0` — merge the score list into `/schedule`, nest the scoresheet, 2 redirects | 17 | +290 / −204 | `git show --stat` |

`6d369c0` is the close analogue: a nest-plus-redirect restructure that touched
seven e2e specs and `next.config.ts`. Approach C's inventory is smaller than it —
no page bodies merge, no guard changes, no new component beyond a link strip.

**Estimate: 14-16 files, roughly +150 / −120, of which perhaps 60 lines are new
code (the tab strip) and the rest are string substitutions.**

Split by phase, **[inferred]**:

| Phase | Work |
| --- | --- |
| 1 | Three `git mv`s; 8 hrefs; 14 `revalidatePath` strings; 1 nav entry; 3 redirects. Mechanical. |
| 2 | The tab strip: new component, gated on `canManageLeague`, rendered by four pages; four `PageHeader` titles become tab labels. The only design work. |
| 3 | 18 e2e string edits + 3 redirect rows + 3 comment blocks + the 390px loop. |
| 4 | Verification: `npm run typecheck && npx vitest run && npx eslint src e2e`, then the five slow specs via `scripts/e2e-locked.sh`. |

⚠️ Phase 4 dominates the wall clock, not phases 1-3. And per the worklist,
**one green run proves nothing** where Phase S is wall-clock bounded.

---

## Recommendation: not yet — but the reason has changed, and so has the price of "yes"

**Defer again. Not for the predecessor's reason, which has expired and was
partly wrong anyway.**

The case against doing it now:

1. **Approach B already delivered the user-facing outcome.** The complaint that
   made this architectural was *"if changes can take place after a season is
   published I'm not sure it makes sense for it to be hidden in the 'Schedule
   Builder' tab."* That is fixed and shipped: `schedule/page.tsx:198` renders
   `ScheduleEditPanel` on `/schedule`, and lines 210-226 link to repair and
   one-off from there. `staff-links.tsx:27-34` carries a comment recording the
   reorder and why. **[measured]** Nothing is hidden in the builder any more.
2. **Approach C therefore buys wayfinding, not capability.** By the inventory
   above, no page gains a feature and no manager gains an action. **[inferred]**
3. **Its measured cost is small but its riskiest part is unguarded.** 18 e2e
   string edits is cheap; 14 `revalidatePath` strings whose failure is invisible
   to every automated check in the repo is not, and it lands in
   `src/lib/actions/schedule.ts` — the file behind publish, generate and repair.
4. **The verification cost is disproportionate to the change.** The five specs
   that must be re-run are the slowest in the suite, serialised on one shared
   Supabase, to prove that eighteen strings were substituted correctly.

⚠️ **What would flip this to "yes", and it is one small piece of work:**

> **Make `revalidate-paths.test.ts` route-aware.** Have it walk `src/app` and
> assert that every `revalidatePath` pattern resolves to a real route directory,
> instead of only checking the `/[league]` prefix and the dead `/manage/` one.
> It is a unit-test change in one file with no production risk, it is worth
> having whether or not approach C is ever built — it closes the same silent
> failure for every future rename — and it converts approach C's one dangerous
> failure mode into a caught one.

With that guard in place, approach C is a mechanical, fully-verifiable change of
about 15 files, and the argument against it reduces to "it buys tidiness". That
is a fair thing to spend a quiet afternoon on. It is not a fair thing to spend it
on while the guard is missing.

⛔ **Whenever it is built, it gets its own branch.** The worklist is explicit:
"Do not attach it to an unrelated branch." Nothing here changes that.

### If it is built anyway, the success criteria

1. `/<league>/schedule` shows four tabs to a league manager and none to a
   scorekeeper or a visitor.
2. All three old builder URLs 308 to their new homes, with query strings
   preserved, asserted in `e2e/15-league-routing.spec.ts`'s `moved` array.
3. `grep -rn "schedule-builder" src/` returns **no URL** — no route directory,
   no `href`, no `revalidatePath` string. **[measured]** what legitimately
   remains after a correct rename: the component's own filename and its two
   imports (`seasons/[seasonId]/page.tsx:13`, and the moved build page), plus
   two incidental comments in `publish-controls.tsx:21,74` that name the
   component, not the URL. ⚠️ Two comments **do** name the URL and must be
   updated with everything else: `schedule-builder-panel.tsx:54` ("the
   standalone /schedule-builder") and `schedule.ts:56` ("used by the standalone
   /schedule-builder").
4. `e2e/27-one-chrome.spec.ts` is byte-identical to its state on `main`.
5. The 390px leg of `e2e/02-auth.spec.ts` visits a schedule page and passes.
6. No migration, no RLS change, and no diff in `gameWrites`, `publishSchedule`,
   or the `0045`/`0046` RPCs.
