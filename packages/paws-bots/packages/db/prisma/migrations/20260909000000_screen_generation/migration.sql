ALTER TABLE "bots" ADD COLUMN "screenGeneration" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "computers" ADD COLUMN "screenGeneration" INTEGER NOT NULL DEFAULT 0;

-- Database fences cover lifecycle writes from the API, workers, and recovery paths.
-- A resumed provider may reuse its address and reference; old URLs must stay revoked.
CREATE FUNCTION revoke_computer_screens() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.state IS DISTINCT FROM OLD.state AND NOT (OLD.state = 'booting' AND NEW.state = 'running'))
    OR NEW."providerRef" IS DISTINCT FROM OLD."providerRef" THEN
    NEW."screenGeneration" := OLD."screenGeneration" + 1;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER revoke_computer_screens BEFORE UPDATE ON "computers"
FOR EACH ROW EXECUTE FUNCTION revoke_computer_screens();

CREATE FUNCTION revoke_bot_screens() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."computerId" IS DISTINCT FROM OLD."computerId" OR NEW."archivedAt" IS DISTINCT FROM OLD."archivedAt" THEN
    NEW."screenGeneration" := OLD."screenGeneration" + 1;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER revoke_bot_screens BEFORE UPDATE ON "bots"
FOR EACH ROW EXECUTE FUNCTION revoke_bot_screens();
