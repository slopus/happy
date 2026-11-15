-- IANA timezone (e.g. "Pacific/Auckland"); NULL until the user or their browser sets it.
ALTER TABLE "user" ADD COLUMN "timezone" TEXT;
