import "server-only";
import { createAdminClient } from "@/utils/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * The auth user id for an address, or null.
 *
 * Paged, rather than one large page. `listUsers` returns a single page and says
 * nothing about the rest, so a lone `perPage: 1000` call turns "this address
 * exists" into "no such account" the moment an instance outgrows it — and the
 * callers here take that answer as fact. In `createStaffAccount` it becomes the
 * raw createUser error instead of the person being added; in
 * `createTeamForSeason` it is quieter still, and the team is reported added with
 * a captain who has no login at all.
 *
 * The loop stops at the first short page, and at a bound, so a backend that
 * ignores paging cannot spin here.
 *
 * `email` must already be lowercased — both call sites normalise their input,
 * and comparing a raw address against a lowercased one is a miss, not an error.
 */
export async function findUserIdByEmail(
  admin: Admin,
  email: string,
): Promise<string | null> {
  const perPage = 200;
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) return null;
    const hit = data.users.find((u) => u.email?.toLowerCase() === email);
    if (hit) return hit.id;
    if (data.users.length < perPage) return null;
  }
  return null;
}
