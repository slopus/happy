/** @jsxRuntime automatic */
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { INVITED_TRIAL_WEEKS } from "@rakazo/contracts";
import { Link, Text } from "react-email";
import { emailText, greeting, linkStyle, message } from "./email.js";

export function referralEmail(
  user: { email: string; name: string },
  invitePageUrl: string,
  unsubscribeUrl: string,
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  return message(
    user.email,
    locale,
    say("Invite a friend"),
    <>
      <Text>{greeting(say, user.name)}</Text>
      <Text>
        {say(
          "Invite a friend to Rakazo: they get {weeks} weeks free, and you earn a free month when they start a qualifying subscription with a new card.",
          { weeks: INVITED_TRIAL_WEEKS },
        )}{" "}
        <Link href={invitePageUrl} style={linkStyle}>
          {say("Open Rakazo")}
        </Link>{" "}
        {say("and choose Invite friends for your link.")}
      </Text>
      <Text>Elie</Text>
    </>,
    unsubscribeUrl,
  );
}
