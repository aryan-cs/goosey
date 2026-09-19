-- Existing SQLite installations use additive schema upgrades (no migration baseline).
ALTER TABLE "User" ADD COLUMN "notificationPreferences" TEXT NOT NULL DEFAULT '{}';
