-- Blind-index tokens for searching encrypted inbox mail; NULL until encrypted.
ALTER TABLE "bot_email_messages" ADD COLUMN "searchTokens" INTEGER[];

-- Inbox mail was never encrypted before, so text here that looks like ciphertext came from a
-- sender; a zero-width space keeps reads from treating it as a value under a missing key.
UPDATE "bot_email_messages" SET "fromAddress" = chr(8203) || "fromAddress" WHERE "fromAddress" LIKE 'rkz1:%';
UPDATE "bot_email_messages" SET "fromName" = chr(8203) || "fromName" WHERE "fromName" LIKE 'rkz1:%';
UPDATE "bot_email_messages" SET "subject" = chr(8203) || "subject" WHERE "subject" LIKE 'rkz1:%';
UPDATE "bot_email_messages" SET "text" = chr(8203) || "text" WHERE "text" LIKE 'rkz1:%';
