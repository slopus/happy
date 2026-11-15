ALTER TABLE "chat_groups" ADD CONSTRAINT "chat_groups_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "bot_sections"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
