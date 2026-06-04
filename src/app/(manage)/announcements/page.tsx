import { requireManager } from "@/lib/auth/guards";
import { createAdminClient } from "@/utils/supabase/admin";
import { resolveCurrentLeague } from "@/lib/league/current";
import { deleteAnnouncement } from "@/lib/actions/announcements";
import { AnnouncementForm } from "@/components/manage/announcement-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { formatLongDate } from "@/lib/format";

export default async function AnnouncementsPage() {
  await requireManager();
  const admin = createAdminClient();
  const league = await resolveCurrentLeague(admin);

  const { data: announcements } = await admin
    .from("announcements")
    .select("id, title, body, published_at")
    .eq("league_id", league!.id)
    .order("published_at", { ascending: false });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Announcements"
        description={`Posted to the ${league?.name ?? "league"} homepage.`}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">New announcement</CardTitle>
        </CardHeader>
        <CardContent>
          <AnnouncementForm />
        </CardContent>
      </Card>

      {(announcements ?? []).length === 0 ? (
        <EmptyState
          title="No announcements yet"
          description="Post one above — it shows on the league homepage."
        />
      ) : (
        <div className="space-y-3">
          {(announcements ?? []).map((a) => (
            <Card key={a.id}>
              <CardContent className="flex items-start justify-between gap-4 p-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold">{a.title}</h3>
                    <span className="text-muted-foreground text-xs">
                      {formatLongDate(a.published_at)}
                    </span>
                  </div>
                  <p className="text-muted-foreground text-sm">{a.body}</p>
                </div>
                <form action={deleteAnnouncement}>
                  <input type="hidden" name="id" value={a.id} />
                  <Button
                    type="submit"
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                  >
                    Delete
                  </Button>
                </form>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
