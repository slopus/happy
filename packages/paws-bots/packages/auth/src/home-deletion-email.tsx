/** @jsxRuntime automatic */
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { Text } from "react-email";
import { Button, emailText, greeting, message } from "./email.js";

/** Why saved computer files are due for deletion. */
export type HomeDeletionReason = "plan-ended" | "unused";

export function homeDeletionEmail(
  user: { email: string; name: string },
  deletionDate: Date,
  reason: HomeDeletionReason,
  appUrl: string,
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(
    deletionDate,
  );
  return message(
    user.email,
    locale,
    say("Your saved computer files will be deleted"),
    <>
      <Text>{greeting(say, user.name)}</Text>
      <Text>
        {reason === "plan-ended"
          ? say("Your saved computer files will be deleted on {date} unless you resubscribe.", {
              date,
            })
          : say("Your saved computer files will be deleted on {date} unless you choose a plan.", {
              date,
            })}
      </Text>
      <Button href={appUrl}>{say("Open Rakazo")}</Button>
    </>,
  );
}
