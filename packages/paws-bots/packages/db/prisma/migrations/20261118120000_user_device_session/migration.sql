-- The session that paired a computer. Ending that session revokes the computer.
ALTER TABLE "user_devices" ADD COLUMN "sessionId" TEXT;
-- Why it was revoked, so the device can tell signing out from being removed.
ALTER TABLE "user_devices" ADD COLUMN "revokedBy" TEXT;
