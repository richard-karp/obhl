import type { Metadata } from "next";
import Link from "next/link";
import { requireOfficeMember } from "@/lib/auth/guards";
import { createAdminClient } from "@/utils/supabase/admin";
import { officeTierOf, listOfficeTiers } from "@/lib/auth/office";
import { emailsByProfileId } from "@/lib/auth/users";
import { appointDeputy } from "@/lib/actions/office";
import { OfficeRowActions } from "@/components/manage/office-row-actions";
import { OfficePasswordForm } from "@/components/manage/office-password-form";
import { PageHeader } from "@/components/shared/page-header";
import { OfficeAuditNotice } from "@/components/manage/office-audit-notice";
import { recentOfficeAudit, recentPasswordAudit } from "@/lib/audit";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = { title: "League Office" };

const TIER_LABEL: Record<string, string> = {
  commissioner: "Commissioner",
  deputy: "Deputy",
};

// Outside `[league]`, since the tier belongs to no league; safe because `manage` is a reserved slug (0030).
export default async function OfficePage() {
  const viewer = await requireOfficeMember();
  const viewerTier = await officeTierOf(viewer.id);
  const isCommissioner = viewerTier === "commissioner";

  const admin = createAdminClient();
  const [tiers, officeLog, passwordLog] = await Promise.all([
    listOfficeTiers(),
    // Office entries carry no league, so this page is the only one that shows them.
    recentOfficeAudit(20),
    // ⚠️ A second query, not a bigger one: self-serve password changes share only the `office` entity type.
    recentPasswordAudit(10),
  ]);

  // Managers only: `0034`'s trigger silently refuses a tier for anyone else. ⚠️ One address lookup per
  // manager (no batch API); keep them, since `display_name` is nullable. Fix scale with a typeahead.
  const candidates = isCommissioner
    ? (
        (
          await admin
            .from("profiles")
            .select("id, display_name")
            .eq("role", "league_manager")
        ).data ?? []
      ).filter((m) => !tiers.has(m.id))
    : [];

  const emails = await emailsByProfileId(admin, [
    ...tiers.keys(),
    ...candidates.map((c) => c.id),
  ]);

  const { data: profiles } = tiers.size
    ? await admin
        .from("profiles")
        .select("id, display_name")
        .in("id", [...tiers.keys()])
    : { data: [] as { id: string; display_name: string | null }[] };

  const nameById = new Map((profiles ?? []).map((p) => [p.id, p.display_name]));
  const roster = [...tiers.entries()]
    .map(([id, tier]) => ({
      id,
      tier,
      email: emails.get(id) ?? "—",
      display_name: nameById.get(id) ?? null,
    }))
    .sort(
      (a, b) => a.tier.localeCompare(b.tier) || a.email.localeCompare(b.email),
    );

  return (
    <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-8">
      <div className="mb-6">
        <Link
          href="/"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← All leagues
        </Link>
      </div>

      <PageHeader
        title="League Office"
        description="Instance-wide staff. The office reaches every league, present and future."
      />

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">How this tier works</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground space-y-2 text-sm">
          <p>
            A <strong>commissioner</strong> may write anyone except another
            commissioner. A <strong>deputy</strong> may write anyone outside the
            office. Both reach every league without being a member of any.
          </p>
          {/*
            An unexplained absent control reads as a bug: no one can appoint or remove a commissioner here.
          */}
          <p>
            The commissioner tier is <strong>peer-flat</strong>: no commissioner
            outranks another, so it cannot be changed from this page by anyone.
            Appointing or removing a commissioner is done directly in the
            database. That is deliberate — it means no single office account can
            empty the tier.
          </p>
          <p>
            Removing a deputy takes back the tier and nothing else. Their
            account, their role and the leagues they belonged to beforehand are
            all untouched.
          </p>
        </CardContent>
      </Card>

      {isCommissioner ? (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-base">Appoint a deputy</CardTitle>
          </CardHeader>
          <CardContent>
            {candidates.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                Every manager account is already in the office. Only manager
                accounts can hold a tier.
              </p>
            ) : (
              <form action={appointDeputy} className="flex items-end gap-3">
                <div className="flex-1">
                  <label
                    htmlFor="office-appoint"
                    className="mb-1 block text-sm font-medium"
                  >
                    Manager account
                  </label>
                  <select
                    id="office-appoint"
                    name="id"
                    aria-label="Manager account"
                    className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
                    defaultValue=""
                    required
                  >
                    <option value="" disabled>
                      Choose an account…
                    </option>
                    {candidates.map((c) => (
                      <option key={c.id} value={c.id}>
                        {emails.get(c.id) ?? c.id}
                        {c.display_name ? ` — ${c.display_name}` : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <Button type="submit">Appoint as deputy</Button>
              </form>
            )}
          </CardContent>
        </Card>
      ) : null}

      {/*
        ⛔ Drawn for a commissioner, but `setStaffPassword` must refuse anyone else itself: a form action is
        an endpoint (`RUNBOOK.md` → Access control). It is the one password path that needs no email.
      */}
      {isCommissioner ? (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-base">Set a staff password</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-muted-foreground text-sm">
              For a staff account that cannot receive a sign-in link — a dead
              address, or an inbox that is not answering. Any staff account
              except another commissioner; your own is allowed.
            </p>
            <OfficePasswordForm />
          </CardContent>
        </Card>
      ) : null}

      <div className="mt-6 overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead>Email</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Tier</TableHead>
              <TableHead className="text-right">Manage</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {roster.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-medium">{r.email}</TableCell>
                <TableCell className="text-muted-foreground">
                  {r.display_name ?? "—"}
                </TableCell>
                <TableCell>{TIER_LABEL[r.tier] ?? r.tier}</TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-2">
                    <OfficeRowActions
                      id={r.id}
                      tier={r.tier}
                      viewerIsCommissioner={isCommissioner}
                    />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="mt-6 space-y-4">
        <OfficeAuditNotice
          entries={officeLog}
          heading="Recent office changes"
          emptyText="No appointments or removals logged yet."
        />
        <OfficeAuditNotice
          entries={passwordLog}
          heading="Recent password changes"
          emptyText="Nobody has set their own password yet."
        />
      </div>
    </div>
  );
}
