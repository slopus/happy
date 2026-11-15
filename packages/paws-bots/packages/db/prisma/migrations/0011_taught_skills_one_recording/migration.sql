-- One live teaching session per bot.
CREATE UNIQUE INDEX "taught_skills_botId_recording_key" ON "taught_skills"("botId") WHERE status = 'recording';
