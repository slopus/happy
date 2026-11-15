import { pawsFetch } from "../paws/runtime";
import { passkeyClient } from "@better-auth/passkey/client";
import { SIGNUP_SURFACE_HEADER } from "@rakazo/contracts";
import { rememberSignupAttribution } from "@rakazo/core/signup-attribution";
import type { OrganizationClientOptions } from "better-auth/client/plugins";
import { emailOTPClient, organizationClient } from "better-auth/client/plugins";
import type { ReactAuthClient } from "better-auth/react";
import { createAuthClient } from "better-auth/react";
import { desktopBridge } from "./desktop";

const signupSurface = desktopBridge() ? "desktop" : "web";
if (typeof window !== "undefined") rememberSignupAttribution(window);

export const authClient: ReactAuthClient<{
  // An uninstantiated generic resolves to `any`, which would erase every plugin's actions.
  plugins: [
    ReturnType<typeof organizationClient<OrganizationClientOptions>>,
    ReturnType<typeof emailOTPClient>,
    ReturnType<typeof passkeyClient>,
  ];
}> = createAuthClient({
  baseURL: `${window.location.origin}/api/auth`,
  sessionOptions: { refetchInterval: 0, refetchOnWindowFocus: false },
  fetchOptions: {
    customFetchImpl: pawsFetch,
    headers: { [SIGNUP_SURFACE_HEADER]: signupSurface },
  },
  plugins: [organizationClient(), emailOTPClient(), passkeyClient()],
});
