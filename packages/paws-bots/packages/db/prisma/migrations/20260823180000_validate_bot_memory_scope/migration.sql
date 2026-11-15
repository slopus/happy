-- ValidateConstraint
-- Kept separate from creation so PostgreSQL validates existing rows without holding an
-- ACCESS EXCLUSIVE lock on the bots table for the duration of the scan.
ALTER TABLE "bots" VALIDATE CONSTRAINT "bots_memoryScope_check";
