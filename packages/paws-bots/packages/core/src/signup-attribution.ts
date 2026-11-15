import type { SignupAttribution as Attribution } from "@rakazo/contracts";
import {
  SIGNUP_ATTRIBUTION_COOKIE,
  SIGNUP_SURFACE_HEADER,
  SignupAttribution,
  SignupSurface,
} from "@rakazo/contracts";

export function signupAttributionFromCookie(cookie: string): Attribution {
  const encoded = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SIGNUP_ATTRIBUTION_COOKIE}=`))
    ?.slice(SIGNUP_ATTRIBUTION_COOKIE.length + 1);
  if (!encoded || encoded.length > 3000) return {};
  try {
    return SignupAttribution.parse(JSON.parse(decodeURIComponent(encoded)));
  } catch {
    return {};
  }
}

export function signupAttributionFromHeaders(headers?: Headers): Attribution {
  const attribution = signupAttributionFromCookie(headers?.get("cookie") ?? "");
  const surface = SignupSurface.safeParse(headers?.get(SIGNUP_SURFACE_HEADER));
  return { ...attribution, ...(surface.success ? { surface: surface.data } : {}) };
}
