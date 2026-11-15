-- Saving a running machine does not end its screen lifecycle. A completed stop,
-- a new start, or a different provider/reference must still revoke existing links.
CREATE OR REPLACE FUNCTION revoke_computer_screens() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW."providerRef" IS DISTINCT FROM OLD."providerRef"
    OR (
      NEW.state IS DISTINCT FROM OLD.state
      AND NOT (OLD.state = 'booting' AND NEW.state = 'running')
      AND NOT (
        OLD.state IN ('running', 'suspending')
        AND NEW.state IN ('running', 'suspending')
      )
    ) THEN
    NEW."screenGeneration" := OLD."screenGeneration" + 1;
  END IF;
  RETURN NEW;
END;
$$;
