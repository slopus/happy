/** @jsxRuntime automatic */
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { displayName, matchUiLocale, textDirectionForLocale, translate } from "@rakazo/core";
import { webLightTokens as lightTokens, webDarkTokens } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { Fragment } from "react";
import {
  Body,
  Container,
  Button as EmailButton,
  Head,
  Hr,
  Html,
  Img,
  Link,
  render,
  Section,
  Text,
  toPlainText,
} from "react-email";
import { DE_MESSAGES } from "./locales/de.js";
import { ES_MESSAGES } from "./locales/es.js";
import { FR_MESSAGES } from "./locales/fr.js";
import { HE_MESSAGES } from "./locales/he.js";
import { HI_MESSAGES } from "./locales/hi.js";
import { JA_MESSAGES } from "./locales/ja.js";
import { KO_MESSAGES } from "./locales/ko.js";
import { NL_MESSAGES } from "./locales/nl.js";
import { PL_MESSAGES } from "./locales/pl.js";
import { PT_BR_MESSAGES } from "./locales/pt-BR.js";
import { RU_MESSAGES } from "./locales/ru.js";
import { TR_MESSAGES } from "./locales/tr.js";
import { ZH_CN_MESSAGES } from "./locales/zh-CN.js";
import { ZH_TW_MESSAGES } from "./locales/zh-TW.js";

/** Email copy by app language, keyed by the English text. Any other language reads English. */
export const CATALOGS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  de: DE_MESSAGES,
  es: ES_MESSAGES,
  fr: FR_MESSAGES,
  he: HE_MESSAGES,
  hi: HI_MESSAGES,
  ja: JA_MESSAGES,
  ko: KO_MESSAGES,
  nl: NL_MESSAGES,
  pl: PL_MESSAGES,
  "pt-BR": PT_BR_MESSAGES,
  ru: RU_MESSAGES,
  tr: TR_MESSAGES,
  "zh-CN": ZH_CN_MESSAGES,
  "zh-TW": ZH_TW_MESSAGES,
};
const LOCALES = Object.keys(CATALOGS);

/**
 * The language to write an email in: the person's saved app language, else the language of the
 * browser that asked for it, else English.
 */
export function emailLocale(saved: string | null | undefined, headers?: Headers | null): string {
  if (saved) return matchUiLocale(saved, LOCALES);
  // Keep the first supported language at the highest acceptable quality.
  let bestLocale = "en";
  let bestQuality = 0;
  for (const part of headers?.get("accept-language")?.split(",") ?? []) {
    const match = part
      .trim()
      .match(
        /^([a-z]{1,8}(?:[-_][a-z0-9]{1,8})*|\*)(?:\s*;\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?$/i,
      );
    if (!match) continue;
    const tag = match[1] ?? "";
    const quality = match[2] === undefined ? 1 : Number(match[2]);
    if (quality <= bestQuality) continue;
    const isEnglish = /^en(?:[-_]|$)/i.test(tag);
    const locale = isEnglish ? "en" : matchUiLocale(tag, LOCALES);
    // matchUiLocale also returns English for unsupported tags (including *).
    if (locale === "en" && !isEnglish) continue;
    bestLocale = locale;
    bestQuality = quality;
  }
  return bestLocale;
}

/** The language to email an account in, given the headers of the request that asked. */
export type EmailLocaleOf = (
  account: { id: string } | { email: string },
  headers?: Headers | null,
) => Promise<string>;

/** Translates email copy into `locale`, filling `{name}` placeholders. */
export function emailText(locale: string) {
  const catalog = CATALOGS[locale];
  return (text: string, values?: Record<string, string | number>) =>
    translate(catalog, text, values);
}

export function greeting(say: ReturnType<typeof emailText>, name: string): string {
  const shown = displayName(name, "");
  return shown ? say("Hi {name},", { name: shown }) : say("Hi there,");
}

export async function message(
  to: string,
  locale: string,
  subject: string,
  content: ReactNode,
  unsubscribeUrl?: string,
  image?: { src: string; alt: string },
): Promise<TransactionalEmail> {
  const html = await render(
    <Html lang={locale} dir={textDirectionForLocale(locale)}>
      <Head>
        <meta name="color-scheme" content="light dark" />
        <meta name="supported-color-schemes" content="light dark" />
        <style>{`@media (prefers-color-scheme: dark) {
          .email-body, .email-body > table > tbody > tr > td { background-color: ${webDarkTokens.background} !important; }
          .email-card { background-color: ${webDarkTokens.dialog} !important; color: ${webDarkTokens.foreground} !important; border-color: ${webDarkTokens.border} !important; }
          .email-card p, .email-card a { color: ${webDarkTokens.foreground} !important; }
          .email-card p.email-muted, .email-card p.email-muted a { color: ${webDarkTokens.mutedForeground} !important; }
          .email-card a.email-button { background-color: ${webDarkTokens.primary} !important; color: ${webDarkTokens.primaryForeground} !important; }
        }`}</style>
      </Head>
      <Body
        className="email-body"
        style={{
          backgroundColor: lightTokens.muted,
          color: lightTokens.foreground,
          fontFamily: "Arial, Helvetica, sans-serif",
          margin: 0,
          padding: "32px 12px",
        }}
      >
        <Container
          className="email-card"
          style={{
            maxWidth: "520px",
            backgroundColor: lightTokens.dialog,
            color: lightTokens.foreground,
            borderRadius: "12px",
            border: `1px solid ${lightTokens.border}`,
            overflow: "hidden",
          }}
        >
          {image ? (
            <Img
              src={image.src}
              alt={image.alt}
              width="520"
              style={{ width: "100%", height: "auto" }}
            />
          ) : null}
          <Section style={{ padding: "24px 32px" }}>
            {image ? null : (
              // Text, not a hosted logo: self-hosted servers send these too, and must not call out.
              <Text
                style={{
                  margin: "0 0 24px",
                  fontSize: "22px",
                  fontWeight: 600,
                  letterSpacing: "-0.5px",
                }}
              >
                rakazo
              </Text>
            )}
            {content}
            {unsubscribeUrl ? (
              <>
                <Hr style={{ borderColor: lightTokens.border, marginTop: "28px" }} />
                <FinePrint>
                  <Link href={unsubscribeUrl} style={{ color: lightTokens.mutedForeground }}>
                    {emailText(locale)("Unsubscribe")}
                  </Link>
                </FinePrint>
              </>
            ) : null}
          </Section>
        </Container>
      </Body>
    </Html>,
  );
  return {
    to,
    subject,
    html,
    text: toPlainText(html),
    ...(unsubscribeUrl
      ? {
          headers: {
            "List-Unsubscribe": `<${unsubscribeUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
        }
      : {}),
  };
}

export const linkStyle = { color: lightTokens.primary, textDecoration: "underline" };

/** The one action an email asks for. */
export function Button({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Section style={{ margin: "24px 0" }}>
      <EmailButton
        href={href}
        className="email-button"
        style={{
          backgroundColor: lightTokens.primary,
          color: lightTokens.primaryForeground,
          borderRadius: "8px",
          padding: "11px 20px",
          fontSize: "15px",
          fontWeight: 600,
          textDecoration: "none",
        }}
      >
        {children}
      </EmailButton>
    </Section>
  );
}

export function Code({ children }: { children: string }) {
  return (
    <Text
      style={{
        margin: "24px 0",
        fontFamily: "ui-monospace, Menlo, Consolas, monospace",
        fontSize: "28px",
        fontWeight: 600,
        letterSpacing: "6px",
      }}
    >
      {children}
    </Text>
  );
}

/** Expiry notes and "ignore this email" lines. */
export function FinePrint({ children }: { children: ReactNode }) {
  return (
    <Text
      className="email-muted"
      style={{ color: lightTokens.mutedForeground, fontSize: "13px", marginBottom: 0 }}
    >
      {children}
    </Text>
  );
}

/** Places each `{key}` of a translated sentence as its node, so links sit where the language puts them. */
export function withNodes(
  sentence: string,
  nodes: Readonly<Record<string, ReactNode>>,
): ReactNode[] {
  return sentence.split(/\{(\w+)\}/).map((part, index) => (
    // split puts each captured key at an odd index.
    <Fragment key={`${index}${part}`}>{index % 2 ? nodes[part] : part}</Fragment>
  ));
}

export function verificationEmail(
  email: string,
  url: string,
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  return message(
    email,
    locale,
    say("Verify your Rakazo email"),
    <>
      <Button href={url}>{say("Verify email")}</Button>
      <Text>{say("Then return to Rakazo to sign in.")}</Text>
      <FinePrint>
        {say("This link expires in one hour. If you did not register, ignore this email.")}
      </FinePrint>
    </>,
  );
}

export function signInCodeEmail(
  email: string,
  code: string,
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  return message(
    email,
    locale,
    say("Your Rakazo sign-in code"),
    <>
      <Text>{say("Enter this code to sign in to Rakazo:")}</Text>
      <Code>{code}</Code>
      <FinePrint>
        {say("This code expires in ten minutes. If you did not request it, ignore this email.")}
      </FinePrint>
    </>,
  );
}

export function passwordResetEmail(
  user: { id: string; email: string; name: string },
  resetUrl: string,
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  return message(
    user.email,
    locale,
    say("Reset your Rakazo password"),
    <>
      <Text>{greeting(say, user.name)}</Text>
      <Text>{say("Reset your Rakazo password:")}</Text>
      <Button href={resetUrl}>{say("Reset password")}</Button>
      <FinePrint>
        {say(
          "This link expires in one hour. If you did not request this, you can ignore this email.",
        )}
      </FinePrint>
    </>,
  );
}

export function accountDeletionEmail(
  email: string,
  code: string,
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  return message(
    email,
    locale,
    say("Confirm Rakazo account deletion"),
    <>
      <Text>{say("Enter this code in Rakazo to delete your account:")}</Text>
      <Code>{code}</Code>
      <FinePrint>
        {say(
          "This code expires in ten minutes. If you did not request deletion, ignore this email.",
        )}
      </FinePrint>
    </>,
  );
}

export function identityCodeEmail(
  email: string,
  code: string,
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  return message(
    email,
    locale,
    say("Your Rakazo confirmation code"),
    <>
      <Text>{say("Enter this code in Rakazo to confirm it's you:")}</Text>
      <Code>{code}</Code>
      <FinePrint>
        {say("This code expires in ten minutes. If you did not request it, ignore this email.")}
      </FinePrint>
    </>,
  );
}
