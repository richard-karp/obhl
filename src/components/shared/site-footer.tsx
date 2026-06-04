import Link from "next/link";

export function SiteFooter({ leagueName }: { leagueName: string }) {
  return (
    <footer className="mt-auto border-t">
      <div className="text-muted-foreground mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-4 py-6 text-sm sm:flex-row">
        <p>{leagueName}</p>
        <div className="flex items-center gap-4">
          <Link href="/login" className="hover:text-foreground transition-colors">
            Staff sign in
          </Link>
          <span>Built with Next.js &amp; Supabase</span>
        </div>
      </div>
    </footer>
  );
}
