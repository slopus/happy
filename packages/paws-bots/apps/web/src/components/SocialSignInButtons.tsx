import { Trans } from "@lingui/react/macro";
import type { SignInProvider } from "@rakazo/contracts";
import { LAST_SIGN_IN_COOKIE, lastSignInChoice, signInProviderGroups } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { KeyRound, Mail } from "lucide-react";
import { useState } from "react";

function lastSignIn() {
  const prefix = `${LAST_SIGN_IN_COOKIE}=`;
  // Method ids are plain words, so the raw value is compared without decoding.
  return lastSignInChoice(
    document.cookie
      .split("; ")
      .find((cookie) => cookie.startsWith(prefix))
      ?.slice(prefix.length),
  );
}

function LastUsed() {
  return (
    <span className="absolute end-4 text-body-sm font-normal text-muted-foreground max-sm:-top-2.5 max-sm:end-3 max-sm:rounded-full max-sm:border max-sm:bg-card max-sm:px-2 max-sm:text-caption">
      <Trans>Last used</Trans>
    </span>
  );
}

export function SocialSignInButtons({
  providers,
  disabled,
  onPress,
  onEmail,
  onPasskey,
}: {
  providers: SignInProvider[];
  disabled?: boolean;
  onPress: (providerId: string) => void;
  onEmail?: () => void;
  onPasskey?: () => void;
}) {
  const [last] = useState(lastSignIn);
  if (providers.length === 0 && !onEmail && !onPasskey) return null;
  const { primary, secondary } = signInProviderGroups(providers);
  return (
    <div className="flex w-full flex-col gap-3">
      {primary.map((provider) => (
        <Button
          key={provider.id}
          type="button"
          variant="outline"
          size="xl"
          disabled={disabled}
          className="relative w-full min-w-0 shadow-none"
          onClick={() => onPress(provider.id)}
        >
          {provider.presentation?.mark ? (
            <svg viewBox={provider.presentation.mark.viewBox} className="size-5" aria-hidden="true">
              {provider.presentation.mark.paths.map((path) => (
                <path key={path.d} d={path.d} fill={path.fill ?? "currentColor"} />
              ))}
            </svg>
          ) : null}
          <span className="truncate">
            <Trans>Continue with {provider.name}</Trans>
          </span>
          {last === provider.id ? <LastUsed /> : null}
        </Button>
      ))}
      {onEmail ? (
        <Button
          type="button"
          variant="outline"
          size="xl"
          disabled={disabled}
          className="relative w-full min-w-0 shadow-none"
          onClick={onEmail}
        >
          <Mail />
          <Trans>Continue with email</Trans>
          {last === "email" ? <LastUsed /> : null}
        </Button>
      ) : null}
      {onPasskey ? (
        <Button
          type="button"
          variant="outline"
          size="xl"
          disabled={disabled}
          className="relative w-full min-w-0 shadow-none"
          onClick={onPasskey}
        >
          <KeyRound />
          <Trans>Continue with passkey</Trans>
          {last === "passkey" ? <LastUsed /> : null}
        </Button>
      ) : null}
      {secondary.map((provider) => (
        <Button
          key={provider.id}
          type="button"
          variant="text"
          size="sm"
          disabled={disabled}
          className="max-w-full min-w-0 self-center text-muted-foreground hover:text-foreground"
          onClick={() => onPress(provider.id)}
        >
          <span className="truncate">
            <Trans>Continue with {provider.name}</Trans>
          </span>
        </Button>
      ))}
    </div>
  );
}
