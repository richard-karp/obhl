import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { ManageNav } from "@/components/manage/manage-nav";
import { createClient } from "@/utils/supabase/server";
import { getPublicLeagues, resolveCurrentLeague } from "@/lib/league/current";

export default async function ManageLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const supabase = await createClient();
  const [leagues, current] = await Promise.all([
    getPublicLeagues(supabase),
    resolveCurrentLeague(supabase),
  ]);

  return (
    <div className="flex min-h-full flex-col">
      <ManageNav
        role={user.role}
        leagues={leagues}
        currentSlug={current?.slug ?? ""}
      />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        {children}
      </main>
    </div>
  );
}
