CREATE TABLE "signup_surveys" (
    "userId" TEXT NOT NULL,
    "reason" TEXT,
    "use" TEXT,
    "teamSize" TEXT,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signup_surveys_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "signup_surveys" ADD CONSTRAINT "signup_surveys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Only accounts created from here on are asked; existing users count as skipped.
INSERT INTO "signup_surveys" ("userId") SELECT "id" FROM "user";
