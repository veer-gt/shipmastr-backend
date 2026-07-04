ALTER TABLE "journal_entries" ADD COLUMN "reversal_of" TEXT;

CREATE INDEX "journal_entries_reversal_of_idx" ON "journal_entries"("reversal_of");

ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversal_of_fkey"
  FOREIGN KEY ("reversal_of") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
