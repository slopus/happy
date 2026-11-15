-- Vault keys live in space_keys as "vault:<space id>" and "user:<member id>". Deleting the
-- Space or the member destroys them too (crypto-shredding), as it does the space's own keys.
CREATE OR REPLACE FUNCTION shred_space_keys() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "space_keys" WHERE "spaceId" IN (OLD.id, 'vault:' || OLD.id);
  RETURN OLD;
END;
$$;

CREATE FUNCTION shred_user_vault_keys() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "space_keys" WHERE "spaceId" = 'user:' || OLD.id;
  RETURN OLD;
END;
$$;
CREATE TRIGGER shred_user_vault_keys AFTER DELETE ON "user"
FOR EACH ROW EXECUTE FUNCTION shred_user_vault_keys();
