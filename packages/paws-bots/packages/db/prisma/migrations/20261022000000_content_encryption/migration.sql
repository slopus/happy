-- Per-space data encryption keys, stored wrapped by a master key.
CREATE TABLE "space_keys" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "masterKeyId" TEXT NOT NULL,
    "wrappedKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "space_keys_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "space_keys_spaceId_version_key" ON "space_keys"("spaceId", "version");
CREATE INDEX "space_keys_masterKeyId_idx" ON "space_keys"("masterKeyId");

-- Keys are written on their own connection, so they cannot reference a space row
-- that the caller's transaction has not committed yet. Deleting a space, directly
-- or through an organization cascade, destroys its keys (crypto-shredding).
CREATE FUNCTION shred_space_keys() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "space_keys" WHERE "spaceId" = OLD.id;
  RETURN OLD;
END;
$$;
CREATE TRIGGER shred_space_keys AFTER DELETE ON "spaces"
FOR EACH ROW EXECUTE FUNCTION shred_space_keys();

-- Blind-index tokens for searching encrypted message blocks; NULL until encrypted.
ALTER TABLE "messages" ADD COLUMN "searchTokens" INTEGER[];
