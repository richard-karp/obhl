import Link from "next/link";
import { requireManager } from "@/lib/auth/guards";
import { createAdminClient } from "@/utils/supabase/admin";
import { resolveCurrentLeague } from "@/lib/league/current";
import { setActiveSeason } from "@/lib/actions/seasons";
import { CreateSeasonForm } from "@/components/manage/create-season-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/page-header";
import { formatLongDate } from "@/lib/format";

/* eslint-disable @typescript-eslint/no-explicit-any */
export default async function SeasonsPage() {
  await requireManager();
  const admin = createAdminClient();
  const league = await resolveCurrentLeague(admin);
  const { data: seasons } = await admin
    .from("seasons")
    .select("id, name, starts_on, ends_on, is_active, season_teams(count)")
    .eq("league_id", league!.id)
    .order("starts_on", { ascending: false, nullsFirst: false });

  return (
    <div className="space-y-6">
      <PageHeader title="Seasons" description={league?.name ?? undefined} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Create a season</CardTitle>
        </CardHeader>
        <CardContent>
          <CreateSeasonForm />
        </CardContent>
      </Card>

      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead>Season</TableHead>
              <TableHead>Dates</TableHead>
              <TableHead className="text-center">Teams</TableHead>
              <TableHead></TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(seasons ?? []).map((s: any) => {
              const count = s.season_teams?.[0]?.count ?? 0;
              return (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {s.starts_on
                      ? `${formatLongDate(s.starts_on)} – ${formatLongDate(s.ends_on)}`
                      : "—"}
                  </TableCell>
                  <TableCell className="text-center">{count}</TableCell>
                  <TableCell>
                    {s.is_active ? <Badge>Active</Badge> : null}
                  </TableCell>
                  <TableCell className="space-x-2 text-right">
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/seasons/${s.id}`}>Setup</Link>
                    </Button>
                    {!s.is_active ? (
                      <form action={setActiveSeason} className="inline">
                        <input type="hidden" name="id" value={s.id} />
                        <Button type="submit" size="sm" variant="secondary">
                          Set active
                        </Button>
                      </form>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */
