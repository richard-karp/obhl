import { createAdminClient } from "@/utils/supabase/admin";
import { publishSchedule, discardSchedule } from "@/lib/actions/schedule";
import { getEnrolledTeams } from "@/lib/queries/teams";
import { weekdayOf } from "@/lib/schedule/assignNights";
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
import { ScheduleFinalForm } from "@/components/manage/schedule-final-form";
import { ScheduleGenerateForm } from "@/components/manage/schedule-generate-form";
import { formatLongDate, formatGameTime, leagueDateKey } from "@/lib/format";

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Schedule builder scoped to a specific season — the forms carry a hidden
 * season_id so they target this season, not whatever is currently active. Used
 * by the season setup hub and by the standalone /schedule-builder (active season).
 */
export async function ScheduleBuilderPanel({ seasonId }: { seasonId: string }) {
  const admin = createAdminClient();

  const { data: season } = await admin
    .from("seasons")
    .select("starts_on, ends_on")
    .eq("id", seasonId)
    .maybeSingle();

  const { data: drafts } = await admin
    .from("games")
    .select(
      `id, scheduled_at, round, home_team_id, away_team_id,
       home:teams!games_home_team_id_fkey(name, color),
       away:teams!games_away_team_id_fkey(name, color)`,
    )
    .eq("season_id", seasonId)
    .eq("is_draft", true)
    .order("scheduled_at", { ascending: true });

  const enrolledTeams = await getEnrolledTeams(seasonId);

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
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

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

  // Spacing checks — reconstruct placement (night order + slot order) from the
  // draft games so managers can verify bye/rematch/ice-time spacing.
  const spacingNights = draftDates.map((d) => ({ date: d, slots: [] as string[] }));
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
  const spacing =
    placed.length > 0 ? spacingReport(placed, spacingNights, teamRows) : null;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Generate a balanced schedule</CardTitle>
        </CardHeader>
        <CardContent>
          <ScheduleGenerateForm
            seasonId={seasonId}
            seasonStart={season?.starts_on ?? null}
            seasonEnd={season?.ends_on ?? null}
            teamCount={enrolledCount}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Schedule a one-off game (tournament final / semifinals)
          </CardTitle>
        </CardHeader>
        <CardContent>
          {enrolledTeams.length < 2 ? (
            <EmptyState title="Enroll teams first" />
          ) : (
            <ScheduleFinalForm
              seasonId={seasonId}
              teams={enrolledTeams.map((t) => ({ id: t.id, name: t.name }))}
            />
          )}
        </CardContent>
      </Card>

      {(drafts ?? []).length === 0 ? (
        <EmptyState
          title="No draft schedule"
          description="Generate one above to preview it here before publishing."
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <form action={publishSchedule}>
              <input type="hidden" name="season_id" value={seasonId} />
              <Button type="submit">Publish {drafts!.length} games</Button>
            </form>
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

          {scheduleIncomplete ? (
            <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-lg border px-3 py-2 text-sm">
              ⚠ This draft doesn&apos;t cover every team evenly — some matchups
              didn&apos;t fit the date range and ice times. Widen the dates, add
              game nights or ice slots, then regenerate.
            </div>
          ) : null}

          {overrunsSeason ? (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
              ⚠ The regular season runs past the season&apos;s end date
              ({formatLongDate(season!.ends_on!)}), leaving no room for playoffs.
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
                        <TableCell className="font-medium">{nameOf.get(tid)}</TableCell>
                        <TableCell className="text-center">{gp.get(tid) ?? 0}</TableCell>
                        <TableCell className="text-center">{homeC.get(tid) ?? 0}</TableCell>
                        <TableCell className="text-center">{awayC.get(tid) ?? 0}</TableCell>
                        {Array.from({ length: maxSlots }, (_, i) => (
                          <TableCell key={`slot-${i}`} className="text-muted-foreground text-center">
                            {slot.get(tid)?.[i] ?? 0}
                          </TableCell>
                        ))}
                        {usedWeekdays.map((d, i) => (
                          <TableCell key={`wd-${d}`} className="text-muted-foreground text-center">
                            {nightCat.get(tid)?.[i] ?? 0}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <p className="text-muted-foreground mt-2 text-xs">
                GP is equal across teams, and each team&apos;s games are spread as
                evenly as possible across the ice-time (Slot) and night-of-week
                columns — in tightly-constrained schedules a team may differ by one
                game. Any uneven ice time is biased toward the earlier (Slot 1)
                times, so no team gets stuck with the latest slot more than others.
              </p>
            </CardContent>
          </Card>

          {spacing ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Spacing checks</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="grid gap-1.5 text-sm sm:grid-cols-2">
                  {(
                    [
                      ["Weeks a team misses every game night", spacing.byesMultiWeek],
                      ["Teams byeing two weeks in a row", spacing.byesConsecWeek],
                      ["…on the same weekday", spacing.byesConsecWeekSameDay],
                      ["Same opponents in one week", spacing.rematchSameWeek],
                      ["Same opponents back-to-back nights", spacing.rematchAdjNight],
                      ["Same opponents in consecutive weeks", spacing.rematchConsecWeek],
                      ["Back-to-back games in the same ice time", spacing.slotConsecutive],
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
                <p className="text-muted-foreground mt-2 text-xs">
                  Byes and repeated matchups are minimized after an even schedule
                  is fixed. Some are unavoidable when there are fewer ice slots
                  than half the teams (so not everyone plays every night) — add ice
                  times or game nights to drive these to zero.
                </p>
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
                        <TeamLogo name={g.away?.name ?? ""} color={g.away?.color} />
                        {g.away?.name}
                        <span className="text-muted-foreground mx-1">@</span>
                        <TeamLogo name={g.home?.name ?? ""} color={g.home?.color} />
                        {g.home?.name}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */
