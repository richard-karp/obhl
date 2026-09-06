/**
 * The shortest password this app will set, and the one place that decides it.
 *
 * ⛔ EIGHT IS ENFORCED HERE, BEFORE SUPABASE IS CALLED, by every door that
 * writes a password — the commissioner's `setStaffPassword` (admin API) and the
 * account holder's own reset (`auth.updateUser`). Supabase's floor is a
 * different number in a different place: `supabase/config.toml`'s
 * `minimum_password_length = 6` is the stock scaffold default and governs the
 * LOCAL stack only (nothing pushes that config), and production's real floor
 * lives in the dashboard and is recorded nowhere in this repository. Checking
 * first means the two doors agree on the same account regardless of what the
 * dashboard says — which is the whole reason this is not two literals.
 *
 * Eight is not a security theory. It is the number that stops someone being
 * handed a password Supabase would accept and a browser would autofill into
 * every other box.
 */
export const MIN_PASSWORD = 8;

/** The reason a password is unusable, or null when it is fine. */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD)
    return `Use at least ${MIN_PASSWORD} characters.`;
  return null;
}
