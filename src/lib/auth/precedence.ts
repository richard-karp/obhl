import type { Database } from "@/lib/db/types";

export type OfficeTier = Database["public"]["Enums"]["office_tier"];

/**
 * The League Office precedence rule, with the lookups taken out.
 *
 * YOU MAY WRITE A PROFILE ONLY IF YOUR TIER IS STRICTLY ABOVE THEIRS.
 *
 * | actor | may write |
 * |---|---|
 * | commissioner | anyone except another commissioner |
 * | deputy | anyone outside the office |
 * | league manager (tier 0) | tier-0 accounts whose leagues theirs contain |
 *
 * Commissioner↔commissioner, deputy↔deputy and manager↔manager all fail it,
 * which is "peers" stated once instead of three times — and is also what stops
 * an office member demoting themselves.
 *
 * Deliberately pure, and deliberately in its own file. `membership.ts` and
 * `office.ts` both carry `import "server-only"`, which throws outside a request,
 * so the rule could not otherwise be unit tested without introducing mocking
 * this codebase has never needed — every other test here is a pure function. The
 * I/O stays in `mayWriteProfileOf`; the decision lives here where the nine-cell
 * matrix can be asserted directly.
 *
 * `contains` is the tier-0 test only: whether every league the target works is
 * one the actor works too. It is ignored at every office tier, because reach is
 * a rule there rather than data — see 0034.
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
