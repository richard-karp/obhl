"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Tabs } from "@/components/ui/tabs";

/**
 * The team page's tabs, with the URL as the single source of truth.
 *
 * ⛔ CONTROLLED, and that is the whole point. The Manage panel is rendered by the
 * server only when `?tab=manage` is present — it has four admin queries behind
 * it, one an unbounded read of the whole `players` table, and an uncontrolled
 * `<Tabs>` would run them on every casual view. But an uncontrolled Tabs also
 * owns its own state, and pairing that with a URL-conditional panel went wrong
 * three ways, all of them a blank content area:
 *
 *   - BACK from `?tab=manage` returned a payload with no manage panel while the
 *     retained state still said "manage";
 *   - arrow-keying onto the trigger set the value on FOCUS without navigating;
 *   - with `activationMode="manual"`, Enter activated the tab without following
 *     the link.
 *
 * ⚠️ ONLY MANAGE ROUND-TRIPS. The two public tabs have no server work behind
 * them and stay client-side, so switching between them is instant and costs no
 * navigation — a first attempt drove all three from the URL and broke Schedule,
 * which mapped to the same bare URL as Roster and so could never stay selected.
 *
 * Manage is the only value the URL carries, and it is the prop that decides it:
 * entering Manage navigates and lets the re-render select the tab, so the panel
 * exists by the time the value names it. `replace` rather than `push` so a tab
 * switch is not a history entry to back out of.
 */
export function TeamTabs({
  tab,
  baseHref,
  children,
}: {
  tab: string;
  baseHref: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [publicTab, setPublicTab] = useState("roster");

  return (
    <Tabs
      value={tab === "manage" ? "manage" : publicTab}
      onValueChange={(next) => {
        if (next === "manage") {
          // Navigate only; the prop selects the tab once its panel exists.
          router.replace(`${baseHref}?tab=manage`);
          return;
        }
        setPublicTab(next);
        if (tab === "manage") router.replace(baseHref);
      }}
      className="space-y-4"
    >
      {children}
    </Tabs>
  );
}
