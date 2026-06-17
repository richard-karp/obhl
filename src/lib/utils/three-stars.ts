export type ThreeStarEntry = {
  player_id: string;
  first_name: string;
  last_name: string;
  g: number;
  a: number;
  pim: number;
  score: number;
};

type RosterRow = {
  player_id: string | null;
  first_name: string;
  last_name: string;
  goals: number;
  assists: number;
  pim: number;
};

export function computeThreeStars(rosters: RosterRow[]): ThreeStarEntry[] {
  return rosters
    .filter((r) => r.player_id != null)
    .map((r) => ({
      player_id: r.player_id!,
      first_name: r.first_name,
      last_name: r.last_name,
      g: r.goals,
      a: r.assists,
      pim: r.pim,
      score: r.goals * 3 + r.assists * 2 - r.pim,
    }))
    .sort((a, b) => b.score - a.score || b.g - a.g || b.a - a.a)
    .slice(0, 3);
}
