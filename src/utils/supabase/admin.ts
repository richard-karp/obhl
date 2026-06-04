import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";

/**
 * SERVER-ONLY admin client. Uses the secret key and BYPASSES RLS. Only import
 * this from Server Actions / Route Handlers for privileged operations (e.g. a
 * manager creating staff accounts). NEVER import into a Client Component — that
 * would leak the secret key to the browser.
 */
export function createAdminClient() {
  return createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
