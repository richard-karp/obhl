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

  /**
   * ⛔ PRESERVE THE REST OF THE QUERY, DO NOT REBUILD IT. This used to push
   * `pathname` or `${pathname}?team=${v}`, which dropped every other parameter
   * on the floor. That was invisible while the only other one was `?season=`,
   * because the season choice is cookie-backed and simply came back — but
   * `?view=` is not, so "open Results, filter to one team" silently returned
   * you to Upcoming.
   *
   * ⚠️ And it copies whatever is there rather than naming the keys it knows
   * about: an allow-list would drop the next parameter somebody adds, which is
   * exactly how it came to drop this one.
   */
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
