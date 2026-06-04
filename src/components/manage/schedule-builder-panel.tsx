import { createAdminClient } from "@/utils/supabase/admin";
import {
  generateSchedule,
  publishSchedule,
  discardSchedule,
} from "@/lib/actions/schedule";
import { getEnrolledTeams } from "@/lib/queries/teams";
import { weekdayOf } from "@/lib/schedule/assignNights";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TeamLogo } from "@/components/shared/team-logo";
import { EmptyState } from "@/components/shared/empty-state";
import { ScheduleFinalForm } from "@/components/manage/schedule-final-form";
import { formatLongDate, formatGameTime, leagueDateKey } from "@/lib/format";

const WEEKDAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Schedule builder scoped to a specific season — the forms carry a hidden
 * season_id so they target this season, not whatever is currently active. Used
 * by the season setup hub and by the standalone /schedule-builder (active season).
 */
export async function ScheduleBuilderPanel({ seasonId }: { seasonId: string }) {
  const admin = createAdminClient();

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

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Generate a balanced schedule</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={generateSchedule} className="grid gap-4 sm:grid-cols-4 sm:items-end">
            <input type="hidden" name="season_id" value={seasonId} />
            <div className="space-y-1">
              <Label htmlFor="start_date">First game night</Label>
              <Input id="start_date" name="start_date" type="date" required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="end_date">Last game night</Label>
              <Input id="end_date" name="end_date" type="date" required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cycles">Round-robin cycles</Label>
              <select
                id="cycles"
                name="cycles"
                defaultValue="1"
                className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
              >
                <option value="1">Single (play each once)</option>
                <option value="2">Double (home & away)</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="slot_times">Ice-time slots</Label>
              <Input id="slot_times" name="slot_times" defaultValue="19:00, 20:15, 21:30" />
            </div>

            <div className="space-y-1.5 sm:col-span-4">
              <Label>Game nights</Label>
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAYS.map((d) => (
                  <label
                    key={d.value}
                    className="border-input has-[:checked]:bg-secondary has-[:checked]:border-secondary-foreground/30 flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm font-medium select-none"
                  >
                    <input type="checkbox" name="weekdays" value={d.value} />
                    {d.label}
                  </label>
                ))}
              </div>
              <p className="text-muted-foreground text-xs">
                Pick one or more nights per week. Each team gets a balanced share
                of each night and each ice time.
              </p>
            </div>

            <div className="space-y-1 sm:col-span-4">
              <Label htmlFor="excluded_dates">Weeks off / skip dates</Label>
              <Input
                id="excluded_dates"
                name="excluded_dates"
                placeholder="2026-05-26, 2026-07-03"
              />
              <p className="text-muted-foreground text-xs">
                Optional. Comma-separated dates to skip (holidays, breaks).
              </p>
            </div>

            <div className="sm:col-span-4">
              <Button type="submit">Generate draft</Button>
              <span className="text-muted-foreground ml-3 text-xs">
                Replaces any existing draft. Review below, then publish.
              </span>
            </div>
          </form>
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

          {scheduleIncomplete ? (
            <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-lg border px-3 py-2 text-sm">
              ⚠ This draft doesn&apos;t cover every team evenly — some matchups
              didn&apos;t fit the date range and ice times. Widen the dates, add
              game nights or ice slots, then regenerate.
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
                GP should be equal across teams and the Slot columns evenly
                spread. Night-of-week balance is automatic when there are at least
                as many ice slots as games per night (teams ÷ 2); with fewer
                slots, check the night columns here.
              </p>
            </CardContent>
          </Card>

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
