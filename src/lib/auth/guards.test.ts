/**
 * `guards.ts` with its lookups stubbed. `redirect` and `notFound` throw, as they
 * do in Next, so a refusal is an exception naming where it sends the caller.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionUser } from "./session";
import type { OfficeTier } from "./office";

const getSessionUser = vi.fn<() => Promise<SessionUser | null>>();
const isLeagueMember =
  vi.fn<(profileId: string, leagueId: string | null | undefined) => Promise<boolean>>();
const officeTierOf = vi.fn<(profileId: string) => Promise<OfficeTier | null>>();

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("./session", () => ({ getSessionUser: () => getSessionUser() }));
vi.mock("./membership", () => ({
  isLeagueMember: (p: string, l: string | null | undefined) => isLeagueMember(p, l),
}));
vi.mock("./office", () => ({ officeTierOf: (p: string) => officeTierOf(p) }));
vi.mock("@/lib/league/visibility", () => ({
  decideLeagueVisible: (isPublic: boolean, isMember: boolean) =>
    isPublic || isMember,
}));

import {
  requireCommissioner,
  requireLeagueManager,
  requireLeagueManagerOf,
} from "./guards";

/** Exactly the picker. `/login` also starts with "/", so a substring would pass it. */
const TO_PICKER = /^REDIRECT \/$/;

const manager: SessionUser = {
  id: "mgr-1",
  email: "manager@example.test",
  role: "league_manager",
};

beforeEach(() => {
  vi.clearAllMocks();
  getSessionUser.mockResolvedValue(manager);
  isLeagueMember.mockResolvedValue(true);
  officeTierOf.mockResolvedValue(null);
});

describe("requireLeagueManager", () => {
  it("refuses the right role without membership of the league", async () => {
    isLeagueMember.mockResolvedValue(false);
    await expect(requireLeagueManager("league-b")).rejects.toThrow(TO_PICKER);
    expect(isLeagueMember).toHaveBeenCalledWith("mgr-1", "league-b");
  });
});

describe("requireLeagueManagerOf", () => {
  it("refuses ids that name different leagues, before asking about membership", async () => {
    await expect(
      requireLeagueManagerOf(
        async () => "league-a",
        async () => "league-b",
      ),
    ).rejects.toThrow(TO_PICKER);
    expect(isLeagueMember).not.toHaveBeenCalled();
  });

  it("refuses an id that resolves to no league", async () => {
    await expect(requireLeagueManagerOf(async () => null)).rejects.toThrow(
      TO_PICKER,
    );
    expect(isLeagueMember).not.toHaveBeenCalled();
  });

  it("admits a manager when every id names a league they belong to", async () => {
    await expect(
      requireLeagueManagerOf(
        async () => "league-a",
        async () => "league-a",
      ),
    ).resolves.toEqual(manager);
    expect(isLeagueMember).toHaveBeenCalledWith("mgr-1", "league-a");
  });
});

describe("requireCommissioner", () => {
  it("refuses a deputy", async () => {
    officeTierOf.mockResolvedValue("deputy");
    await expect(requireCommissioner()).rejects.toThrow(TO_PICKER);
  });

  it("admits a commissioner", async () => {
    officeTierOf.mockResolvedValue("commissioner");
    await expect(requireCommissioner()).resolves.toEqual(manager);
  });
});
