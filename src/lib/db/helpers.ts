import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";

/**
 * Either Supabase client. `lib/queries` defaults to the RLS client; a manager-gated caller may pass
 * the admin client, so its read does not depend on the season being publicly readable.
 */
export type DbClient = SupabaseClient<Database>;

export type Tables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"];
export type TablesInsert<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Insert"];
export type TablesUpdate<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Update"];
export type Views<T extends keyof Database["public"]["Views"]> =
  Database["public"]["Views"][T]["Row"];
export type Enums<T extends keyof Database["public"]["Enums"]> =
  Database["public"]["Enums"][T];
