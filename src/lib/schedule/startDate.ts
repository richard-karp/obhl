/** ⛔ A past first night locks the season once published, and a draft hides it. ⚠️ Guard
 *  generate, not publish, when the manager would already hold a reviewed draft.
 *  ⚠️ Named arguments: swapped, the guard inverts silently. `today` is league-local and passes. */
export function isPastGameNight({
  startDate,
  today,
}: {
  startDate: string;
  today: string;
}): boolean {
  // Not a date: upstream already says "Pick a first game night.", so don't add a second.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return false;
  return startDate < today;
}
