-- Homes kept in object storage: a random storage id for object keys, the home's data key
-- wrapped by the space's content key, and the revision currently stored. The key lives on the
-- computer row so deleting the computer (directly or through its bot, space or organization)
-- makes the stored objects unreadable at once; the worker then deletes the objects.
ALTER TABLE "computers" ADD COLUMN "homeStorageId" TEXT;
ALTER TABLE "computers" ADD COLUMN "homeStorageKey" TEXT;
ALTER TABLE "computers" ADD COLUMN "homeStorageRevision" TEXT;
CREATE UNIQUE INDEX "computers_homeStorageId_key" ON "computers"("homeStorageId");
