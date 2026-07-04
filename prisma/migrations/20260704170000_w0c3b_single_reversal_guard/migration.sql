CREATE UNIQUE INDEX IF NOT EXISTS je_single_reversal_idx
ON journal_entries (reversal_of)
WHERE reversal_of IS NOT NULL;
