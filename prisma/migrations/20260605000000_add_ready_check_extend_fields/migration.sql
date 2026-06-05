-- AlterTable: add ready check / extend fields to Match
ALTER TABLE "Match"
  ADD COLUMN IF NOT EXISTS "extendedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "rcResolved"  BOOLEAN NOT NULL DEFAULT false;
