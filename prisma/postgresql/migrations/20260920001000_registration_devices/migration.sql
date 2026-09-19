CREATE TABLE "RegistrationDevice" (
  "id" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "userId" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RegistrationDevice_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RegistrationDevice_tokenHash_check" CHECK (char_length("tokenHash") = 43)
);

CREATE UNIQUE INDEX "RegistrationDevice_tokenHash_key" ON "RegistrationDevice"("tokenHash");
CREATE INDEX "RegistrationDevice_userId_idx" ON "RegistrationDevice"("userId");
CREATE INDEX "RegistrationDevice_createdAt_idx" ON "RegistrationDevice"("createdAt");

ALTER TABLE "RegistrationDevice" ADD CONSTRAINT "RegistrationDevice_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
