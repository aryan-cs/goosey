PRAGMA foreign_keys=ON;

CREATE TABLE "RegistrationDevice" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tokenHash" TEXT NOT NULL CHECK (length("tokenHash") = 43),
  "userId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RegistrationDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "RegistrationDevice_tokenHash_key" ON "RegistrationDevice"("tokenHash");
CREATE INDEX "RegistrationDevice_userId_idx" ON "RegistrationDevice"("userId");
CREATE INDEX "RegistrationDevice_createdAt_idx" ON "RegistrationDevice"("createdAt");
