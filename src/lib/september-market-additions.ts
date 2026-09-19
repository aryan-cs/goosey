/** User-approved September 19 additions. Times are America/Toronto (EDT). */
const common = { category: 'Hack the North', featured: true, color: 'green', icon: 'sparkles' } as const;
const end = '2026-09-20T16:30:00-04:00';
export const SEPTEMBER_MARKETS = [
  { ...common, slug: 'htn-2026-jesus-returns', title: 'Will Jesus return at Hack the North?', shortTitle: 'Will Jesus return at Hack the North?', description: 'Will Jesus Christ make a verifiable appearance at Hack the North 2026?',
    rules: 'Resolves YES if Jesus Christ returns during Hack the North 2026 and makes a verifiable appearance at the event. Costumes, cosplayers, people named Jesus, lookalikes, actors, cardboard cutouts, hallucinations, and suspiciously convincing hackers do not count.\n\nThe return must be independently verifiable beyond a Goosey submission. If the Second Coming remains a matter of theological dispute at market close, this market resolves NO.',
    resolutionSource: 'Independent verifiable evidence beyond a Goosey submission.', closesAt: end, resolvesAt: end },
  { ...common, slug: 'htn-2026-chinese-citadel-poker-winner', title: 'Will a Chinese kid win Citadel Poker?', shortTitle: 'Will a Chinese kid win Citadel Poker?', description: 'Will the official winner of the Citadel Poker event at Hack the North 2026 self-identify as Chinese?',
    rules: 'Resolves YES if the winner of the Citadel Poker event at Hack the North 2026 self-identifies as Chinese. Otherwise, resolves NO.\n\nThe official Citadel Poker result determines the winner. Goosey moderators will not determine ethnicity based on names, appearance, vibes, poker ability, or questionable eyewitness testimony.\n\nIf the event is cancelled or no official winner is declared, the market is void.\n\nTrading closes at 8:29 p.m. EDT on Saturday, September 19, before the scheduled 8:30 p.m. start. Resolve when the official winner is announced; 10:00 p.m. is the scheduled event end, not evidence of a result.',
    resolutionSource: 'Official Citadel Poker results and the winner’s voluntary self-identification.', closesAt: '2026-09-19T20:29:00-04:00', resolvesAt: '2026-09-19T22:00:00-04:00' },
  { ...common, slug: 'htn-2026-reported-goose-attack', title: 'Will there be a reported goose attack?', shortTitle: 'Will there be a reported goose attack?', description: 'Will a verified goose attack involving a Hack the North attendee occur on the University of Waterloo campus before market close?',
    rules: 'Resolves YES if at least one verified goose attack involving a Hack the North attendee occurs on the University of Waterloo campus before market close.\n\nA qualifying attack includes a goose chasing, pecking, biting, striking, or otherwise making physical contact with a person. Hissing, staring menacingly, blocking a sidewalk, or simply being a Waterloo goose does not count.\n\nEvidence must include the approximate time and location plus either photo/video evidence or two independent firsthand accounts. Multiple reports of the same encounter count as one incident.',
    resolutionSource: 'Photo/video evidence or two independent firsthand accounts, with approximate time and campus location.', closesAt: end, resolvesAt: end },
  { ...common, slug: 'htn-2026-gpt-wrapper-wins', title: 'Will a GPT wrapper win?', shortTitle: 'Will a GPT wrapper win?', description: 'Will an overall Hack the North 2026 winning project primarily be a thin interface or workflow around GPT?',
    rules: 'Resolves YES if an overall Hack the North 2026 winner is primarily a thin interface or workflow built around GPT, where calling an existing GPT model/API provides the project’s core functionality. Sponsor-only prizes do not count.\n\nSimply using GPT somewhere in a project does not make it a GPT wrapper. Projects with substantial original systems, hardware, infrastructure, models, algorithms, or other functionality beyond wrapping the model do not automatically qualify.\n\nGoosey moderators determine whether a winning project qualifies based on its submitted project, demo, and publicly presented implementation.\n\nTrading closes Sunday, September 20 at 9:29 a.m. EDT, before the first scheduled judging round. Resolve when the overall winners are announced, not when finalists are selected. The scheduled resolution time is the end of closing ceremonies.',
    resolutionSource: 'Official overall winner announcement, submitted project, demo and publicly presented implementation.', closesAt: '2026-09-20T09:29:00-04:00', resolvesAt: end },
] as const;

export const INDEPENDENT_DANCE_GROUP = {
  slug: 'htn-2026-winning-team-dances', title: 'Which dances will a winning team member do?', shortTitle: 'Winning team dances',
  description: 'Bet on each dance separately: Worm, Dab or Floss. More than one can resolve YES. These are independent contracts, not a prediction of which dance happens first.',
  ...common, startsAt: '2026-09-18T00:00:00-04:00', endsAt: end,
} as const;
const danceRules = 'Only listed members of officially announced overall Hack the North 2026 winning teams, physically on the official stage during closing ceremonies, qualify. Sponsor-only winners, audience members, offstage performances and prerecorded footage do not count. A performer must be confirmed on the overall winner list but need not have received their award yet. Each dance resolves independently: multiple dances can resolve YES, and a later dance still counts. Resolve NO only if complete usable evidence establishes the dance did not occur. If the ceremony is cancelled, eligibility cannot be established or the evidence cannot establish YES or NO, resolve this market VOID. Trading closes before closing ceremonies. Existing first-dance contracts retain their own original rules and positions.';
export const INDEPENDENT_DANCE_MARKETS = [
  { key: 'worm', label: 'Worm', title: 'Will a winning team member do the worm on stage?', qualifying: 'a recognizable worm body-wave' },
  { key: 'dab', label: 'Dab', title: 'Will a winning team member dab on stage?', qualifying: 'a recognizable dab pose' },
  { key: 'floss', label: 'Floss', title: 'Will a winning team member floss on stage?', qualifying: 'a recognizable floss movement' },
].map(option => ({...common, slug:`htn-2026-winning-team-${option.key}`, label:option.label, title:option.title, shortTitle:option.title,
  description:`YES if an overall winning team member performs ${option.qualifying} on the official closing-ceremony stage. Other dances do not prevent this option from winning.`,
  rules:`Resolves YES if an eligible person performs ${option.qualifying}. ${danceRules}`,
  resolutionSource:'Full official closing-ceremony recording and official overall Hack the North 2026 winner list.',
  closesAt:'2026-09-20T14:30:00-04:00', resolvesAt:end,
}));
