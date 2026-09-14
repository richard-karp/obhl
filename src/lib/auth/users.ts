import "server-only";
import { createAdminClient } from "@/utils/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Paged: a single `listUsers` page turns "exists" into "no such account" as the instance
 * grows. ⛔ Normalises its own argument, so no caller misses on a capitalised address.
 */
export async function findUserIdByEmail(
  admin: Admin,
  email: string,
): Promise<string | null> {
  const needle = email.trim().toLowerCase();
  const perPage = 200;
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) return null;
    const hit = data.users.find((u) => u.email?.toLowerCase() === needle);
    if (hit) return hit.id;
    if (data.users.length < perPage) return null;
  }
  return null;
}

/**
 * By id, ten at a time: a `listUsers` page drops staff past its size, and one request per
 * person at once is a stampede. A failed lookup is reported apart from a missing address.
 */
export async function emailsByProfileId(
  admin: Admin,
  ids: string[],
): Promise<Map<string, string>> {
  const AT_A_TIME = 10;
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += AT_A_TIME) {
    const looked = await Promise.all(
      ids.slice(i, i + AT_A_TIME).map(async (id) => {
        const { data, error } = await admin.auth.admin.getUserById(id);
        if (error) return [id, "(address unavailable)"] as const;
        return [id, data.user?.email ?? "—"] as const;
      }),
    );
    for (const [id, email] of looked) out.set(id, email);
  }
  return out;
}
