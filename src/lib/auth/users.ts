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

/**
 * Addresses for a set of profile ids.
 *
 * Asked for BY ID, a bounded number at a time.
 *
 * This was `listUsers({ perPage: 1000 })` — one page of the instance's auth
 * users, joined against. A page says nothing about the rest, so past the
 * thousandth auth user staff would start vanishing from the table with no error
 * anywhere. Paging that call would answer the truncation too, and is the worse
 * trade: there is no batch-lookup-by-id in the admin API, so paging means
 * reading the whole auth table, each page before the next can be asked for.
 * That is 50 serial round trips at ten thousand users, where asking per member
 * is one wave of however many staff there are. The cost tracks the list being
 * rendered rather than the instance, which only grows.
 *
 * Bounded anyway: `Promise.all` over the whole list would open a connection per
 * person to render a table, which a large league or office turns into a
 * stampede.
 *
 * A lookup that FAILED is not an account without an address, and the two used to
 * render identically — so a rate-limited page read as staff who simply have no
 * email. They are reported apart.
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
