-- Add "frozen" boolean field to acts table
-- Frozen acts: open but excluded from financials (profit, salary, expenses)
ALTER TABLE acts ADD COLUMN IF NOT EXISTS frozen boolean DEFAULT false;
