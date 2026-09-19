import type { Prisma } from "@prisma/client";

import { FIRST_DANCE_EVENT_SLUG, FIRST_DANCE_OPTIONS } from "@/lib/dance-market";
import { ApiError } from "@/lib/market-service";

const EVENT_SLUG = FIRST_DANCE_EVENT_SLUG;
const OPTION_SLUGS: readonly string[] = FIRST_DANCE_OPTIONS.map((option) => option.slug);

type OptionState = {
  id: string;
  slug: string;
  resolution: string | null;
  resolutionProposals: Array<{ outcome: string }>;
};

/** A partial resolution must still permit exactly one eventual winning option. */
export function assertConsistentDanceOutcomes(options: OptionState[], marketId: string, outcome: string): void {
  if (options.length !== OPTION_SLUGS.length || OPTION_SLUGS.some((slug) => !options.some((option) => option.slug === slug))) {
    throw new ApiError(409, "DANCE_GROUP_INCOMPLETE", "All four first-dance options must exist in the event before resolution.");
  }
  const outcomes = options.map((option) => {
    const candidates = [option.resolution, ...option.resolutionProposals.map((proposal) => proposal.outcome), ...(option.id === marketId ? [outcome] : [])].filter((value): value is string => Boolean(value));
    if (new Set(candidates).size > 1) {
      throw new ApiError(409, "DANCE_OUTCOME_CONFLICT", "This option already has a conflicting result or pending proposal.");
    }
    return candidates[0] ?? null;
  });
  if (outcomes.filter((value) => value === "YES").length > 1) {
    throw new ApiError(409, "DANCE_OUTCOME_CONFLICT", "Only the first qualifying dance wins. Another option already has a YES result or pending proposal.");
  }
  if (outcomes.every((value) => value === "NO")) {
    throw new ApiError(409, "DANCE_OUTCOME_CONFLICT", "Exactly one option must win, including None when no qualifying dance occurs.");
  }
  if (outcomes.includes("VOID") && outcomes.some((value) => value === "YES" || value === "NO")) {
    throw new ApiError(409, "DANCE_OUTCOME_CONFLICT", "A void first-dance event must void every option; it cannot mix void and decided results.");
  }
}

/** Called inside the proposal/approval serializable transaction, before writing results. */
export async function assertDanceResolution(
  tx: Prisma.TransactionClient,
  market: { id: string; slug: string; eventId: string | null },
  outcome: string,
): Promise<void> {
  if (!OPTION_SLUGS.includes(market.slug)) return;
  if (!market.eventId) throw new ApiError(409, "DANCE_GROUP_INCOMPLETE", "The first-dance option is missing its event.");
  // Every sibling proposal/approval writes the same row. Concurrent decisions
  // therefore conflict and retry instead of approving two different winners.
  const locked = await tx.marketEvent.updateMany({
    where: { id: market.eventId, slug: EVENT_SLUG },
    data: { version: { increment: 1 } },
  });
  if (locked.count !== 1) throw new ApiError(409, "DANCE_GROUP_INCOMPLETE", "The first-dance option belongs to an invalid event.");
  const options = await tx.market.findMany({
    where: { eventId: market.eventId },
    select: { id: true, slug: true, resolution: true, resolutionProposals: { where: { status: "PENDING" }, select: { outcome: true } } },
  });
  assertConsistentDanceOutcomes(options, market.id, outcome);
}
