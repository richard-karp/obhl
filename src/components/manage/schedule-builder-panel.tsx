import Link from "next/link";
import { createAdminClient } from "@/utils/supabase/admin";
import { discardSchedule } from "@/lib/actions/schedule";
import {
  needsActivation,
  type SeasonStamp,
} from "@/lib/schedule/activationNotice";
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
// ⚠️ Keep the hidden `season_id` on these forms: it stops them targeting whatever season is active.

/** Typed, not `any`: the loose join types are what let a missing `status` column go unnoticed. */
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
  isActive,
  thisSeason,
  activeSeason,
  activeSeasonReadFailed,
}: {
  seasonId: string;
  league: string;
  /**
   * ⚠️ A prop, not a read here: this panel's own season read discards its error,
   * so a failed read would claim "nobody can see these games" on an active season.
   */
  isActive: boolean;
  thisSeason: SeasonStamp;
  /** The league's active season, or null when it has none. */
  activeSeason: SeasonStamp | null;
  activeSeasonReadFailed: boolean;
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

  // ⚠️ In parallel: neither depends on the other, on the slowest page in the manage area. The nights are
  // read even with no live schedule, since they come back empty.
  const [storedConstraints, seasonNights] = await Promise.all([
    getScheduleConstraints(seasonId, { client: admin }),
    getSeasonNights(seasonId, { client: admin }),
  ]);
  const openNights = seasonNights.nights.filter((n) => !n.locked);

  // The draft read fails closed like getPublishState's: an errored read coerces to [], which reads as "no
  // draft" and offers a generate that throws away a draft the manager can't see.
  const readFailed = publish.readFailed || !!draftsError;
  if (draftsError) console.error("draft read failed:", draftsError.message);

  // `!!draftsError`, not `readFailed`: getPublishState already forces `started` when its own reads fail.
  const mode = publishMode({
    ...publish,
    started: publish.started || !!draftsError,
  });

  // getPublishState's exact count, not the row list: only the count fails closed, and a failed list read
  // drew Discard over rows nobody had read.
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

  // ⛔ A draft ages: generate checks the first night only when the draft is made, so a later publish can start
  // the season in the past and lock it. ⚠️ Games, not nights: the lock fires on `scheduled_at < now()`.
  const today = leagueDateKey(new Date().toISOString());
  const stale = staleDraft({
    games: (drafts ?? []).flatMap((g) =>
      g.scheduled_at ? [g.scheduled_at as string] : [],
    ),
    now: new Date().toISOString(),
  });
  // One object for both consumers, so the banner and the dialog cannot drift.
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

  // Below three ice times a five-game window must hold three of one, so `slotClusterWorstTeam` cannot reach
  // zero; the caption says so rather than suggest more game nights, which would raise it.
  const slotCount = placed.reduce((m, g) => Math.max(m, g.slotIndex + 1), 0);

  // Requests are judged by reading the placed games, never from what a phase was asked to do
  // (`RUNBOOK.md` → Schedule generator); it also survives a reload.
  const constraintNights = draftDates.map((d) => ({
    date: d,
    // Games are in ice-time order within the night, so this index is the slot index.
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
  // ⛔ `items.length`, not `empty`: an all-unresolved set is `empty` with items in it, and gating on `empty`
  // hid this card, leaving a listed request with no verdict.
  const constraintOutcomes =
    resolvedConstraints.items.length === 0 || placed.length === 0
      ? []
      : evaluateConstraints(resolvedConstraints, {
          plays: teamPlays,
          slotOf: (t, n) => teamSlot.get(`${t}:${n}`) ?? null,
          plannerHonours: true,
        });
  // Breaches the manager's forced byes made unavoidable, subtracted for display. ⛔ Presentation only:
  // `byeRuleCost` still counts them, as Phase P's admissible bound (`RUNBOOK.md` → Schedule generator).
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

  // A night short of the fullest drops its latest slot, so equal ice-time counts become unreachable: say so.
  // Dated nights only; configured slots aren't stored, so one unused all season is invisible here.
  const fullestNight = Math.max(
    0,
    ...draftDates.map((d) => byDate.get(d)?.length ?? 0),
  );
  const shortNights = draftDates.filter(
    (d) => (byDate.get(d)?.length ?? 0) < fullestNight,
  ).length;
  const spareIceSlots = fullestNight * draftDates.length - placed.length;

  // ⛔ A draft needs the edit panel as much as a published schedule. ⚠️ The status filter is not redundant:
  // the write path refuses anything but `scheduled`, so assert it where it is relied on.
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
      {/* ⚠️ Above the `mode === "locked"` fork: a started season that isn't
          active is the worst case, and inside the fork it would never show. */}
      {needsActivation({
        isActive,
        liveCount: publish.liveCount,
        // `publish.readFailed`, not the panel-wide one: a failed draft read
        // leaves the published count accurate.
        readFailed: publish.readFailed || activeSeasonReadFailed,
        thisSeason,
        activeSeason,
      }) ? (
        <div className="space-y-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
          <p className="font-semibold">
            ⚠ These games aren&apos;t on the public site yet
          </p>
          {/* Team calendar feeds span every season, so they already show these games. */}
          <p>
            The schedule is published, but this isn&apos;t the league&apos;s
            active season, and the public schedule and standings show only the
            active one. Use Set active at the top of this page when you&apos;re
            ready. Team calendar subscriptions already include these games.
          </p>
        </div>
      ) : null}

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
              // Locked for a different reason: the counts are unknown here, not zero.
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
                    href={`/${league}/schedule/one-off`}
                    className="text-foreground font-medium underline"
                  >
                    schedule a one-off game
                  </Link>
                  .
                </p>
                {/*
                  ⛔ The mode repair exists for: a started season can't be regenerated, so this is the lever left.
                */}
                <p>
                  To put a team on a particular night or ice time, or to even
                  out the nights still to come,{" "}
                  <Link
                    href={`/${league}/schedule/repair`}
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
                /* ⛔ Remounting on a new key after a publish is what resets the form's kept fields. ⚠️ Keyed on
                   the live schedule, never `draftCount`, which also moves on a generate. */
                key={publish.liveScheduleKey}
                seasonId={seasonId}
                seasonStart={season?.starts_on ?? null}
                seasonEnd={season?.ends_on ?? null}
                teams={enrolledTeams.map((t) => ({ id: t.id, name: t.name }))}
                constraints={storedConstraints}
                // Read here: the budget constants are server-side, and the form is a client component.
                expectedMs={estimatedGenerateMs()}
              />
            </CardContent>
          </Card>

          <p className="text-muted-foreground text-sm">
            Adding a tournament final or semifinals mid-season is a different
            job — it takes over a game on a night that&apos;s already scheduled
            and repairs the rest of the season around it.{" "}
            <Link
              href={`/${league}/schedule/one-off`}
              className="text-foreground font-medium underline"
            >
              Schedule a one-off game
            </Link>
            .
          </p>

          {/*
            In replace mode too: a manager about to replace a schedule needs it on the page.
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
                Published mode only: in replace mode a draft and its Replace button already exist.
              */}
              {mode === "published" ? (
                <>
                  <p>
                    To change the schedule, generate a new one above —
                    you&apos;ll be asked to confirm before it replaces this one.
                  </p>
                  {/*
                    Published mode only: the remove dialog's wording is wrong beside a draft. Keyed on
                    liveCount, so a successful removal remounts it and its derived dialog state holds.
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
        In every mode with published games, `locked` above all. Hidden on `readFailed`: an empty picker would
        read as "nothing to move" rather than "we couldn't look".
        ⛔ `readFailed` is NOT the read that fills this picker — it covers the publish and draft reads,
        so the one failure that empties the picker went straight through the line above. That case is
        handled inside the card rather than by hiding it: `seasonNights.readFailed` says so in words,
        because a card that vanishes is itself a kind of silent empty. Same wording on the public
        schedule page, which hosts the other copy of this control.
      */}
      {publish.liveCount > 0 && !readFailed ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Move a game night</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {seasonNights.readFailed ? (
              <p className="text-muted-foreground text-sm">
                Couldn&apos;t read this season&apos;s game nights, so there is
                nothing to offer here — this isn&apos;t the same as having no
                night left to move. Reload, and try again.
              </p>
            ) : (
              <RescheduleNightForm
                seasonId={seasonId}
                nights={openNights.map((n) => ({
                  date: n.date,
                  games: n.games.length,
                }))}
                // Server-side in the league's zone: the browser's clock is a day off for anyone travelling.
                minDate={today}
                maxDate={season?.ends_on ?? null}
              />
            )}
            {/*
              ⚠️ Not in locked mode, whose card already carries this link: two identical links read as a seam.
            */}
            {mode === "locked" ? null : (
              <p className="text-muted-foreground text-sm">
                To put a team on a particular night or ice time, or to even out
                the nights still to come,{" "}
                <Link
                  href={`/${league}/schedule/repair`}
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
        // Not on a locked season: its card has no generate form for "Generate one above" to point at.
        mode === "locked" ? null : (
          <EmptyState
            title="No draft schedule"
            // Not in published mode, where the block above already says it.
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
                // Keyed on draftCount: a success remounts this, which its derived `dialogOpen` relies on.
                // ⛔ Never add the stale night to the key: the remount swallows the refusal toast.
                key={publish.draftCount}
                seasonId={seasonId}
                draftCount={publish.draftCount}
                liveCount={publish.liveCount}
                // Formatted here: the dialog is where a manager checks which schedule is about to be deleted.
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
            ⚠️ Rendered whether or not stale: it decides itself, or it unmounts before its success toast. Not on
            a locked season, where nobody can publish or move the draft.
          */}
          {mode === "locked" ? null : (
            // Formatted by the panel, like `liveRange`.
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
                      // The count, not `pairingWeekdayExcess`, a squared-deviation score: every row here is a count.
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
                <p className="text-muted-foreground mt-2 text-xs">
                  Worst team&rsquo;s repeated ice times:{" "}
                  <span className="font-medium">
                    {spacing.slotClusterWorstTeam}
                  </span>{" "}
                  {spacing.slotClusterWorstTeam === 1 ? "stretch" : "stretches"}{" "}
                  of five games with the same ice time three or more times.
                  Counted per stretch rather than per game, and reported for the
                  single worst-off team rather than the league &mdash; this is
                  the complaint a manager brings, and it lands on one team
                  rather than spreading. The league carries{" "}
                  <span className="font-medium">
                    {spacing.slotClusterWindows}
                  </span>{" "}
                  in total: the closer that is to the figure above, the more of
                  it one team is absorbing, and a total that rises while the
                  worst-team figure falls is the schedule spreading the load
                  rather than getting worse.
                  {slotCount > 0 && slotCount < 3 ? (
                    <>
                      {" "}
                      With only {slotCount}{" "}
                      {slotCount === 1 ? "ice time" : "ice times"}, any five
                      games must put three in one of them, so this cannot reach
                      zero at all &mdash; and adding game nights raises it.
                      Adding a third ice time is what makes it improvable.
                    </>
                  ) : null}
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
            Adjust the draft before it goes live, with the same component and rules as the Games page.
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
