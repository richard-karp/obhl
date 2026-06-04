import { SiteHeader } from "@/components/shared/site-header";
import { SiteFooter } from "@/components/shared/site-footer";
import { getActiveContext } from "@/lib/queries/season";

export default async function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await getActiveContext();
  const leagueName = ctx?.league.name ?? "OBHL";

  return (
    <>
      <SiteHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:py-8">
        {children}
      </main>
      <SiteFooter leagueName={leagueName} />
    </>
  );
}
