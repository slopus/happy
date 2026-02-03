-- AlterTable
ALTER TABLE "TerminalAuthRequest" ADD COLUMN     "responseAccountId" TEXT;

-- AddForeignKey
ALTER TABLE "TerminalAuthRequest" ADD CONSTRAINT "TerminalAuthRequest_responseAccountId_fkey" FOREIGN KEY ("responseAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
