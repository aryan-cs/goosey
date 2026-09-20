/** Fictional identities with stable, non-deliverable login emails for fixtures. */
const participants = [
  ["elenakoi", "elenakoi", 1_054_000n],
  ["iyer_pixels", "iyer_pixels", 989_000n],
  ["dylan42", "dylan42", 863_000n],
  ["moonpatel", "moonpatel", 1_386_000n],
  ["dylanpuffin", "dylanpuffin", 880_000n],
  ["leebadger", "leebadger", 610_000n],
  ["dylan_orbit", "dylan_orbit", 1_266_000n],
  ["jain17", "jain17", 1_165_000n],
  ["wavesryan", "wavesryan", 1_318_000n],
  ["xupuffin", "xupuffin", 918_000n],
  ["meeraheron", "meeraheron", 1_166_000n],
  ["roy_toast", "roy_toast", 896_000n],
  ["mira21", "mira21", 659_000n],
  ["loopspatel", "loopspatel", 1_099_000n],
  ["meeranewt", "meeranewt", 946_000n],
  ["kumarkoala", "kumarkoala", 1_123_000n],
  ["tara_loops", "tara_loops", 1_125_000n],
  ["tran42", "tran42", 1_288_000n],
  ["sproutsamir", "sproutsamir", 1_239_000n],
  ["chenwren", "chenwren", 1_142_000n],
  ["anikawren", "anikawren", 873_000n],
  ["young_sprout", "young_sprout", 952_000n],
  ["aisha88", "aisha88", 629_000n],
  ["lunchbox", "lunchbox", 1_127_000n],
  ["niabadger", "niabadger", 1_101_000n],
  ["shenwren", "shenwren", 768_000n],
  ["theo_cloud", "theo_cloud", 785_000n],
  ["lin21", "lin21", 1_419_000n],
  ["signaldev", "signaldev", 964_000n],
  ["zhangpanda", "zhangpanda", 1_035_000n],
  ["neilheron", "neilheron", 1_214_000n],
  ["tran_orbit", "tran_orbit", 656_000n],
  ["dev7", "dev7", 1_107_000n],
  ["loopstran", "loopstran", 671_000n],
  ["theonewt", "theonewt", 1_396_000n],
  ["brooksbeaver", "brooksbeaver", 1_072_000n],
  ["sana_bloom", "sana_bloom", 1_348_000n],
  ["shen17", "shen17", 957_000n],
  ["staticleah", "staticleah", 554_000n],
  ["parkotter", "parkotter", 817_000n],
  ["rohanfox", "rohanfox", 1_046_000n],
  ["gupta_waves", "gupta_waves", 743_000n],
  ["leah21", "leah21", 1_281_000n],
  ["wavesshen", "wavesshen", 762_000n],
  ["rohannewt", "rohannewt", 588_000n],
  ["chenwren11", "chenwren11", 1_358_000n],
  ["nina_moon", "nina_moon", 1_388_000n],
  ["cole17", "cole17", 1_055_000n],
  ["wavesleo", "wavesleo", 866_000n],
  ["royibis", "royibis", 956_000n],
  ["owenraven", "owenraven", 1_377_000n],
  ["patel_waffle", "patel_waffle", 899_000n],
  ["nina88", "nina88", 614_000n],
  ["wafflenair", "wafflenair", 905_000n],
  ["dylanquail", "dylanquail", 1_576_000n],
  ["malikorca", "malikorca", 883_000n],
  ["rina_cloud", "rina_cloud", 1_326_000n],
  ["brooks27", "brooks27", 1_261_000n],
  ["claralee", "claralee", 390_000n],
  ["suribeaver", "suribeaver", 852_000n],
  ["evanfinch", "evanfinch", 919_000n],
  ["mehta_waves", "mehta_waves", 870_000n],
  ["deskfan", "deskfan", 1_426_000n],
  ["clarayoung", "clarayoung", 1_172_000n],
  ["aishaotter", "aishaotter", 1_282_000n],
  ["trannewt", "trannewt", 1_053_000n],
  ["evan_sundae", "evan_sundae", 1_149_000n],
  ["iyer21", "iyer21", 928_000n],
  ["moonnina", "moonnina", 952_000n],
  ["nairbadger", "nairbadger", 1_327_000n],
  ["neilfinch", "neilfinch", 1_181_000n],
  ["tang_chill", "tang_chill", 1_185_000n],
  ["nightbus", "nightbus", 968_000n],
  ["orbitkim", "orbitkim", 701_000n],
  ["teacup", "teacup", 543_000n],
  ["brookslynx", "brookslynx", 544_000n],
  ["adrian_static", "adrian_static", 724_000n],
  ["cerealbox", "cerealbox", 967_000n],
  ["clarasuri", "clarasuri", 1_594_000n],
  ["nairfox", "nairfox", 1_160_000n],
  ["tarapuffin", "tarapuffin", 1_129_000n],
  ["patel_pixels", "patel_pixels", 901_000n],
  ["elena17", "elena17", 988_000n],
  ["toastjain", "toastjain", 945_000n],
  ["arjunnewt", "arjunnewt", 995_000n],
  ["mousepad", "mousepad", 817_000n],
  ["nolan_chill", "nolan_chill", 1_058_000n],
  ["khan27", "khan27", 1_295_000n],
  ["bloomtara", "bloomtara", 714_000n],
  ["nairmoth", "nairmoth", 945_000n],
  ["arjunheron", "arjunheron", 927_000n],
  ["bookmark", "bookmark", 1_021_000n],
  ["dylan88", "dylan88", 670_000n],
  ["sprouttran", "sprouttran", 954_000n],
  ["elenaotter", "elenaotter", 1_042_000n],
  ["reedkoala", "reedkoala", 1_506_000n],
  ["kai_sundae", "kai_sundae", 1_145_000n],
  ["shen27", "shen27", 889_000n],
  ["keycap", "keycap", 965_000n],
  ["stoneotter", "stoneotter", 1_164_000n],
] as const;

export type DevelopmentProfile = {
  email: string; username: string; legacyUsername: string; displayName: string;
  role: "USER" | "ADMIN" | "SYSTEM";
  /** Desired marked-to-market equity after the synthetic trade replay. */
  targetEquityMilli: bigint | null;
};

export const DEVELOPMENT_PARTICIPANTS: DevelopmentProfile[] = participants.map(([username, displayName, targetEquityMilli], index) => {
  const legacyUsername = `simulation-trader-${String(index + 1).padStart(2, "0")}`;
  return { email: `${legacyUsername}@example.test`, username, displayName, legacyUsername, role: "USER", targetEquityMilli };
});

export const DEVELOPMENT_ADMINS: DevelopmentProfile[] = [
  ["captainquack", "Captain Quack"], ["papercrane", "Paper Crane"], ["nightowl", "Night Owl"],
].map(([username, displayName], index) => {
  const legacyUsername = `simulation-admin-${index + 1}`;
  return { email: `${legacyUsername}@example.test`, username, displayName, legacyUsername, role: "ADMIN", targetEquityMilli: null };
});

export const DEVELOPMENT_SYSTEM: DevelopmentProfile = {
  email: "simulation-system@example.test", username: "simulation-system", legacyUsername: "simulation-system",
  displayName: "Goosey Desk", role: "SYSTEM", targetEquityMilli: null,
};

export const DEVELOPMENT_PROFILES = [...DEVELOPMENT_ADMINS, ...DEVELOPMENT_PARTICIPANTS, DEVELOPMENT_SYSTEM];

export function developmentProfileFor(email: unknown) {
  return DEVELOPMENT_PROFILES.find(profile => profile.email === email);
}

export function isDevelopmentIdentity(user: { email?: unknown; username?: unknown; role?: unknown }) {
  const profile = developmentProfileFor(user.email);
  return Boolean(profile && user.role === profile.role && [profile.username, profile.legacyUsername].includes(String(user.username)));
}
