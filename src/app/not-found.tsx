import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-4 text-center">
      <p className="text-muted-foreground text-5xl font-bold">404</p>
      <p className="text-muted-foreground">That page couldn&apos;t be found.</p>
      <Button asChild>
        <Link href="/">Back to the league</Link>
      </Button>
    </div>
  );
}
