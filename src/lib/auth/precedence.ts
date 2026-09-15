import type { Database } from "@/lib/db/types";

export type OfficeTier = Database["public"]["Enums"]["office_tier"];

/**
 * Pure so the nine-cell matrix is unit tested: `membership.ts` and `office.ts` import
 * `server-only`. `contains` is the tier-0 test only; every office tier ignores it.
 */
export function decideProfileWrite(
  mineTier: OfficeTier | null,
  theirTier: OfficeTier | null,
  contains: boolean,
): boolean {
  if (mineTier === "commissioner") return theirTier !== "commissioner";
  if (mineTier === "deputy") return theirTier === null;
  return theirTier === null && contains;
}
