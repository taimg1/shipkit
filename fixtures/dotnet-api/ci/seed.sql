-- Rows that apply-to-copy protects.
--
-- This file is the contract: whatever it inserts must still be there after a migration is
-- applied. Without rows, apply-to-copy can only see schema changes — and the rename trap is
-- precisely a schema change that looks fine and destroys data.
INSERT INTO orders ("Reference", "Total", "CreatedAt") VALUES
  ('ORD-0001', 10.00, now()),
  ('ORD-0002', 20.00, now()),
  ('ORD-0003', 30.00, now());
