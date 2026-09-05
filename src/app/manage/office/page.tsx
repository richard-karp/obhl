import type { Metadata } from "next";
import Link from "next/link";
import { requireOfficeMember } from "@/lib/auth/guards";
import { createAdminClient } from "@/utils/supabase/admin";
import { officeTierOf, listOfficeTiers } from "@/lib/auth/office";
import { emailsByProfileId } from "@/lib/auth/users";
import { appointDeputy } from "@/lib/actions/office";
import { OfficeRowActions } from "@/components/manage/office-row-actions";
import { PageHeader } from "@/components/shared/page-header";
import { OfficeAuditNotice } from "@/components/manage/office-audit-notice";
import { recentOfficeAudit } from "@/lib/audit";
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

/**
 * The League Office roster, at `/manage/office` — outside `[league]`, because
 * the tier belongs to no league.
 *
 * Safe as a top-level route: `manage` is a reserved league slug (0030), reserved
 * for exactly this so that nothing can ever answer beneath it. Its migration
 * says so in as many words.
 */
export default async function OfficePage() {
  // Visible to the office only. A league manager who is not in it gets the
  // picker, the same as any other refusal.
  const viewer = await requireOfficeMember();
  const viewerTier = await officeTierOf(viewer.id);
  const isCommissioner = viewerTier === "commissioner";

  const admin = createAdminClient();
  const [tiers, officeLog] = await Promise.all([
    listOfficeTiers(),
    // This page is where office changes are readable at all — they carry no
    // league, so every league-scoped view filters them out.
    recentOfficeAudit(20),
  ]);

  // Candidates are managers who are not already in the office. The role filter
  // is not cosmetic: 0034's trigger refuses a `league_office` row for anyone who
  // is not a `league_manager`, so offering a captain here would render a control
  // whose only possible outcome is a silent refusal.
  //
  // ⚠️ Only for a commissioner. A deputy sees no appoint form, and used to pay
  // for it anyway — this query plus an address lookup per manager, all of it
  // discarded before render.
  //
  // ⚠️ THE ADDRESS LOOKUPS SCALE WITH THE INSTANCE, NOT WITH THIS PAGE. There is
  // no batch-lookup-by-id in the admin API, so populating the picker costs one
  // request per manager, in waves of ten. That is a deliberate trade, not an
  // oversight: the picker is how a commissioner identifies an account, and
  // `display_name` is nullable, so dropping addresses would degrade the control
  // to distinguish accounts by nothing. Managers are few by nature — the tier
  // exists because too FEW people can reach across leagues. If an instance ever
  // grows enough for this to bite, the fix is a typeahead that looks up on
  // demand, not a shorter list.
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
    // Commissioners first, then deputies, then by address so the order is stable
    // across renders rather than following whatever the table returned.
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
            The spec's rule: an unexplained absent control reads as a bug. A
            commissioner opening this page sees no way to appoint or remove a
            commissioner — including themselves — and that has to be stated, not
            left to be discovered.
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

      <div className="mt-6">
        <OfficeAuditNotice
          entries={officeLog}
          heading="Recent office changes"
          emptyText="No appointments or removals logged yet."
        />
      </div>
    </div>
  );
}
