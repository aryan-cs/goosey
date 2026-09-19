/** New contract: never rewrite the traded MC-only market's scope. */
export const LEGACY_MC_SLUG = "htn-2026-mc-does-67";
export const SPEAKER_MARKET = {
  slug: "htn-2026-closing-speaker-does-67",
  title: "Will a closing ceremony speaker do a 67?",
  shortTitle: "Will a closing ceremony speaker do a 67?",
  description: "Will a closing ceremony speaker do a 67? This separate contract includes official speakers as well as MCs. The original MC-only market keeps its original rules and positions.",
  rules: "YES if an official speaker or MC says the meme phrase ‘six seven’ or performs its recognizable alternating up-and-down hand gesture while speaking on the official stage during the Hack the North 2026 closing ceremonies. An unrelated number, an audience member, or a prerecorded clip does not count. Use the full official recording; incomplete evidence cannot establish NO. If the event is cancelled or the available evidence cannot establish YES or NO, resolve VOID. Trading closes before closing ceremonies; do not reopen after the result is known. This is a separate broader contract: trades in the original MC-only market are not transferred and still settle under that market's original rules.",
  resolutionSource: "Full official closing-ceremony recording.",
  category: "Hack the North", featured: true, color: "green", icon: "sparkles",
  closesAt: "2026-09-20T14:30:00-04:00", resolvesAt: "2026-09-20T16:30:00-04:00",
} as const;
