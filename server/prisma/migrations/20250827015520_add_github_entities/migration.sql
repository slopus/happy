-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "githubUserId" TEXT;

-- CreateTable
CREATE TABLE "GithubUser" (
    "id" TEXT NOT NULL,
    "profile" JSONB NOT NULL,
    "token" BYTEA,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GithubUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GithubOrganization" (
    "id" TEXT NOT NULL,
    "profile" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GithubOrganization_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_githubUserId_fkey" FOREIGN KEY ("githubUserId") REFERENCES "GithubUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
