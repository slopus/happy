-- CreateEnum
CREATE TYPE "RelationshipStatus" AS ENUM ('pending', 'accepted', 'rejected', 'removed');

-- CreateTable
CREATE TABLE "UserRelationship" (
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "status" "RelationshipStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),

    CONSTRAINT "UserRelationship_pkey" PRIMARY KEY ("fromUserId","toUserId")
);

-- CreateIndex
CREATE INDEX "UserRelationship_toUserId_status_idx" ON "UserRelationship"("toUserId", "status");

-- CreateIndex
CREATE INDEX "UserRelationship_fromUserId_status_idx" ON "UserRelationship"("fromUserId", "status");

-- AddForeignKey
ALTER TABLE "UserRelationship" ADD CONSTRAINT "UserRelationship_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRelationship" ADD CONSTRAINT "UserRelationship_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
