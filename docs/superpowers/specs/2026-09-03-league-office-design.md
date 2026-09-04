# The League Office — a tier above the league manager

**Protocol — read this and nothing else to start.**

1. This file is self-contained. Its background is `ACCESS_CONTROL_HANDOFF.md`
   (the membership model) and `LAUNCH_READINESS_HANDOFF.md` (what production
   still needs). Open them only where a section below says to.
2. ⛔ **Hazards, before any instruction:**
   - `supabase db reset --linked` **wipes production**. Use `db push`.
     `npm run db:reset` is the *local* one and is safe.
   - **This design depends on `0033`.** `may_write_profile` calls
     `contains_leagues_of`, which exists only in PR #19. Nothing here can be
     written against `main` until #19 merges. See *Order*.
   - The `app_role` enum and the JWT hook (`0010_auth_hook.sql`) stay
     **untouched**, for the reasons in *Alternatives*. Changing the hook also
     means re-enabling it by hand in the Supabase dashboard.
3. Claims below are marked. "Watched" means it was run and the output read.
   "A reading" means it follows from the code and has not been executed. The
   two traps in section 4 are readings and **must be probed before merge**.

## 1 — What this is, and the premise it reverses

`0032_profile_leagues.sql` states, in its header:

> A manager grants access only inside leagues they are already in, which is
> what removes the need for a superadmin tier.

That was true of *granting*. It is not true of *revoking*, and PR #19 is where
the gap became concrete. `profiles.role` is one instance-wide column, so a role
write lands in every league the account works; `mayWriteProfileOf` therefore
tests **containment** — every league the target works must be one the actor
works too. The honest cost, stated in #19's own description:

> A single-league manager can no longer change the role of anyone who also
> works another league.

And where no single manager works every league a person works, **nobody can**,
and the change is made by hand in SQL. #19's copy says so in four places.

The League Office is the answer to that cost. It is not per-league roles, which
#19's description names as the alternative — that is a schema change to the
role model itself, and remains unbuilt and unneeded.

**0032's header, `people.ts`'s two "changed by hand" messages, the
`staff-row-actions.tsx` tooltip and `removeStaff`'s zero-manager argument all
become false when this ships.** Correcting them is the first commit, not the
last — a stale comment asserting something is impossible is worse than no
comment, because it is load-bearing for the next reader's model.

## 2 — The model

Three tiers. One rule.

| Tier | Reach | May write |
|---|---|---|
| **Commissioner** | every league, present and future | anyone except another commissioner |
| **Deputy** | every league, present and future | anyone outside the office |
| **League manager** | leagues they are a member of | tier-0 accounts whose leagues theirs contain, and never another manager |

**You may write a profile only if your tier is strictly above theirs.**

That single comparison produces every rule asked for. Commissioner↔commissioner,
deputy↔deputy and manager↔manager all fail it — which is "peers" stated once
instead of three times. Each tier writes strictly downward. Containment survives
untouched at tier 0, where it is still the whole of the test.

Two consequences worth naming because they are easy to misread:

- **A deputy cannot touch the office at all** — not another deputy, not a
  commissioner, and not the tier itself. "Everything a commissioner can do,
  except the tier" is exactly what the comparison yields.
- **The commissioner tier is not editable from the app, by anyone.** It is
  peer-flat, so no commissioner outranks another. Appointing or removing one is
  done in SQL. This is deliberate: it is the same shape as manager demotion
  today, and it means no single compromised office account can empty the tier.

## 3 — Schema: `0034_league_office.sql`

```sql
create type office_tier as enum ('deputy', 'commissioner');

create table league_office (
  profile_id uuid primary key references profiles(id) on delete cascade,
  tier       office_tier not null,
  created_at timestamptz not null default now()
);
alter table league_office enable row level security;
```

**No grants to `authenticated`, and no policies.** 0009's blanket
`grant insert, update, delete on all tables in schema public` ran long before
this table existed, so a new table starts with none — 0032 hit the same thing
and granted explicitly. This one deliberately does not.

That is a departure from the codebase's usual "an app guard plus an independent
RLS half", and the reason belongs in the migration header: **an absent grant is
stronger than any policy**. A policy can be written wrong, or dropped by a later
migration that means to replace it. A table `authenticated` cannot write at all
has no such failure mode, and there is no legitimate session-level write here —
every legitimate write is the admin client, which uses the service role.

`select` is not granted either. Nothing needs it: the helpers below are
`security definer`, and every page that lists the office reads on the admin
client.

Two helpers, both `security definer set search_path = public`, matching 0032's
convention:

```sql
create or replace function public.office_tier_of(p_profile uuid)
returns office_tier language sql stable security definer set search_path = public as $$
  select tier from league_office where profile_id = p_profile;
$$;

create or replace function public.my_office_tier()
returns office_tier language sql stable security definer set search_path = public as $$
  select tier from league_office where profile_id = auth.uid();
$$;
```

## 4 — The two traps

Both are silent. Both are readings of the code, not measurements, and **both
must be probed on the anon key before this merges** — the same way #19's
escalation was.

### (a) `is_league_member(null)` must stay false

"Full manager of every league" is delivered by one branch:

```sql
create or replace function public.is_league_member(p_league uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_league is not null and (
    public.my_office_tier() is not null
    or exists (
      select 1 from profile_leagues
      where profile_id = auth.uid() and league_id = p_league
    )
  );
$$;
```

`manages_league(l)` is already `auth_role() = 'league_manager' and
is_league_member(l)`. So an office member whose `profiles.role` stays
`league_manager` is granted every one of the ~20 role-keyed policies in
0009/0032 **with no edit to any of them**. That is the whole reason this design
is small.

⛔ **`p_league is not null` is load-bearing and new.** 0032's header states the
invariant it protects:

> All of them fail closed on a null argument — `= null` is never true — which
> is what makes an unresolvable league a refusal rather than a pass.

The existing body fails closed *incidentally*, because `league_id = null` is
never true. An `or` branch that does not mention `p_league` destroys that. Without
the explicit guard a commissioner passes `manages_league(null)` — and null is
what `logo_object_league` returns for a malformed storage path, what
`season_league` returns for a deleted season, and what every pre-0031 audit row
carries. The office would silently gain write access to every unresolvable and
orphaned object in the instance.

**Probe:** as a commissioner on the anon key, attempt a write gated on a null
league (a storage object named outside the `teams/<uuid>.<ext>` shape is the
cheapest). Expect refusal. This is the one test that would catch the trap; no
existing test would notice it.

### (b) `contains_leagues_of` passes *vacuously* for the office

An office member has **no `profile_leagues` rows** — membership is a rule here,
not data. `contains_leagues_of` asks "is there a league of theirs that is not
mine", so over an empty set it returns true for *any* caller.

A reading, and a reachable one: an ordinary league manager satisfies
`auth_role() = 'league_manager'`, so as written today they would pass
`manager write profiles` against a commissioner and rewrite their
`profiles.role`. The precedence function must refuse the office **explicitly**
rather than lean on containment:

```sql
create or replace function public.may_write_profile(p_profile uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select case public.my_office_tier()
    when 'commissioner' then public.office_tier_of(p_profile) is distinct from 'commissioner'
    when 'deputy'       then public.office_tier_of(p_profile) is null
    else public.office_tier_of(p_profile) is null
         and public.contains_leagues_of(p_profile)
  end;
$$;
```

`is distinct from` rather than `<> ` on purpose: `office_tier_of` returns null
for everyone outside the office, and `null <> 'commissioner'` is null, not true
— which would refuse a commissioner every ordinary write.

`contains_leagues_of` (0033) is unchanged and now has exactly one caller. The
policy swaps which function it names:

```sql
drop policy "manager write profiles" on profiles;
create policy "manager write profiles" on profiles
  for all to authenticated
  using (public.auth_role() = 'league_manager' and public.may_write_profile(id))
  with check (public.auth_role() = 'league_manager' and public.may_write_profile(id));
```

`manager read profiles` keeps `shares_league_with`, as 0033 left it. Note what
that now means: an office member shares a league with everyone, so they read
every profile in the instance. Intended, and stated here so it is not later
discovered.

**Probe:** as an ordinary single-league manager on the anon key, attempt
`update profiles set role = ... where id = <commissioner>`. Expect 0 rows. ⚠️
Read the row back — an RLS-refused UPDATE reports **no error** and matches zero
rows, which is the failure mode `ACCESS_CONTROL_HANDOFF.md`'s *Traps* section
exists for.

## 5 — App-side

**`src/lib/auth/office.ts`** — new. A `cache()`d `officeTierOf(profileId)` on
the admin client, memoized per request for the same reason `memberLeagueIds` is:
a page, its layout and the action it submits to all ask once.

**`memberLeagueIds()`** gains one branch at the top — an office member returns
every league id. This is the single edit that delivers cross-league reach
app-side, because it is the input to `isLeagueMember` (so, every guard),
`getMemberLeagues` (the switcher), `mayWriteProfileOf`, and the People page's
viewer set.

**`mayWriteProfileOf()`** becomes the TypeScript mirror of `may_write_profile` —
the same four branches in the same order. ⚠️ These two are one rule written
twice and **must be reviewed as a pair**; they are the app half and the RLS half
of the same question, and the ways they can silently disagree are what section 4
is about.

**`src/lib/actions/people.ts`:**

- `updateStaffRole` — the demotion refusal becomes tier-conditional:
  `if (before?.role === "league_manager" && !(await officeTierOf(actor.id))) return;`
  That one line is the whole of "the office can revoke a manager, peers cannot."
- `removeStaff` — gains an explicit refusal when the target is in the office.
  ⛔ Without it this is a **silent no-op**: implicit membership means there is no
  `profile_leagues` row to delete, so `removeLeagueMembership` succeeds having
  done nothing and the entry logs a removal that did not happen.
- `createStaffAccount` — the "Managers are changed by hand" message becomes
  "…by a commissioner", which is true again.

## 6 — Surfaces

**People & Roles** (`/[league]/manage/people`) unions office members into the
league's staff list, labelled Commissioner and Deputy. The page's `members`
query reads `profile_leagues` for the league, which office members are not in,
so this is an explicit union rather than something that happens by itself.

Office rows are **read-only there for everyone, including commissioners**. The
tier and its members are managed in exactly one place. A row that offered to
change a deputy's underlying role while their tier lives on another page invites
the wrong mental model of what the row controls.

⚠️ That makes the *surface* narrower than the *permission*: section 2 lets a
commissioner write a deputy, and no control here offers it. Deliberate, and the
path is two steps, each in one place — a commissioner removes the tier in League
Office, at which point the person is an ordinary manager row in People & Roles
and their role is changeable there. The permission is not unreachable; it is
reached in the order that keeps each page about one thing.

`canChangeRole` becomes the precedence test, so what renders and what the server
permits keep agreeing — the property `staff-row-actions.tsx` already documents
and the reason it renders a reason instead of a control that does nothing.

Labels, fixed once so they do not drift between surfaces: the role column and
the League Office roster read **Commissioner** and **Deputy**; audit prose reads
"a commissioner" and "a deputy commissioner", which is how the appointment is
said aloud.

**League Office** at `/manage/office`, outside `[league]`. Safe as a top-level
static route: `manage` is a reserved league slug (`0030`), whose comment says it
is reserved precisely so nothing answers under it. Visible to the office only.

- A commissioner sees appoint and remove controls on deputies.
- A deputy sees the roster read-only.
- Commissioners are listed with no controls for anyone, and the page **says why**
  — that the tier is peer-flat and changing it takes database access. An
  unexplained absent control reads as a bug.

## 7 — Audit

One canonical entry per action: `entity_type: "office"`, `league_id` null,
actions `appoint_deputy` and `remove_deputy`, rendered in League Office's own
log.

⛔ **`leagueOfEntity` needs `case "office": return null` in the same change.**
That function's own warning states the rule: an entity type that is not listed
logs with no league, and a null league is hidden by RLS *and* filtered out of
every league-scoped view, so the entry is correct and invisible. Here null is
the right answer — but it must be written down as a decision, because
`logAudit` resolves `entry.league_id ?? leagueOfEntity(...)` and an explicit
`null` still falls through to the switch. Reaching the same value by default and
by decision are indistinguishable afterwards.

Each league's audit page then runs one extra query for recent office entries and
renders them as a distinct notice band, so a league manager sees that the
instance staff changed without their log filling with rows they cannot act on.
One row per action rather than one per league.

## 8 — Bootstrapping, and a constraint from #19

The tier is peer-flat, so **the first commissioner cannot be created from the
app**. Two paths:

- `scripts/seed-users.mjs` appoints one, for local and e2e.
- A documented SQL snippet in `LAUNCH_READINESS_HANDOFF.md`, for production.

Appointing someone **does not touch their `profile_leagues` rows**, and nothing
here deletes them. A manager promoted to deputy keeps the rows they had; they
are simply inert while the office branch of `memberLeagueIds` answers first. So
removing the tier restores exactly the reach the person had before it, with no
repair step and nothing to remember — the tier is purely additive, which is what
makes revocation clean rather than lossy.

⛔ **The seed must add new accounts, never elevate an existing fixture.**
`seed-users.mjs` has five, and its own header explains why the last two exist:

> Without them the whole suite runs as a manager who belongs to everything, and
> every cross-league guard passes whether or not [it holds].

#19's rewritten `16-league-membership.spec.ts` drives `single-league-lead`
(harbor only) against `single-league-scorer` (obhl only) and asserts the role
control is **absent**. Elevating `manager@obhl.test` would give every test that
signs in as Manager office powers, and the cross-league guards would stop being
exercised while still reporting green. Add a **sixth and seventh** account —
commissioner and deputy — and leave all five existing fixtures untouched.

## 9 — Order

1. **PR #19 merges.** `0034` calls `contains_leagues_of`, which only exists
   there. Cutting this branch from `main` first would mean duplicating or
   renumbering 0033 and rebasing across the eight files the two changes share.
2. **`0033` is pushed to production** — independent of the merge, and #19's
   description argues pre-merge is safe and better: every `profiles` write in
   the app goes through the admin client, so 0033 is invisible to deployed code.
   It is `LAUNCH_READINESS_HANDOFF.md` item 3.
3. This branch is cut from #19's head. Its **first commit is the copy
   correction** of the five stale assertions in section 1.
4. `0034` is pushed after this merges.

Unrelated and unblocked: `ENABLE_DEV_LOGIN` is still set on production and the
seeded accounts' password is committed to this repo
(`LAUNCH_READINESS_HANDOFF.md` items 1 and 2). While that is true, People &
Roles is reachable by anyone with the URL and none of the above is worth much.
Those outrank this work.

## 10 — Testing

**Unit** — the nine-cell precedence matrix against `mayWriteProfileOf`, every
combination of {commissioner, deputy, none} writing {commissioner, deputy,
none}, plus the two tier-0 sub-cases (contained, not contained). The whole
hierarchy is one table and it is cheap.

**e2e** — the ones that catch what types cannot:

- a deputy fails to revoke another deputy's tier;
- a commissioner succeeds at the same thing;
- a commissioner demotes a league manager from People & Roles, which no manager
  can do;
- a commissioner opens a league they hold **no `profile_leagues` row for**, and
  it works — implicit membership, driven rather than asserted;
- an ordinary manager forges a write against a commissioner's profile via the
  existing `tamper()` helper and is refused (trap b, app side);
- `removeStaff` against an office member refuses **and says so**, rather than
  reporting success having done nothing.

**Anon-key probes**, both from section 4, both to be watched before merge:
`manages_league(null)` still false for a commissioner; a manager's UPDATE
against a commissioner's role writes 0 rows. ⚠️ Read the row back, not the
error.

Re-measure the baseline rather than quoting one. #19 finished at **250 unit; 127
e2e passed / 1 skipped / 0 failed** (watched, 2026-09-02); the skip is the
AI-summary test, gated on an API key.

## 11 — Alternatives considered and rejected

**New `app_role` values `super_manager` / `sub_super_manager`.** One field would
hold the whole role, with no "manager, but secretly more" duality. Rejected on
three counts. It walks into the hazard `ACCESS_CONTROL_HANDOFF.md` names — every
`auth_role() = 'league_manager'` across 0009/0032/0033 becomes an `in (...)`,
plus the `AppRole` union, `requireRole` call sites, the nav `LINKS` map,
`ROLE_LABEL`, and `ROLES` in `people.ts`. Postgres will not *use* a newly added
enum value in the transaction that added it, so it needs splitting across two
migration files (a reading, not tested — it did not need to be). And the
disqualifier: the tier would ride in the JWT via the 0010 hook, so **a revoked
deputy would keep their power until their token rotated.** Revocation working
immediately is the point of the tier.

**Explicit `profile_leagues` rows for the office, plus a flag.** Everything
downstream would work with no helper changes at all — the People page, the
switcher, every policy. Rejected because it stores a rule as facts, and facts
drift: a league created while the insert trigger is broken silently strands a
commissioner out of it, and `removeStaff` can delete an office member's row and
quietly shrink their reach in that league with nothing reporting it.

**Fanning tier changes out to every league's audit log.** Would give the same
visibility with nothing new to build. Rejected for N rows per action and for
filling a league's log with entries about people who never worked it; the notice
band in section 7 is the same information at one row.

**Naming.** "Super manager" / "sub super manager" was the original phrasing.
Rejected: "super manager" collides with "Manager" on a row that shows both, and
"sub super manager" is not a title anyone says out loud. Commissioner and Deputy
are the NHL's own structure and rec hockey's existing vocabulary, and "deputy"
carries the precise meaning — full authority, appointed and removed by the
commissioner.

## 12 — What this does not change

- `app_role`, and the `0010` JWT hook. Untouched, so no claim goes stale and the
  hook needs no re-enabling in the dashboard.
- The ~20 role-keyed policies in 0009 and 0032. They gain the office through
  `is_league_member`, not through edits.
- `contains_leagues_of` (0033). Same body, one caller.
- Containment between league managers. Still the whole test at tier 0, and still
  the reason a single-league manager cannot reach across.
- `players`, which 0032 deliberately leaves globally writable — a person is one
  human across leagues.
