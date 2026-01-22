/*
  Warnings:

  - The values [accepted,removed] on the enum `RelationshipStatus` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "RelationshipStatus_new" AS ENUM ('none', 'requested', 'pending', 'friend', 'rejected');
ALTER TABLE "UserRelationship" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "UserRelationship" ALTER COLUMN "status" TYPE "RelationshipStatus_new" USING ("status"::text::"RelationshipStatus_new");
ALTER TYPE "RelationshipStatus" RENAME TO "RelationshipStatus_old";
ALTER TYPE "RelationshipStatus_new" RENAME TO "RelationshipStatus";
DROP TYPE "RelationshipStatus_old";
ALTER TABLE "UserRelationship" ALTER COLUMN "status" SET DEFAULT 'pending';
COMMIT;
