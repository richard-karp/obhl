/**
 * ⛔ Both password writers check this before calling Supabase: `config.toml`'s floor of 6
 * governs the local stack only, and production's floor lives in the dashboard.
 */
export const MIN_PASSWORD = 8;

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD)
    return `Use at least ${MIN_PASSWORD} characters.`;
  return null;
}
