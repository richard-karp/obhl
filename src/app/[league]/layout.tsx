import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { resolveLeagueBySlug } from "@/lib/league/current";

type Props = {
  children: React.ReactNode;
  params: Promise<{ league: string }>;
};

/**
 * Per-league title and OG name, so a link someone shares to `/harbor` previews
 * as Harbor rather than the generic site name. `absolute` on the default keeps
 * the root template from appending the site name to the league's own home
 * title; the `template` here is what the pages beneath augment.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ league: string }>;
}): Promise<Metadata> {
  const { league: slug } = await params;
  const league = await resolveLeagueBySlug(slug);
  if (!league) return {};
  return {
    title: { absolute: league.name, template: `%s · ${league.name}` },
    openGraph: { title: league.name, type: "website" },
  };
}

/**
 * Resolves the league once for everything beneath it, so no page below needs a
 * null check. An unknown slug 404s here — `notFound()` terminates rendering of
 * the segment it is thrown in, children included.
 *
 * `is_public` is deliberately *not* checked here: `(public)/layout.tsx` applies
 * it, which is what lets a league be managed before it is published.
 */
export default async function LeagueLayout({ children, params }: Props) {
  const { league: slug } = await params;
  const league = await resolveLeagueBySlug(slug);
  if (!league) notFound();
  return children;
}
