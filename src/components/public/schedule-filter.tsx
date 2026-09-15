"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function ScheduleFilter({
  teams,
  value,
}: {
  teams: { slug: string; name: string }[];
  value?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // ⛔ Preserve the rest of the query, never rebuild it: dropping `?view=` sent a filtered Results back to Upcoming.
  // ⚠️ Copy everything, not an allow-list, which would drop the next parameter added.
  function selectTeam(v: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (v === "all") params.delete("team");
    else params.set("team", v);
    const q = params.toString();
    router.push(q ? `${pathname}?${q}` : pathname);
  }

  return (
    <Select value={value ?? "all"} onValueChange={selectTeam}>
      <SelectTrigger className="w-44">
        <SelectValue placeholder="All teams" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All teams</SelectItem>
        {teams.map((t) => (
          <SelectItem key={t.slug} value={t.slug}>
            {t.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
