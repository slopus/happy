-- The main model lives in space_model_role_choices; nothing reads or writes this flag.
DROP INDEX "space_model_preferences_default_key";
DROP INDEX "space_model_preferences_spaceId_userId_isDefault_updatedAt_idx";
ALTER TABLE "space_model_preferences" DROP COLUMN "isDefault";
