import Link from "next/link";
import { createAdminClient } from "@/utils/supabase/admin";
import { discardSchedule } from "@/lib/actions/schedule";
import { getEnrolledTeams } from "@/lib/queries/teams";
import {
  getPublishState,
  getScheduleConstraints,
  getSeasonNights,
} from "@/lib/queries/schedule";
import {
  describeConstraint,
  evaluateConstraints,
  forcedByeCredits,
  presentSpacing,
  resolveConstraints,
} from "@/lib/schedule/constraints";
import { publishMode } from "@/lib/schedule/publishMode";
import { staleDraft } from "@/lib/schedule/staleDraft";
import { estimatedGenerateMs } from "@/lib/schedule/assignNights";
import { weekdayOf } from "@/lib/format";
import { spacingReport, type PlacedGame } from "@/lib/schedule/spacing";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { TeamLogo } from "@/components/shared/team-logo";
import { EmptyState } from "@/components/shared/empty-state";
import { ScheduleGenerateForm } from "@/components/manage/schedule-generate-form";
import {
  ScheduleEditPanel,
  type EditableGame,
} from "@/components/manage/schedule-edit-panel";
import { RescheduleNightForm } from "@/components/manage/reschedule-night-form";
import { PublishControls } from "@/components/manage/publish-controls";
import {
  StaleDraftNotice,
  type StaleNotice,
} from "@/components/manage/stale-draft-notice";
import { RemoveControls } from "@/components/manage/remove-controls";
import {
  formatLongDate,
  formatGameTime,
  leagueDateKey,
  leagueTimeKey,
} from "@/lib/format";

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Schedule builder scoped to a specific season — the forms carry a hidden
 * season_id so they target this season, not whatever is currently active. Used
 * by the season setup hub and by the standalone /schedule-builder (active season).
 */
/**
 * The draft columns `editableDrafts` reads. PostgREST types the embedded
 * `home:`/`away:` joins loosely enough that the mapping below was written with
 * `any`, which is what let a missing `status` column go unnoticed.
 */
type DraftRow = {
  id: string;
  scheduled_at: string | null;
  status: string;
  home_team_id: string;
  away_team_id: string;
  home: { name: string } | null;
  away: { name: string } | null;
};

export async function ScheduleBuilderPanel({
  seasonId,
  league,
}: {
  seasonId: string;
  league: string;
}) {
  const admin = createAdminClient();

  const { data: season } = await admin
    .from("seasons")
    .select("starts_on, ends_on")
    .eq("id", seasonId)
    .maybeSingle();

  const { data: drafts, error: draftsError } = await admin
    .from("games")
    .select(
      `id, scheduled_at, status, round, home_team_id, away_team_id,
       home:teams!games_home_team_id_fkey(name, color, logo_path, logo_text_color),
       away:teams!games_away_team_id_fkey(name, color, logo_path, logo_text_color)`,
    )
    .eq("season_id", seasonId)
    .eq("is_draft", true)
    .order("scheduled_at", { ascending: true });

  const enrolledTeams = await getEnrolledTeams(seasonId, { client: admin });

  const publish = await getPublishState(seasonId, { client: admin });

  // ⚠️ In parallel, not one after the other. This panel already serialises five
  // round-trips before these two, and neither depends on the other — adding the
  // nights read as a sixth sequential await put another full query on the
  // critical path of a page that is already the slowest in the manage area.
  //
  // The nights are read even when there is no live schedule: they come back
  // empty, and a conditional await is a second thing to keep in step with the
  // render below.
  const [storedConstraints, seasonNights] = await Promise.all([
    getScheduleConstraints(seasonId, { client: admin }),
    getSeasonNights(seasonId, { client: admin }),
  ]);
  const openNights = seasonNights.filter((n) => !n.locked);

  // This panel's own draft read is part of the same fail-closed contract as
  // getPublishState's six. It errors independently and PostgREST hands back
  // null data with the error, which coerces to an empty list — indistinguishable
  // from "this season has no draft", which is the answer that offers the manager
  // a generate form and throws away a draft they can't see.
  const readFailed = publish.readFailed || !!draftsError;
  if (draftsError) console.error("draft read failed:", draftsError.message);

  // `!!draftsError`, not `readFailed`: getPublishState already forces its own
  // `started` true when its reads fail, so the only thing this term adds is the
  // draft read above. Passing `readFailed` here would imply both halves are
  // load-bearing when one is already folded in.
  const mode = publishMode({
    ...publish,
    started: publish.started || !!draftsError,
  });

  // One source for "is there a draft to act on": getPublishState's exact server
  // count, not the length of the row list rendered below it. They are separate
  // requests that can disagree, and only the count fails closed — deciding the
  // section from the list meant a failed read rendered the section's header,
  // its Discard button and a "0 games" summary over rows nobody had read.
  const hasDraft = !readFailed && publish.draftCount > 0;

  // Group by night + build a balance report.
  const byDate = new Map<string, any[]>();
  for (const g of drafts ?? []) {
    const d = g.scheduled_at ? leagueDateKey(g.scheduled_at) : "tbd";
    (byDate.get(d) ?? byDate.set(d, []).get(d)!).push(g);
  }
  const nameOf = new Map<string, string>();
  const gp = new Map<string, number>();
  const homeC = new Map<string, number>();
  const awayC = new Map<string, number>();
  const slot = new Map<string, number[]>();
  let maxSlots = 0;
  const bump = (m: Map<string, number>, k: string) =>
    m.set(k, (m.get(k) ?? 0) + 1);

  const usedWeekdays = [
    ...new Set([...byDate.keys()].filter(Boolean).map(weekdayOf)),
  ].sort((a, b) => a - b);
  const nightCat = new Map<string, number[]>();
  const bumpNight = (tid: string, wi: number) => {
    if (wi < 0) return;
    const nc = nightCat.get(tid) ?? usedWeekdays.map(() => 0);
    nc[wi]++;
    nightCat.set(tid, nc);
  };

  for (const [date, arr] of byDate) {
    arr.sort((a, b) => (a.scheduled_at < b.scheduled_at ? -1 : 1));
    maxSlots = Math.max(maxSlots, arr.length);
    const wi = usedWeekdays.indexOf(weekdayOf(date));
    arr.forEach((g, idx) => {
      nameOf.set(g.home_team_id, g.home?.name ?? "");
      nameOf.set(g.away_team_id, g.away?.name ?? "");
      bump(gp, g.home_team_id);
      bump(gp, g.away_team_id);
      bump(homeC, g.home_team_id);
      bump(awayC, g.away_team_id);
      bumpNight(g.home_team_id, wi);
      bumpNight(g.away_team_id, wi);
      for (const tid of [g.home_team_id, g.away_team_id]) {
        const counts = slot.get(tid) ?? [];
        counts[idx] = (counts[idx] ?? 0) + 1;
        slot.set(tid, counts);
      }
    });
  }
  const teamRows = [...gp.keys()].sort((a, b) =>
    (nameOf.get(a) ?? "").localeCompare(nameOf.get(b) ?? ""),
  );

  // Warn if the draft doesn't cover every team evenly (some matchups didn't fit
  // the date range / ice times) — the generator silently drops the overflow.
  const enrolledCount = enrolledTeams.length;
  const gpVals = teamRows.map((t) => gp.get(t) ?? 0);
  const scheduleIncomplete =
    (drafts?.length ?? 0) > 0 &&
    (teamRows.length < enrolledCount ||
      (gpVals.length > 0 && Math.max(...gpVals) - Math.min(...gpVals) > 1));

  // Derived summary + overrun check (the regular season should finish before the
  // season's playoff-inclusive end date).
  const draftDates = [...byDate.keys()].filter((d) => d && d !== "tbd").sort();
  const firstDate = draftDates[0];
  const lastDate = draftDates.at(-1);
  const gamesPerTeamLabel =
    gpVals.length === 0
      ? ""
      : Math.min(...gpVals) === Math.max(...gpVals)
        ? `${gpVals[0]}`
        : `${Math.min(...gpVals)}–${Math.max(...gpVals)}`;
  const overrunsSeason =
    !!season?.ends_on && !!lastDate && lastDate > season.ends_on;

  // ⛔ THE DRAFT AGED. Generate refuses a first night that has already passed
  // (`isPastGameNight`), but it checks the date at the moment the draft is
  // MADE. A draft built for a good future date and left standing — review early
  // in the week, publish later, which is the rebuild workflow — arrives at the
  // publish button with its first game already played over, and publishing it
  // starts the season in the past and locks it permanently. Nothing checked
  // that until this: see `staleDraft`.
  //
  // ⚠️ The GAMES, not the nights: the lock fires on `scheduled_at < now()`, so
  // a night that is still today but whose face-off has gone is exactly as
  // dangerous as one from last week, and a date-only check cannot see it.
  const today = leagueDateKey(new Date().toISOString());
  const stale = staleDraft({
    games: (drafts ?? []).flatMap((g) =>
      g.scheduled_at ? [g.scheduled_at as string] : [],
    ),
    now: new Date().toISOString(),
  });
  // One object for both consumers. They rendered two near-identical literals
  // and one of them was already a field behind.
  const staleView: StaleNotice | null = stale && {
    firstNight: stale.firstNight,
    firstNightLabel: formatLongDate(stale.firstNight),
    passedNights: stale.passedNights,
    weeks: stale.weeks,
    shiftedLabel: formatLongDate(stale.shiftedFirstNight),
  };

  // Spacing checks — reconstruct placement (night order + slot order) from the
  // draft games so managers can verify bye/rematch/ice-time spacing.
  const spacingNights = draftDates.map((d) => ({
    date: d,
    slots: [] as string[],
  }));
  const nightIndexOf = new Map(draftDates.map((d, i) => [d, i]));
  const placed: PlacedGame[] = [];
  for (const [date, arr] of byDate) {
    if (!nightIndexOf.has(date)) continue;
    arr.forEach((g, slotIndex) => {
      placed.push({
        home: g.home_team_id,
        away: g.away_team_id,
        nightIndex: nightIndexOf.get(date)!,
        slotIndex,
      });
    });
  }
  const rawSpacing =
    placed.length > 0 ? spacingReport(placed, spacingNights, teamRows) : null;

  // ── Manager requests, checked against the draft on this page ───────────────
  //
  // Re-derived here rather than carried out of the generator, and that is
  // deliberate twice over. It survives a reload, which a returned report does
  // not; and it is decided by READING THE PLACED GAMES, which is the only
  // evidence that a pin actually shipped — later steps can move things, and
  // asking a phase whether it did what it was told would report a pin as
  // honoured whether or not it survived.
  //
  // Scope, stated so it cannot be misread: this card answers "does the draft
  // below satisfy this request?" — not "did the generator apply it?". Those come
  // apart in exactly one case, when the fallback planner wins the rank-off and
  // no constraint was ever applied; the generate action says so in its own
  // message, which is the moment that fact exists.
  const constraintNights = draftDates.map((d) => ({
    date: d,
    // Games are already in ice-time order within the night, so this index IS
    // the slot index the constraint resolves to.
    slots: (byDate.get(d) ?? []).map((g) =>
      g.scheduled_at ? leagueTimeKey(g.scheduled_at) : "--:--",
    ),
  }));
  const constraintTeamIds = enrolledTeams.map((t) => t.id);
  const resolvedConstraints = resolveConstraints(storedConstraints, {
    nights: constraintNights,
    teamIds: constraintTeamIds,
  });
  const teamSlot = new Map<string, number>();
  const teamPlays = constraintTeamIds.map(() =>
    new Array<boolean>(draftDates.length).fill(false),
  );
  const constraintTeamIndex = new Map(
    constraintTeamIds.map((id, i) => [id, i]),
  );
  for (const g of placed) {
    for (const id of [g.home, g.away]) {
      const ti = constraintTeamIndex.get(id);
      if (ti === undefined) continue;
      teamPlays[ti][g.nightIndex] = true;
      teamSlot.set(`${ti}:${g.nightIndex}`, g.slotIndex);
    }
  }
  // ⛔ `items.length`, NOT `empty` — the same distinction `assignNights` makes,
  // and this is the surface where it matters most. An all-unresolved set is
  // `empty === true` with items in it, so gating here meant the transient
  // "couldn't be met" toast was right while THIS card — the one a manager sees
  // on every later page load — silently vanished, leaving the request listed
  // in the form above with no verdict against it.
  const constraintOutcomes =
    resolvedConstraints.items.length === 0 || placed.length === 0
      ? []
      : evaluateConstraints(resolvedConstraints, {
          plays: teamPlays,
          slotOf: (t, n) => teamSlot.get(`${t}:${n}`) ?? null,
          plannerHonours: true,
        });
  // Breaches the manager's own forced byes made unavoidable, subtracted from
  // what is shown. ⛔ Presentation only — the solver's `byeRuleCost` still counts
  // every one of them, because it is also the basis of Phase P's admissible
  // lower bound and re-deriving that is not worth an even-looking table.
  const credits =
    placed.length > 0
      ? forcedByeCredits(resolvedConstraints, {
          nights: constraintNights,
          teamIds: constraintTeamIds,
          byed: (t, n) => !teamPlays[t][n],
        })
      : null;
  const spacing =
    rawSpacing && credits ? presentSpacing(rawSpacing, credits) : rawSpacing;
  const constraintNameOf = (id: string) =>
    enrolledTeams.find((t) => t.id === id)?.name ?? "A removed team";

  // Nights that run fewer games than the fullest one. Those nights drop their
  // latest slot, so it gets used on fewer nights than the earlier ones and equal
  // per-team ice-time counts stop being arithmetically reachable — no amount of
  // shuffling fixes it, so say so rather than let it read as a bug. Scoped to
  // dated nights (not `maxSlots`, which counts undated games too), and stated
  // only in terms of what the placed games show: the season's configured ice
  // slots aren't stored, so a slot left unused all season is invisible here.
  const fullestNight = Math.max(
    0,
    ...draftDates.map((d) => byDate.get(d)?.length ?? 0),
  );
  const shortNights = draftDates.filter(
    (d) => (byDate.get(d)?.length ?? 0) < fullestNight,
  ).length;
  const spareIceSlots = fullestNight * draftDates.length - placed.length;

  /*
    The same edit panel the Games page draws, over the DRAFT rows.

    ⛔ A DRAFT NEEDS THESE AS MUCH AS A PUBLISHED SCHEDULE DOES — the user asked
    for both explicitly. The actions do not care which they are working on (they
    read a season's rows, published or not), so this is the same component with a
    different source. Letting a draft drift unbalanced would only move the
    problem to publish time.
  */
  /*
    ⚠️ THE STATUS FILTER IS NOT REDUNDANT, EVEN THOUGH A DRAFT ROW IS ALWAYS
    `scheduled` TODAY. This list feeds the same panel the published page feeds,
    and that page filters `status === "scheduled"` because the write path
    refuses anything else — a row offered here but refused there fails with
    "the schedule changed while this was on screen", for a reason the message
    never gives. The invariant is real but nothing enforces it, so assert it
    where it is relied on rather than trusting a comment to stay true.
  */
  const editableDrafts: EditableGame[] = (
    (drafts ?? []) as unknown as DraftRow[]
  )
    .filter((g) => g.scheduled_at && g.status === "scheduled")
    .map((g) => ({
      id: g.id,
      label: `${g.away?.name ?? "?"} @ ${g.home?.name ?? "?"} — ${formatLongDate(g.scheduled_at!)}`,
      night: leagueDateKey(g.scheduled_at!),
      localAt: `${leagueDateKey(g.scheduled_at!)}T${leagueTimeKey(g.scheduled_at!)}`,
      homeId: g.home_team_id,
      awayId: g.away_team_id,
      homeName: g.home?.name ?? "?",
      awayName: g.away?.name ?? "?",
    }));

  return (
    <div className="space-y-6">
      {mode === "locked" ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {readFailed
                ? "This season's games couldn't be read"
                : "The season is under way"}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground space-y-2 text-sm">
            {readFailed ? (
              // Locked for a different reason, so it says a different thing. The
              // counts are unknown here, not zero, and this card is the one place
              // they were being stated as fact — "0 games are published" about a
              // season that may hold hundreds, on a season that hasn't started.
              <p>
                Something went wrong reading this season&apos;s games, so the
                builder is locked rather than acting on counts it doesn&apos;t
                have. The schedule itself is untouched — reload to try again.
              </p>
            ) : (
              <>
                <p>
                  {publish.liveCount} games are published
                  {publish.firstLiveDate
                    ? `, starting ${formatLongDate(publish.firstLiveDate)}`
                    : ""}
                  . The full schedule can no longer be regenerated or replaced.
                </p>
                <p>
                  To change a single game, use Reschedule, Postpone or Cancel on
                  that game&apos;s score page.
                </p>
                <p>
                  To slot in a tournament final or semifinals,{" "}
                  <Link
                    href={`/${league}/schedule-builder/one-off`}
                    className="text-foreground font-medium underline"
                  >
                    schedule a one-off game
                  </Link>
                  .
                </p>
                {/*
                  ⛔ THIS IS THE MODE REPAIR EXISTS FOR. A started season can no
                  longer be regenerated, so rearranging the nights still to come
                  — pinning a team to an ice time, or putting the ice-time share
                  back after a run of manual reschedules — is the only lever
                  left. The card used to offer per-game edits and the one-off
                  planner and stop there.
                */}
                <p>
                  To put a team on a particular night or ice time, or to even
                  out the nights still to come,{" "}
                  <Link
                    href={`/${league}/schedule-builder/repair`}
                    className="text-foreground font-medium underline"
                  >
                    repair the schedule
                  </Link>
                  .
                </p>
              </>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Generate a balanced schedule
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ScheduleGenerateForm
                /*
                  ⛔ PUBLISH IS THE OTHER HALF OF "generate keeps my fields".
                  The form now holds everything it was given across a generate
                  (see its `onSubmit`), which is right while the manager is still
                  iterating and wrong the moment they publish: publishing ends
                  the setup, and the next thing done here is a different season's
                  schedule. Remounting on a new key is what returns the inputs to
                  their `defaultValue`s and empties the skip chips — the same
                  trick RemoveControls and PublishControls below already use.

                  ⚠️ Keyed on the LIVE schedule, never on `draftCount`.
                  `draftCount` also moves on a generate (0 → N), so keying on it
                  would remount on exactly the submit this whole change exists to
                  survive. `liveScheduleKey` moves only when the published games
                  are replaced — see its note in queries/schedule.ts.
                */
                key={publish.liveScheduleKey}
                seasonId={seasonId}
                seasonStart={season?.starts_on ?? null}
                seasonEnd={season?.ends_on ?? null}
                teams={enrolledTeams.map((t) => ({ id: t.id, name: t.name }))}
                constraints={storedConstraints}
                // Read here rather than in the form: the generator's budget
                // constants are server-side, and the form is a client
                // component.
                expectedMs={estimatedGenerateMs()}
              />
            </CardContent>
          </Card>

          <p className="text-muted-foreground text-sm">
            Adding a tournament final or semifinals mid-season is a different
            job — it takes over a game on a night that&apos;s already scheduled
            and repairs the rest of the season around it.{" "}
            <Link
              href={`/${league}/schedule-builder/one-off`}
              className="text-foreground font-medium underline"
            >
              Schedule a one-off game
            </Link>
            .
          </p>

          {/*
            Rendered in replace mode too, not just published. A manager about to
            replace a schedule needs the schedule they are replacing on the page;
            suppressing it here left the button label as the only evidence it
            existed. A container rather than a bare paragraph because this block
            holds everything about the live schedule — the count, the guidance,
            and the control that removes it.
          */}
          {mode === "published" || mode === "replace" ? (
            <div className="text-muted-foreground space-y-2 text-sm">
              <p>
                <span className="text-foreground font-medium">
                  Published: {publish.liveCount} games
                </span>
                {publish.firstLiveDate && publish.lastLiveDate
                  ? ` · ${formatLongDate(publish.firstLiveDate)} → ${formatLongDate(publish.lastLiveDate)}`
                  : ""}
              </p>
              {/*
                Only in published mode. In replace mode a draft already exists
                and the Replace button is on screen, so telling the manager to
                generate one would describe a step they have already taken.
              */}
              {mode === "published" ? (
                <>
                  <p>
                    To change the schedule, generate a new one above —
                    you&apos;ll be asked to confirm before it replaces this one.
                  </p>
                  {/*
                    Published mode only, sharing the guidance's branch: both
                    speak to a season holding a live schedule and no draft. In
                    replace mode the manager already has a replacement, and the
                    remove dialog's wording would be wrong there — see the
                    component's own comment.

                    Keyed on liveCount so the derived dialog-open state in
                    RemoveControls stays correct by construction: a successful
                    removal takes liveCount to 0, remounting under a fresh key.
                  */}
                  <RemoveControls
                    key={publish.liveCount}
                    seasonId={seasonId}
                    lineupsAtRisk={publish.lineupsAtRisk}
                  />
                </>
              ) : null}
            </div>
          ) : null}
        </>
      )}

      {/*
        The live-schedule tools. Rendered in EVERY mode that has published games
        — `locked` above all, since that is the mode they exist for: once
        `season_is_started` trips, generate, replace and remove are gone for
        good and this is the only way left to change a night. `readFailed` hides
        them because the night list behind them would be empty for the same
        reason the counts are unknown, and an empty picker reads as "nothing to
        move" rather than "we couldn't look".
      */}
      {publish.liveCount > 0 && !readFailed ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Move a game night</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <RescheduleNightForm
              seasonId={seasonId}
              nights={openNights.map((n) => ({
                date: n.date,
                games: n.games.length,
              }))}
              // Computed here, on the server, in the league's zone — see the
              // prop's own note for why the browser's clock will not do.
              minDate={today}
              maxDate={season?.ends_on ?? null}
            />
            {/*
              ⚠️ Suppressed in locked mode, where the card above already carries
              this link inside the sentence that explains what a started season
              can still be changed. Two identical links a few elements apart read
              as a seam rather than as emphasis — the same call the "generate a
              new one above" guidance makes below.
            */}
            {mode === "locked" ? null : (
              <p className="text-muted-foreground text-sm">
                To put a team on a particular night or ice time, or to even out
                the nights still to come,{" "}
                <Link
                  href={`/${league}/schedule-builder/repair`}
                  className="text-foreground font-medium underline"
                >
                  repair the schedule
                </Link>
                .
              </p>
            )}
          </CardContent>
        </Card>
      ) : null}

      {!hasDraft ? (
        // Not on a locked season. This section keys off the draft count alone,
        // which is independent of `mode`, so a started season with no draft
        // rendered "Generate one above" directly beneath a locked card that has
        // no generate form in it — pointing the manager at something that isn't
        // on the page. Same leak as the publish-control gate below, in the
        // other branch. The locked card already says what can be done instead.
        mode === "locked" ? null : (
          <EmptyState
            title="No draft schedule"
            // Suppressed in published mode, where the block above already says
            // "generate a new one above" as part of explaining how to replace.
            // Two copies of the same instruction, a few elements apart, read as
            // a seam rather than as emphasis. The card itself stays: it still
            // tells the manager there is nothing staged to preview.
            description={
              mode === "published"
                ? undefined
                : "Generate one above to preview it here before publishing."
            }
          />
        )
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            {mode === "locked" ? null : (
              <PublishControls
                // A successful publish/replace flips every draft to live, so
                // draftCount drops to 0 and this remounts under a fresh key —
                // that's what lets `dialogOpen` below be derived from `state`
                // instead of reset by hand. Without the key, a future caller
                // that keeps this component mounted across a success (e.g. by
                // rendering it in "published" mode too) would find the trigger
                // permanently inert: see the comment on `dialogOpen` in
                // publish-controls.tsx.
                //
                // ⛔ THE STALE NIGHT IS NOT IN THIS KEY, AND MUST NOT BE. It was
                // for one revision, to close a dialog left open over a warning
                // that had stopped being true — and it silently broke the
                // refusal message: `publishSchedule` refusing an unacknowledged
                // stale publish revalidates, `stale` goes from null to a night,
                // the key changes, and the component remounts before the
                // `useEffect` that toasts the refusal ever runs. The manager
                // saw the page change and no sentence saying why. The
                // non-destructive dialog closes anyway (the render forks back
                // to a plain button once `stale` is null); a replace dialog
                // stays open showing its ordinary replace copy, which is
                // correct, just not closed.
                key={publish.draftCount}
                seasonId={seasonId}
                draftCount={publish.draftCount}
                liveCount={publish.liveCount}
                // Formatted here rather than in the dialog. The confirm dialog
                // is how a manager checks *which* schedule is about to be
                // deleted, and it was the only place in this panel still
                // showing a raw ISO date — the format nothing else in the app
                // uses, on the one screen that destroys data.
                liveRange={
                  publish.firstLiveDate && publish.lastLiveDate
                    ? `${formatLongDate(publish.firstLiveDate)} – ${formatLongDate(publish.lastLiveDate)}`
                    : null
                }
                lineupsAtRisk={publish.lineupsAtRisk}
                destructive={mode === "replace"}
                stale={staleView}
              />
            )}
            <form action={discardSchedule}>
              <input type="hidden" name="season_id" value={seasonId} />
              <Button type="submit" variant="outline">
                Discard draft
              </Button>
            </form>
          </div>

          <p className="text-muted-foreground text-sm">
            <span className="text-foreground font-medium">
              {gamesPerTeamLabel} games per team
            </span>{" "}
            · {drafts!.length} games ·{" "}
            {firstDate ? formatLongDate(firstDate) : "?"} →{" "}
            {lastDate ? formatLongDate(lastDate) : "?"}
          </p>

          {/*
            ⚠️ RENDERED WHETHER OR NOT THE DRAFT IS STALE, and gated only on the
            mode. `StaleDraftNotice` returns null when there is nothing to warn
            about, and it has to be the one deciding that: a component mounted
            only while stale unmounts in the same commit its own success lands
            in, and the toast confirming the move is lost with it — the race
            `28-schedule-form-state.spec.ts` records for the publish toast.

            The mode gate is safe to leave here because moving a draft cannot
            change the mode. Not on a locked season, for the reason the publish
            controls are not: a started season can neither publish this draft
            nor move it, so the warning would be about a decision nobody can
            take and the button under it would refuse every click.
          */}
          {mode === "locked" ? null : (
            // Formatted by the panel for the same reason `liveRange` is: the
            // dates a manager checks a decision against are the panel's to
            // render, and neither component does date work of its own.
            <StaleDraftNotice seasonId={seasonId} stale={staleView} />
          )}

          {scheduleIncomplete ? (
            <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-lg border px-3 py-2 text-sm">
              ⚠ This draft doesn&apos;t cover every team evenly — some matchups
              didn&apos;t fit the date range and ice times. Widen the dates, add
              game nights or ice slots, then regenerate.
            </div>
          ) : null}

          {overrunsSeason ? (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
              ⚠ The regular season runs past the season&apos;s end date (
              {formatLongDate(season!.ends_on!)}), leaving no room for playoffs.
              Shorten it (fewer games per team or an earlier end date) or extend
              the season.
            </div>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Balance report</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-hidden rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/40">
                      <TableHead>Team</TableHead>
                      <TableHead className="text-center">GP</TableHead>
                      <TableHead className="text-center">Home</TableHead>
                      <TableHead className="text-center">Away</TableHead>
                      {Array.from({ length: maxSlots }, (_, i) => (
                        <TableHead key={`slot-${i}`} className="text-center">
                          Slot {i + 1}
                        </TableHead>
                      ))}
                      {usedWeekdays.map((d) => (
                        <TableHead key={`wd-${d}`} className="text-center">
                          {WEEKDAY_SHORT[d]}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {teamRows.map((tid) => (
                      <TableRow key={tid}>
                        <TableCell className="font-medium">
                          {nameOf.get(tid)}
                        </TableCell>
                        <TableCell className="text-center">
                          {gp.get(tid) ?? 0}
                        </TableCell>
                        <TableCell className="text-center">
                          {homeC.get(tid) ?? 0}
                        </TableCell>
                        <TableCell className="text-center">
                          {awayC.get(tid) ?? 0}
                        </TableCell>
                        {Array.from({ length: maxSlots }, (_, i) => (
                          <TableCell
                            key={`slot-${i}`}
                            className="text-muted-foreground text-center"
                          >
                            {slot.get(tid)?.[i] ?? 0}
                          </TableCell>
                        ))}
                        {usedWeekdays.map((d, i) => (
                          <TableCell
                            key={`wd-${d}`}
                            className="text-muted-foreground text-center"
                          >
                            {nightCat.get(tid)?.[i] ?? 0}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <p className="text-muted-foreground mt-2 text-xs">
                GP is equal across teams, and each team&apos;s games are spread
                as evenly as possible across the ice-time (Slot) and
                night-of-week columns — in tightly-constrained schedules a team
                may differ by one game. Any uneven ice time is biased toward the
                earlier (Slot 1) times, so no team gets stuck with the latest
                slot more than others.
              </p>
              {shortNights > 0 ? (
                <p className="text-muted-foreground mt-2 text-xs">
                  {shortNights} of {draftDates.length} nights run fewer games
                  than the fullest night, leaving {spareIceSlots} ice slot
                  {spareIceSlots === 1 ? "" : "s"} unused — so the latest time
                  runs on fewer nights than the earlier ones. Equal ice-time
                  counts are only reachable when every night is equally full, so
                  a difference of one game here is expected rather than a
                  scheduling fault. Adding or removing a game night is what
                  evens it out.
                </p>
              ) : null}
            </CardContent>
          </Card>

          {constraintOutcomes.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Manager requests</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-1.5 text-sm">
                  {constraintOutcomes.map((o) => {
                    const source = storedConstraints.find((c) => c.id === o.id);
                    return (
                      <li key={o.id} className="flex items-start gap-2">
                        <span
                          className={
                            o.satisfied
                              ? "text-emerald-600 dark:text-emerald-400"
                              : "text-amber-600 dark:text-amber-400"
                          }
                        >
                          {o.satisfied ? "✓" : "✗"}
                        </span>
                        <span className="text-muted-foreground">
                          {source
                            ? describeConstraint(
                                source,
                                constraintNameOf(o.teamId),
                              )
                            : o.kind}
                          {o.reason ? ` — ${o.reason}` : ""}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <p className="text-muted-foreground mt-2 text-xs">
                  Checked against the draft on this page, not against what the
                  generator was asked to do — a request only counts as met if
                  the games below actually show it. Requests are best effort: an
                  even schedule comes first, so a request can be declined rather
                  than bought with an unbalanced season.
                </p>
              </CardContent>
            </Card>
          ) : null}

          {spacing ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Spacing checks</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="grid gap-1.5 text-sm sm:grid-cols-2">
                  {(
                    [
                      [
                        "Weeks a team misses 2+ game nights",
                        spacing.byesMultiWeek,
                      ],
                      [
                        "Teams byeing two weeks in a row",
                        spacing.byesConsecWeek,
                      ],
                      ["…on the same weekday", spacing.byesConsecWeekSameDay],
                      ["Same opponents in one week", spacing.rematchSameWeek],
                      [
                        "Same opponents back-to-back nights",
                        spacing.rematchAdjNight,
                      ],
                      [
                        "Teams byeing back-to-back game nights",
                        spacing.byesAdjNight,
                      ],
                      [
                        "Same opponents in consecutive weeks",
                        spacing.rematchConsecWeek,
                      ],
                      // The count, not `pairingWeekdayExcess` — that one is a
                      // squared-deviation score for the search to rank on, reads
                      // 8 where 2 matchups are off, and is not always a whole
                      // number. Every other row here is a count of things.
                      [
                        "Matchups off an even weekday split",
                        spacing.pairingsOffWeekdaySplit,
                      ],
                      [
                        "Uneven ice time within a night of the week",
                        spacing.slotWeekdaySpread,
                      ],
                      [
                        "Three games in a row in one ice time",
                        spacing.slotStreak3,
                      ],
                      // Above back-to-back on purpose: that is the order
                      // variation selection uses, and it is the metric a
                      // manager actually complains about — "the same ice time
                      // three times in five weeks".
                      [
                        "Five-game stretches with three in one ice time",
                        spacing.slotClusterWindows,
                      ],
                      [
                        "…the worst-affected team's share of those",
                        spacing.slotClusterWorstTeam,
                      ],
                      [
                        "Back-to-back games in the same ice time",
                        spacing.slotConsecutive,
                      ],
                    ] as const
                  ).map(([label, count]) => (
                    <li key={label} className="flex items-center gap-2">
                      <span
                        className={
                          count === 0
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-amber-600 dark:text-amber-400"
                        }
                      >
                        {count === 0 ? "✓" : count}
                      </span>
                      <span className="text-muted-foreground">{label}</span>
                    </li>
                  ))}
                </ul>
                {credits &&
                (credits.byesMultiWeek ||
                  credits.byesConsecWeek ||
                  credits.byesConsecWeekSameDay ||
                  credits.byesAdjNight) ? (
                  <p className="text-muted-foreground mt-2 text-xs">
                    Bye counts above exclude breaches your own forced byes made
                    unavoidable — a whole week off is two byes in one week by
                    definition, so it is not counted against the schedule.
                  </p>
                ) : null}
                <p className="text-muted-foreground mt-2 text-xs">
                  Byes and repeated matchups are minimized after an even
                  schedule is fixed. Some are unavoidable when there are fewer
                  ice slots than half the teams (so not everyone plays every
                  night) — add ice times or game nights to drive these to zero.
                </p>
                {spacing.longestLayoffDays !== null ? (
                  <p className="text-muted-foreground mt-2 text-xs">
                    Longest stretch without a game, for any team:{" "}
                    <span className="font-medium">
                      {spacing.longestLayoffDays} days
                    </span>
                    . Unlike the checks above, zero is not the goal here — a
                    long stretch is usually the calendar rather than the
                    schedule, since a holiday break sets a floor no arrangement
                    of games can go under. It is measured over draft nights
                    only, so a partly published season reports a shorter gap
                    than players will see.
                  </p>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          <div className="space-y-6">
            {[...byDate.entries()].map(([date, arr]) => (
              <section key={date} className="space-y-2">
                <h3 className="text-muted-foreground text-sm font-semibold">
                  {formatLongDate(date)}
                </h3>
                <div className="space-y-1">
                  {arr.map((g) => (
                    <div
                      key={g.id}
                      className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm"
                    >
                      <span className="text-muted-foreground w-16 text-xs">
                        {formatGameTime(g.scheduled_at)}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <TeamLogo
                          name={g.away?.name ?? ""}
                          color={g.away?.color}
                          logoPath={g.away?.logo_path}
                          textColor={g.away?.logo_text_color}
                        />
                        {g.away?.name}
                        <span className="text-muted-foreground mx-1">@</span>
                        <TeamLogo
                          name={g.home?.name ?? ""}
                          color={g.home?.color}
                          logoPath={g.home?.logo_path}
                          textColor={g.home?.logo_text_color}
                        />
                        {g.home?.name}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>

          {/*
            Adjust the draft before it goes live. Same component, same rules as
            the Games page — a draft that drifts unbalanced would just carry the
            problem across the publish.
          */}
          <ScheduleEditPanel
            games={editableDrafts}
            teams={enrolledTeams.map((t: { id: string; name: string }) => ({
              id: t.id,
              name: t.name,
            }))}
          />
        </>
      )}
    </div>
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */
