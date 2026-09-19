/** Fictional identities with stable, non-deliverable login emails for fixtures. */
const participants = [
  ["maplebyte", "Maple Byte"], ["noodleninja", "Noodle Ninja"],
  ["pixelpanda", "Pixel Panda"], ["gooseontherun", "Goose on the Run"],
  ["midnightmango", "Midnight Mango"], ["icedmatcha", "Iced Matcha"],
  ["caffeinatedfox", "Caffeinated Fox"], ["orbitotter", "Orbit Otter"],
  ["wafflewizard", "Waffle Wizard"], ["rubberduckdev", "Rubber Duck"],
  ["cloudcroissant", "Cloud Croissant"], ["sleepycapy", "Sleepy Capy"],
  ["neonmoose", "Neon Moose"], ["lunar_latte", "Lunar Latte"],
  ["peachypixels", "Peachy Pixels"], ["tinyavocado", "Tiny Avocado"],
  ["cosmicbagel", "Cosmic Bagel"], ["mintychip", "Minty Chip"],
  ["chaoticgood", "Chaotic Good"], ["snackoverflow", "Snack Overflow"],
  ["pocketpenguin", "Pocket Penguin"], ["starlightsoda", "Starlight Soda"],
  ["ctrlaltduck", "Ctrl Alt Duck"], ["toastie", "Toastie"],
] as const;

export type DevelopmentProfile = {
  email: string; username: string; legacyUsername: string; displayName: string;
  role: "USER" | "ADMIN" | "SYSTEM";
};

export const DEVELOPMENT_PARTICIPANTS: DevelopmentProfile[] = participants.map(([username, displayName], index) => {
  const legacyUsername = `simulation-trader-${String(index + 1).padStart(2, "0")}`;
  return { email: `${legacyUsername}@example.test`, username, displayName, legacyUsername, role: "USER" };
});

export const DEVELOPMENT_ADMINS: DevelopmentProfile[] = [
  ["captainquack", "Captain Quack"], ["papercrane", "Paper Crane"], ["nightowl", "Night Owl"],
].map(([username, displayName], index) => {
  const legacyUsername = `simulation-admin-${index + 1}`;
  return { email: `${legacyUsername}@example.test`, username, displayName, legacyUsername, role: "ADMIN" };
});

export const DEVELOPMENT_SYSTEM: DevelopmentProfile = {
  email: "simulation-system@example.test", username: "simulation-system", legacyUsername: "simulation-system",
  displayName: "Goosey Desk", role: "SYSTEM",
};

export const DEVELOPMENT_PROFILES = [...DEVELOPMENT_ADMINS, ...DEVELOPMENT_PARTICIPANTS, DEVELOPMENT_SYSTEM];

export function developmentProfileFor(email: unknown) {
  return DEVELOPMENT_PROFILES.find(profile => profile.email === email);
}

export function isDevelopmentIdentity(user: { email?: unknown; username?: unknown; role?: unknown }) {
  const profile = developmentProfileFor(user.email);
  return Boolean(profile && user.role === profile.role && [profile.username, profile.legacyUsername].includes(String(user.username)));
}
