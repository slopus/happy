import * as z from "zod";
import { Id } from "./ids.js";

/** Where an account-owned item is available: every space, or these (starting with the one it was added in). */
export const SpaceAvailabilitySchema = z.object({
  allSpaces: z.boolean(),
  spaceIds: z.array(Id).min(1),
});
export type SpaceAvailability = z.infer<typeof SpaceAvailabilitySchema>;
