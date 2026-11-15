import { z } from "zod";

/** Owner-session revoke: DELETE `${USER_DEVICE_PATH}/:deviceId`. Device-token self revoke: DELETE `${USER_DEVICE_PATH}/self`. */
export const USER_DEVICE_PATH = "/api/devices";
export const USER_DEVICE_PAIR_PATH = `${USER_DEVICE_PATH}/pair`;
export const USER_DEVICE_CONNECT_PATH = `${USER_DEVICE_PATH}/connect`;
/** POST with the device token and the sign-in cookie: ties a pairing that predates session tracking to that sign-in. */
export const USER_DEVICE_SESSION_PATH = `${USER_DEVICE_PATH}/self/session`;

export const userDevicePairRequest = z.object({
  name: z.string().min(1).max(128),
  platform: z.enum(["darwin", "win32", "linux"]),
});
export type UserDevicePairRequest = z.infer<typeof userDevicePairRequest>;

export interface UserDevicePairResponse {
  deviceId: string;
  /** The account it was paired for. This computer's consent belongs to that account. */
  userId: string;
  /** Shown once. The server keeps only its hash. */
  token: string;
}

export const userDeviceListSchema = z.object({
  devices: z.array(
    z.object({
      deviceId: z.string(),
      name: z.string(),
      connected: z.boolean(),
    }),
  ),
});
export type UserDeviceList = z.infer<typeof userDeviceListSchema>;
export type UserDeviceSummary = UserDeviceList["devices"][number];
