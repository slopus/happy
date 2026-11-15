/** @jsxRuntime automatic */
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { ANDROID_APP_STORE_URL, IOS_APP_STORE_URL } from "@rakazo/contracts";
import { Link, Text } from "react-email";
import { emailText, greeting, linkStyle, message, withNodes } from "./email.js";

const APPS: Readonly<Record<string, string>> = {
  iPhone: IOS_APP_STORE_URL,
  Android: ANDROID_APP_STORE_URL,
  Mac: "https://rakazo.com/api/download?platform=mac",
  Windows: "https://rakazo.com/api/download?platform=windows",
  Linux: "https://rakazo.com/api/download?platform=linux",
};

const stepStyle = { margin: "20px 0 4px" };

export function welcomeEmail(
  user: { email: string; name: string },
  unsubscribeUrl: string,
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  return message(
    user.email,
    locale,
    say("Welcome to Rakazo"),
    <>
      <Text>{greeting(say, user.name)}</Text>
      <Text>
        {say("Welcome to Rakazo. The people who get the most out of it do three things:")}
      </Text>
      <Text style={stepStyle}>
        <strong>1. {say("Get the apps")}</strong>
      </Text>
      <Text style={{ marginTop: 0 }}>
        {withNodes(
          say("Rakazo runs on {platforms}, so your bots can reach you wherever you are."),
          {
            // The language's own list ("A, B, and C", "A, B y C"), with each app a link.
            platforms: new Intl.ListFormat(locale, { type: "conjunction" })
              .formatToParts(Object.keys(APPS))
              .map((part, index) =>
                part.type === "element" ? (
                  <Link key={part.value} href={APPS[part.value]} style={linkStyle}>
                    {part.value}
                  </Link>
                ) : (
                  <span key={`${index}${part.value}`}>{part.value}</span>
                ),
              ),
          },
        )}
      </Text>
      <Text style={stepStyle}>
        <strong>2. {say("Join the community")}</strong>
      </Text>
      <Text style={{ marginTop: 0 }}>
        {withNodes(
          say(
            "See what others are building, get help fast, and tell us what to build next on {discord}.",
          ),
          {
            discord: (
              <Link href="https://discord.gg/RWwKa2Sn7h" style={linkStyle}>
                Discord
              </Link>
            ),
          },
        )}
      </Text>
      <Text style={stepStyle}>
        <strong>3. {say("Star us on GitHub")}</strong>
      </Text>
      <Text style={{ marginTop: 0 }}>
        {withNodes(say("Rakazo is open source. {star} helps more people find it."), {
          star: (
            <Link href="https://github.com/elie222/rakazo" style={linkStyle}>
              {say("A star on GitHub")}
            </Link>
          ),
        })}
      </Text>
      <Text style={{ marginTop: "28px" }}>{say("Questions? Just reply. I read every one.")}</Text>
      <Text>Elie</Text>
    </>,
    unsubscribeUrl,
    { src: "https://rakazo.com/email/welcome.jpg", alt: "Rakazo" },
  );
}
