"use client";

import { useRouter, usePathname } from "next/navigation";
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

  return (
    <Select
      value={value ?? "all"}
      onValueChange={(v) =>
        router.push(v === "all" ? pathname : `${pathname}?team=${v}`)
      }
    >
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
