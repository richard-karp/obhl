/**
 * `createStaffAccount` refuses a linked player before it creates any login
 * unless every league that player is rostered in is one the manager works.
 * `is_captain_of` (0038) authorizes from `profiles.player_id` alone, so a player
 * shared with another league would hand that league's lineup writes to the new
 * account. The database and auth API are stubbed; this pins the check and its
 * order, not the writes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const createUser = vi.fn();
const leaguesOfPlayer = vi.fn<() => Promise<string[]>>();
const officeTierOf = vi.fn<() => Promise<"commissioner" | "deputy" | null>>();
// The manager's `profile_leagues` rows, as `memberLeagueIds` reads them.
let managerLeagues: string[] = [];

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/guards", () => ({
  requireLeagueManager: () => Promise.resolve({ id: "mgr-1" }),
}));
vi.mock("@/lib/auth/users", () => ({
  findUserIdByEmail: () => Promise.resolve(null),
}));
vi.mock("@/lib/auth/office", () => ({
  officeTierOf: () => officeTierOf(),
}));
vi.mock("@/lib/league/of-entity", () => ({
  leaguesOfPlayer: () => leaguesOfPlayer(),
}));
vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => ({
    auth: { admin: { createUser } },
    from: (table: string) => {
      if (table !== "profile_leagues") {
        throw new Error(`unexpected read of ${table}`);
      }
      return {
        select: () => ({
          eq: () =>
            Promise.resolve({
              data: managerLeagues.map((league_id) => ({ league_id })),
            }),
        }),
      };
    },
  }),
}));

const NOT_HERE = "Pick a player from this league's rosters.";
const SHARED =
  "That player also plays in a league you don't manage, so you can't link them to an account. A manager of every league they play in, or the League Office, can.";

const form = (role = "captain") => {
  const fd = new FormData();
  fd.set("league_id", "league-a");
  fd.set("email", "new.captain@example.test");
  fd.set("role", role);
  fd.set("player_id", "player-1");
  return fd;
};

beforeEach(() => {
  vi.clearAllMocks();
  // Stops the action right after the check, at the first write.
  createUser.mockResolvedValue({ data: null, error: { message: "stop here" } });
  officeTierOf.mockResolvedValue(null);
  managerLeagues = ["league-a"];
});

describe("createStaffAccount", () => {
  it("refuses a player from another league before creating a login", async () => {
    leaguesOfPlayer.mockResolvedValue(["league-b"]);
    const { createStaffAccount } = await import("./people");
    const r = await createStaffAccount(null, form());
    expect(r).toEqual({ ok: false, message: NOT_HERE });
    expect(createUser).not.toHaveBeenCalled();
  });

  it("refuses a player who also plays in a league the manager does not work", async () => {
    leaguesOfPlayer.mockResolvedValue(["league-a", "league-b"]);
    const { createStaffAccount } = await import("./people");
    const r = await createStaffAccount(null, form());
    expect(r).toEqual({ ok: false, message: SHARED });
    expect(createUser).not.toHaveBeenCalled();
  });

  it("refuses that shared player for a non-captain role too", async () => {
    leaguesOfPlayer.mockResolvedValue(["league-a", "league-b"]);
    const { createStaffAccount } = await import("./people");
    const r = await createStaffAccount(null, form("scorekeeper"));
    expect(r).toEqual({ ok: false, message: SHARED });
    expect(createUser).not.toHaveBeenCalled();
  });

  it("goes on to create the login for a player rostered only in this league", async () => {
    leaguesOfPlayer.mockResolvedValue(["league-a"]);
    const { createStaffAccount } = await import("./people");
    const r = await createStaffAccount(null, form());
    expect(createUser).toHaveBeenCalled();
    expect(r).toEqual({ ok: false, message: "stop here" });
  });

  it("goes on to create the login when the manager works every league the player plays in", async () => {
    leaguesOfPlayer.mockResolvedValue(["league-a", "league-b"]);
    managerLeagues = ["league-a", "league-b"];
    const { createStaffAccount } = await import("./people");
    const r = await createStaffAccount(null, form());
    expect(createUser).toHaveBeenCalled();
    expect(r).toEqual({ ok: false, message: "stop here" });
  });

  it.each(["commissioner", "deputy"] as const)(
    "lets a %s link a player from any league, with no membership rows",
    async (tier) => {
      leaguesOfPlayer.mockResolvedValue(["league-a", "league-b"]);
      officeTierOf.mockResolvedValue(tier);
      managerLeagues = [];
      const { createStaffAccount } = await import("./people");
      const r = await createStaffAccount(null, form());
      expect(createUser).toHaveBeenCalled();
      expect(r).toEqual({ ok: false, message: "stop here" });
    },
  );
});
