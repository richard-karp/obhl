import { requireManager } from "@/lib/auth/guards";
import { createAdminClient } from "@/utils/supabase/admin";
import { PageHeader } from "@/components/shared/page-header";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/shared/empty-state";

function fmt(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function truncate(s: string, n = 40) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export default async function AuditLogPage() {
  await requireManager();
  const admin = createAdminClient();

  const { data: rows } = await admin
    .from("audit_log")
    .select("id, created_at, user_id, action, entity_type, entity_id, new_data, old_data, session_id")
    .order("created_at", { ascending: false })
    .limit(200);

  const userIds = [...new Set((rows ?? []).map((r) => r.user_id).filter((id): id is string => id != null))];
  let nameMap = new Map<string, string>();
  if (userIds.length) {
    const { data: profiles } = await admin
      .from("profiles")
      .select("id, display_name")
      .in("id", userIds);
    nameMap = new Map(
      (profiles ?? []).map((p) => [p.id, p.display_name ?? p.id.slice(0, 8)]),
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Audit Log" description="Recent staff actions" />
      <Card>
        <CardContent className="p-0">
          {!rows || rows.length === 0 ? (
            <div className="p-6">
              <EmptyState title="No actions logged yet" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead className="whitespace-nowrap">Time</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Entity</TableHead>
                    <TableHead className="hidden md:table-cell">Changes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(rows ?? []).map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="text-muted-foreground whitespace-nowrap text-xs">
                        {r.created_at ? fmt(r.created_at) : "—"}
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.user_id
                          ? (nameMap.get(r.user_id) ?? String(r.user_id).slice(0, 8))
                          : "—"}
                      </TableCell>
                      <TableCell>
                        <code className="bg-muted rounded px-1.5 py-0.5 text-xs">
                          {r.action}
                        </code>
                      </TableCell>
                      <TableCell className="text-xs">
                        <span className="text-muted-foreground">{r.entity_type}/</span>
                        <span className="font-mono">{r.entity_id.slice(0, 8)}</span>
                      </TableCell>
                      <TableCell className="hidden text-xs md:table-cell">
                        {r.new_data ? (
                          <span className="text-muted-foreground">
                            {truncate(JSON.stringify(r.new_data))}
                          </span>
                        ) : r.old_data ? (
                          <span className="text-muted-foreground line-through">
                            {truncate(JSON.stringify(r.old_data))}
                          </span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
