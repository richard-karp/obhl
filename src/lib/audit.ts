"use server";

import { cookies } from "next/headers";
import { createAdminClient } from "@/utils/supabase/admin";

type AuditEntry = {
  user_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  old_data?: object | null;
  new_data?: object | null;
};

export async function logAudit(entry: AuditEntry) {
  try {
    const store = await cookies();
    const session_id = store.get("audit_session")?.value ?? null;
    const admin = createAdminClient();
    await admin.from("audit_log").insert({
      session_id: session_id ?? undefined,
      user_id: entry.user_id,
      action: entry.action,
      entity_type: entry.entity_type,
      entity_id: entry.entity_id,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      old_data: (entry.old_data ?? null) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new_data: (entry.new_data ?? null) as any,
    });
  } catch {
    // audit logging is non-critical; never surface errors to users
  }
}
