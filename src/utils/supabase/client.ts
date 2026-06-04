import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/db/types";

/** Supabase client for Client Components (browser). */
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );
}
