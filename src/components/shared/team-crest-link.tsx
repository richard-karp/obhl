import Link from "next/link";
import { TeamLogo } from "@/components/shared/team-logo";

// ⛔ The link needs `aria-label`: `TeamLogo` has no accessible name, on purpose. ⚠️ Keep `hover:underline` off this
// anchor (see `team-logo.tsx`). A player with no current team has no slug (`0044`), so the chip goes unlinked.
export function TeamCrestLink({
  slug,
  name,
  color,
  logoPath,
  textColor,
  league,
}: {
  slug: string | null;
  name: string | null;
  color: string | null;
  logoPath: string | null;
  textColor: string | null;
  league: string;
}) {
  const crest = (
    <TeamLogo
      name={name ?? ""}
      color={color}
      logoPath={logoPath}
      textColor={textColor}
    />
  );
  if (!slug) return crest;
  return (
    <Link href={`/${league}/teams/${slug}`} aria-label={name ?? "Team"}>
      {crest}
    </Link>
  );
}
