import { z } from "zod";
import { AGENT_SECRET_NAME_PATTERN } from "./agent-secret-name.js";
import { Id } from "./ids.js";
import { isCloudMetadataHost, isPrivateNetworkHost } from "./network-host.js";
import { settingsScopeInput } from "./settings-scope.js";

// An opaque reference handle: matched exactly by secret_request/forget_secret,
// displayed in list_secrets. Never interpolated into shells, env, or URLs, so
// hyphens are safe.
export const BotSecretName = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);

// A name read back from storage. It is deliberately looser than BotSecretName so a row saved
// before the pattern tightened stays listable and removable instead of failing a whole list call.
export const StoredBotSecretName = z.string().min(1).max(256);

const SecretHeaderName = z
  .string()
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,120}$/)
  .refine(
    (name) =>
      !/^(host|connection|content-length|content-type|transfer-encoding|te|trailer|upgrade|cookie|origin|referer|accept|proxy-.*|sec-.*|.*forwarded.*)$/i.test(
        name,
      ),
    "Unsupported credential header",
  );

export const BotSecretAuth = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bearer") }),
  z.object({ type: z.literal("header"), name: SecretHeaderName }),
  z.object({
    type: z.literal("basic"),
    username: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^:\r\n]+$/),
  }),
  // A website sign-in. Its fields are all protected; the backend only types them into pages on
  // the saved origin and never sends them as HTTP credentials.
  z.object({ type: z.literal("login") }),
  // A value exported to this bot's shell commands as an environment variable. It has no site.
  z.object({ type: z.literal("command") }),
  // A payment card. Typed only into a checkout the person approves each time; the bot sees only
  // its brand, last four digits and expiry.
  z.object({ type: z.literal("card") }),
  // A person's name, address, phone or email. Not secret: the bot reads it to fill in forms.
  z.object({ type: z.literal("contact") }),
]);
export type BotSecretAuthType = z.infer<typeof BotSecretAuth>["type"];

/** Kinds saved without a site: command variables reach shell commands, cards and contacts any page. */
export function isSitelessAuth(type: BotSecretAuthType): type is "command" | "card" | "contact" {
  return type === "command" || type === "card" || type === "contact";
}

// Names that change how shells and common runtimes start, where they load code from, or how
// they reach the network. A bot's command variable must never override them. The list is not
// exhaustive: it covers the well-known variables, and the prefix rules below catch whole
// families. Treat an unlisted name as allowed, not as proof it is harmless.
const RESERVED_COMMAND_VARIABLE_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "OLDPWD",
  "TERM",
  "IFS",
  "ENV",
  "BASH_ENV",
  "BASHOPTS",
  "SHELLOPTS",
  "CDPATH",
  "GLOBIGNORE",
  "PROMPT_COMMAND",
  "PS4",
  "TMPDIR",
  "DISPLAY",
  "XAUTHORITY",
  "SSH_AUTH_SOCK",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "PERL5LIB",
  "PERL5OPT",
  "RUBYOPT",
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  // TLS trust: these redirect which certificates common clients accept, or disable the check.
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "SSLKEYLOGFILE",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "GIT_SSL_CAINFO",
  "GIT_SSL_NO_VERIFY",
  // OpenSSL config, engine, and module paths can load attacker-controlled code.
  "OPENSSL_CONF",
  "OPENSSL_ENGINES",
  "OPENSSL_MODULES",
  // Commands and programs git and ssh run on their own behalf.
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
  "GIT_PROXY_COMMAND",
  "GIT_EXTERNAL_DIFF",
  "GIT_PAGER",
  "GIT_EDITOR",
  "GIT_EXEC_PATH",
  "GIT_TEMPLATE_DIR",
  // A glibc path that can load extra locale or conversion modules.
  "GCONV_PATH",
  "SSH_ASKPASS",
  "SSH_ASKPASS_REQUIRE",
]);
// Whole families a single variable name cannot enumerate: dynamic-loader injection, Rakazo's own
// namespace, git's config file set, and npm's configuration overrides.
const RESERVED_COMMAND_VARIABLE_PREFIXES = [
  "LD_",
  "DYLD_",
  "RAKAZO_",
  "GIT_CONFIG_",
  "NPM_CONFIG_",
];

/** The environment variable a command credential is exported as: `netbird-setup-key` → `NETBIRD_SETUP_KEY`. */
export function commandVariableName(credentialName: string): string {
  return credentialName.toUpperCase().replace(/-/g, "_");
}

/** Why a variable name cannot be exported, or undefined when it can. */
export function commandVariableProblem(variable: string): "invalid" | "reserved" | undefined {
  if (!AGENT_SECRET_NAME_PATTERN.test(variable)) return "invalid";
  if (
    RESERVED_COMMAND_VARIABLE_NAMES.has(variable) ||
    RESERVED_COMMAND_VARIABLE_PREFIXES.some((prefix) => variable.startsWith(prefix))
  ) {
    return "reserved";
  }
  return undefined;
}

function commandVariableNameIssue(credentialName: string): string | undefined {
  const variable = commandVariableName(credentialName);
  const problem = commandVariableProblem(variable);
  if (problem === "reserved") {
    return `$${variable} is reserved and cannot be used as a command variable; choose another name`;
  }
  if (problem === "invalid") return `$${variable} is not a valid environment variable name`;
  return undefined;
}

function botSecretOriginSchema(allowPrivateHttpOrigin: boolean) {
  return z
    .string()
    .max(2048)
    .refine(
      (value) => {
        try {
          const url = new URL(value);
          if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
            return false;
          }
          if (isCloudMetadataHost(url.hostname)) return false;
          if (url.protocol === "https:") return true;
          return (
            allowPrivateHttpOrigin && url.protocol === "http:" && isPrivateNetworkHost(url.hostname)
          );
        } catch {
          return false;
        }
      },
      allowPrivateHttpOrigin
        ? "Expected an HTTPS origin, or an HTTP origin on a private LAN host, without a path, credentials, query, or fragment"
        : "Expected an HTTPS origin without a path, credentials, query, or fragment",
    );
}

export const BOT_SECRET_ORIGIN_MISSING_MESSAGE =
  "Missing. Add the site's address, such as https://www.example.com";

export function botSecretDestinationSchema(options?: { allowPrivateHttpOrigin?: boolean }) {
  const originSchema = botSecretOriginSchema(options?.allowPrivateHttpOrigin === true);
  return z
    .object({
      name: BotSecretName,
      // Empty for a command variable, card or contact, which have no site. Every other type needs one.
      origin: z
        .string()
        .max(2048)
        .default("")
        .describe(
          "The site's address, such as https://www.example.com. Required unless auth is command, card or contact.",
        ),
      auth: BotSecretAuth,
    })
    .superRefine((destination, ctx) => {
      if (isSitelessAuth(destination.auth.type)) {
        if (destination.origin !== "") {
          ctx.addIssue({
            code: "custom",
            path: ["origin"],
            message: `A ${destination.auth.type === "command" ? "command variable" : destination.auth.type} has no site; leave origin empty`,
          });
        }
        if (destination.auth.type !== "command") return;
        const nameIssue = commandVariableNameIssue(destination.name);
        if (nameIssue) ctx.addIssue({ code: "custom", path: ["name"], message: nameIssue });
        return;
      }
      if (destination.origin === "") {
        // Say it is missing: "Expected an HTTPS origin" reads as a bad value, and models resend it.
        ctx.addIssue({
          code: "custom",
          path: ["origin"],
          message: BOT_SECRET_ORIGIN_MISSING_MESSAGE,
        });
        return;
      }
      const origin = originSchema.safeParse(destination.origin);
      if (!origin.success) {
        for (const issue of origin.error.issues) {
          ctx.addIssue({ code: "custom", path: ["origin"], message: issue.message });
        }
        return;
      }
      // Private-LAN plain HTTP is for API credentials only. A website login is typed into a page.
      if (destination.auth.type !== "login") return;
      try {
        if (new URL(destination.origin).protocol === "https:") return;
      } catch {
        /* The origin schema already rejects unparseable values. */
      }
      ctx.addIssue({
        code: "custom",
        path: ["origin"],
        message: "Website logins require an HTTPS origin",
      });
    });
}
export const BotSecretDestination = botSecretDestinationSchema();
export type BotSecretDestination = z.infer<typeof BotSecretDestination>;

export const BOT_SECRET_VALUE_MAX_LENGTH = 16_384;

/** The one page a texted or emailed code may be typed into: HTTPS only, and it is never saved. */
export const OneTimeCodeTarget = z.object({ origin: botSecretOriginSchema(false) });
export type OneTimeCodeTarget = z.infer<typeof OneTimeCodeTarget>;

export const ONE_TIME_CODE_MIN_LENGTH = 4;
export const ONE_TIME_CODE_MAX_LENGTH = 12;

/**
 * The code as typed into a page: spaces dropped ("123 456"), then groups of letters and digits
 * joined by single dashes, at least 4 of them and at most 12 characters in all. Anything shorter
 * or odder is not a code, so it is never kept or redacted.
 */
export function normalizeOneTimeCode(answer: string): string | undefined {
  const code = answer.replace(/\s+/g, "");
  return code.length <= ONE_TIME_CODE_MAX_LENGTH &&
    code.replaceAll("-", "").length >= ONE_TIME_CODE_MIN_LENGTH &&
    /^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/.test(code)
    ? code
    : undefined;
}

export const LOGIN_FIELD_LIMIT = 8;
export const LoginFieldLabel = z.string().trim().min(1).max(64);
/** What a login asks for when no field labels are given, and what a saved username/password pair reads as. */
export const DEFAULT_LOGIN_FIELD_LABELS = ["Username", "Password"] as const;

/**
 * One value of a website login. A hidden value is typed only into a password field; a visible
 * one into any text field on the login's site. Only the person chooses which.
 */
export const LoginFieldInput = z.object({
  label: LoginFieldLabel,
  value: z.string().max(4096),
  hidden: z.boolean(),
});
export type LoginFieldInput = z.infer<typeof LoginFieldInput>;
export const LoginField = LoginFieldInput.transform((field) =>
  field.hidden ? field : { ...field, value: field.value.trim() },
).refine((field) => field.value.length > 0, "Enter a value");
export type LoginField = z.infer<typeof LoginField>;

export function sameLoginFieldLabel(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function uniqueLabels(labels: readonly string[]): boolean {
  return new Set(labels.map((label) => label.trim().toLowerCase())).size === labels.length;
}

export const LoginFieldLabels = z
  .array(LoginFieldLabel)
  .min(1)
  .max(LOGIN_FIELD_LIMIT)
  .refine(uniqueLabels, "Give each field a different label");

export type AuthenticatorKey = {
  secret: string;
  algorithm: "sha1" | "sha256" | "sha512";
  digits: number;
  period: number;
};

export const AUTHENTICATOR_KEY_UNREADABLE = "This authenticator key can't be read.";
const AUTHENTICATOR_KEY_MAX_LENGTH = 1024;

/**
 * An authenticator key as people paste it: a base32 secret, spaces, dashes and case ignored, or an
 * otpauth://totp link, whose algorithm, digits and period are kept. Undefined when it is neither,
 * or when its secret can't be whole bytes.
 */
export function authenticatorKey(text: string): AuthenticatorKey | undefined {
  // The longest a login keeps, so every check that accepts a key also saves it.
  if (text.trim().length > AUTHENTICATOR_KEY_MAX_LENGTH) return undefined;
  let secret = text;
  const options = { algorithm: "sha1", digits: 6, period: 30 } as AuthenticatorKey;
  if (/^otpauth:/i.test(text.trim())) {
    if (!URL.canParse(text.trim())) return undefined;
    const url = new URL(text.trim());
    if (url.host.toLowerCase() !== "totp") return undefined;
    // Parameter names are matched without case, so a link with SECRET= reads as one with secret=.
    const params = new URLSearchParams(
      [...url.searchParams].map(([k, v]) => [k.toLowerCase(), v] as [string, string]),
    );
    secret = params.get("secret") ?? "";
    const algorithm = (params.get("algorithm") ?? "SHA1").toLowerCase();
    if (algorithm !== "sha1" && algorithm !== "sha256" && algorithm !== "sha512") return undefined;
    options.algorithm = algorithm;
    options.digits = Number(params.get("digits") ?? 6);
    options.period = Number(params.get("period") ?? 30);
    // What authenticator apps show, so a code typed here is the one the site expects.
    if (![6, 8].includes(options.digits) || ![30, 60].includes(options.period)) return undefined;
  }
  secret = secret.replace(/[\s-]/g, "").toUpperCase();
  const padding = secret.length - secret.replace(/=+$/, "").length;
  secret = secret.slice(0, secret.length - padding);
  // A key is whole bytes: 1, 3 or 6 characters past a group of eight never are, and padding,
  // when there is any, fills the last group exactly. Otherwise a mistyped key gives wrong codes.
  const remainder = secret.length % 8;
  if ([1, 3, 6].includes(remainder) || (padding > 0 && padding !== (8 - remainder) % 8))
    return undefined;
  return /^[A-Z2-7]{16,256}$/.test(secret) ? { ...options, secret } : undefined;
}

export const LoginSecretValue = z
  .object({
    fields: z.array(LoginField).min(1).max(LOGIN_FIELD_LIMIT),
    /** The authenticator key, opt-in; never typed itself, only the code it makes. */
    otp: z
      .string()
      .trim()
      .max(AUTHENTICATOR_KEY_MAX_LENGTH)
      .refine(
        (otp) => otp === "" || authenticatorKey(otp) !== undefined,
        "Invalid authenticator key",
      )
      .optional(),
  })
  .refine(
    (login) => uniqueLabels(login.fields.map((field) => field.label)),
    "Give each field a different label",
  )
  .refine(
    (login) => JSON.stringify(login).length <= BOT_SECRET_VALUE_MAX_LENGTH,
    "This login is too long",
  );
export type LoginSecretValue = z.infer<typeof LoginSecretValue>;

// Logins saved before fields existed. Never written again, so a release that predates fields
// fails to parse a new value instead of misreading it.
const LegacyLoginSecretValue = z.object({
  username: z.string().min(1).max(512),
  password: z.string().min(1).max(4096),
});

export function encodeLoginSecret(value: z.input<typeof LoginSecretValue>): string {
  return JSON.stringify(LoginSecretValue.parse(value));
}

export function decodeLoginSecret(plaintext: string): LoginSecretValue {
  const parsed: unknown = JSON.parse(plaintext);
  const legacy = LegacyLoginSecretValue.safeParse(parsed);
  if (!legacy.success) return LoginSecretValue.parse(parsed);
  const [username, password] = DEFAULT_LOGIN_FIELD_LABELS;
  return {
    fields: [
      { label: username, value: legacy.data.username, hidden: false },
      { label: password, value: legacy.data.password, hidden: true },
    ],
  };
}

// A field starts visible only when every word of its label is one of these and at least one is
// an identifier. Any other word, a misspelling or a look-alike letter included, keeps it hidden.
// English and Hebrew.
const IDENTIFIER_WORDS = new Set([
  "id",
  "user",
  "username",
  "login",
  "email",
  "mail",
  "phone",
  "mobile",
  "cell",
  "tel",
  "telephone",
  "account",
  "member",
  "customer",
  "זהות",
  "תז",
  "טלפון",
  "נייד",
  "פלאפון",
  "סלולרי",
  "מייל",
  "אימייל",
  "דואל",
  "משתמש",
  "חשבון",
  "לקוח",
  "חבר",
]);
const FILLER_WORDS = new Set([
  "number",
  "no",
  "num",
  "name",
  "address",
  "or",
  "and",
  "of",
  "your",
  "the",
  "last",
  "first",
  "digit",
  "digits",
  "national",
  "tax",
  "employee",
  "e",
  "תעודת",
  "מספר",
  "שם",
  "כתובת",
  "או",
  "של",
  "ו",
  "אחרונות",
  "ספרות",
  "לאומי",
  "עובד",
  "מס",
]);

function labelWords(label: string): string[] {
  return (
    label
      .normalize("NFKC")
      .normalize("NFD")
      .replace(/[\p{M}\p{Cf}]/gu, "")
      .toLowerCase()
      // Spaces and punctuation separate words; any other symbol or emoji is a word of its own, so a
      // label with one is not made only of known words.
      .match(/[\p{L}\p{N}.'"׳״]+|[^\p{L}\p{N}\p{Z}\s\p{P}№]/gu)
      ?.map((word) => word.replace(/[.'"׳״]/g, ""))
      .filter(Boolean) ?? []
  );
}

function knownWord(word: string, known: ReadonlySet<string>): boolean {
  // Hebrew attaches "the" to a word: הטלפון.
  return known.has(word) || (word.startsWith("ה") && known.has(word.slice(1)));
}

/** Whether a label is made only of identifier and plain filler words, such as "Phone number". */
export function isIdentifierLabel(label: string): boolean {
  const words = labelWords(label);
  return (
    words.some((word) => knownWord(word, IDENTIFIER_WORDS)) &&
    words.every(
      (word) =>
        /^\p{N}+$/u.test(word) ||
        knownWord(word, IDENTIFIER_WORDS) ||
        knownWord(word, FILLER_WORDS),
    )
  );
}

/**
 * The empty fields a login card starts with. The default Username and Password card starts as
 * logins always have, Username visible. Fields the bot names start hidden, except those whose
 * label is made only of identifier words (ID number, phone, email), which a sign-in without a
 * password field needs typed into a text field. The system decides this from the label alone; the bot
 * can't preset a field, and the person can switch any of them before saving.
 */
export function loginCardFields(requested: readonly string[] | undefined): LoginFieldInput[] {
  if (!requested) {
    return DEFAULT_LOGIN_FIELD_LABELS.map((label, index) => ({
      label,
      value: "",
      hidden: index > 0,
    }));
  }
  return requested.map((label) => ({ label, value: "", hidden: !isIdentifierLabel(label) }));
}

/**
 * The login a card's answer saves, or undefined unless it answers exactly the requested fields,
 * in order. An app that predates fields answers a Username and Password card with `username`
 * and the password as `answer`.
 */
export function loginAnswerValue(
  requested: readonly string[] | undefined,
  input: { answer: string; username?: string; fields?: readonly LoginFieldInput[] },
): LoginSecretValue | undefined {
  const labels = requested ?? DEFAULT_LOGIN_FIELD_LABELS;
  const [usernameLabel, passwordLabel] = DEFAULT_LOGIN_FIELD_LABELS;
  const legacy =
    !input.fields && input.username !== undefined
      ? [
          { label: usernameLabel, value: input.username, hidden: false },
          { label: passwordLabel, value: input.answer, hidden: true },
        ]
      : undefined;
  const fields = input.fields ?? legacy;
  if (
    !fields ||
    (input.fields && (input.answer !== "" || input.username !== undefined)) ||
    fields.length !== labels.length ||
    fields.some((field, index) => field.label.trim() !== labels[index])
  ) {
    return undefined;
  }
  return LoginSecretValue.safeParse({ fields }).data;
}

export const GENERATED_SECRET_SYMBOLS = "!@#$%^&*-_=+?";

/** Character rules for a password or other value the backend generates and saves for a bot. */
export const GeneratedSecretRules = z
  .object({
    length: z.number().int().min(8).max(128).default(20),
    lowercase: z.boolean().default(true),
    uppercase: z.boolean().default(true),
    digits: z.boolean().default(true),
    symbols: z.boolean().default(true),
    // Printable ASCII punctuation only, for sites and tools that accept just a few symbols.
    allowedSymbols: z
      .string()
      .regex(/^[!-/:-@[-`{-~]{1,32}$/, "Use only punctuation characters")
      .optional(),
  })
  .refine(
    (rules) => rules.lowercase || rules.uppercase || rules.digits || rules.symbols,
    "Allow at least one kind of character",
  );
export type GeneratedSecretRules = z.infer<typeof GeneratedSecretRules>;

/** A login is saved for one site with its username; a command variable reaches shell commands. */
export const GenerateSecretInput = z
  .object({
    name: BotSecretName,
    type: z.enum(["login", "command"]),
    origin: z.string().min(1).max(2048).optional(),
    username: LegacyLoginSecretValue.shape.username.optional(),
    // A login's password also saved as the command variable `<name>-password`, for a CLI.
    command: z.boolean().optional(),
    rules: GeneratedSecretRules.optional(),
  })
  .superRefine((input, ctx) => {
    if (input.type === "command") {
      if (input.command !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["command"],
          message: "Only a login can also be saved as a command variable",
        });
      }
      if (input.origin !== undefined || input.username !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["type"],
          message: "A command variable has no site or username",
        });
      }
      return;
    }
    if (input.origin === undefined) {
      ctx.addIssue({ code: "custom", path: ["origin"], message: "A login needs its site" });
    }
    if (input.username === undefined) {
      ctx.addIssue({ code: "custom", path: ["username"], message: "A login needs a username" });
    }
    if (input.command && !BotSecretName.safeParse(loginCommandName(input.name)).success) {
      ctx.addIssue({
        code: "custom",
        path: ["name"],
        message: "Use a name of at most 55 characters to also save a command variable",
      });
    }
  });

/** The command variable a generated login's password is also saved as. */
export function loginCommandName(loginName: string): string {
  return `${loginName}-password`;
}
export type GenerateSecretInput = z.infer<typeof GenerateSecretInput>;

/** Written atomically with the protected value, distinct from action approval. */
export function botSecretSubmissionSchema(options?: { allowPrivateHttpOrigin?: boolean }) {
  return z.object({ credentialSaved: botSecretDestinationSchema(options) });
}
export const BotSecretSubmission = botSecretSubmissionSchema();

const destinationInputShape = {
  name: BotSecretName,
  // Omitted or empty for a command variable, card or contact, which have no site.
  origin: z.string().max(2048).default(""),
  auth: BotSecretAuth,
};

function requireSite(
  destination: { origin: string; auth: { type: BotSecretAuthType } },
  ctx: z.RefinementCtx,
) {
  if (!isSitelessAuth(destination.auth.type) && destination.origin.length === 0) {
    ctx.addIssue({ code: "custom", path: ["origin"], message: "A site is required" });
  }
}

/**
 * Owner-facing destination input. Structural only: the origin rules depend on the server's
 * private-HTTP opt-in, so the server enforces them when it stores the value.
 */
export const BotSecretDestinationInput = z.object(destinationInputShape).superRefine(requireSite);

export const BotSecretPutInput = z.object({
  botId: Id,
  destination: BotSecretDestinationInput,
  value: z.string().min(1).max(BOT_SECRET_VALUE_MAX_LENGTH),
});
export type BotSecretPutInput = z.infer<typeof BotSecretPutInput>;

// ---- Cards and contacts ----

/** Trimmed text, or undefined when empty, so an untouched form field is not saved as "". */
function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .transform((value) => value || undefined)
    .optional();
}

/** The fields of a contact. Every one is optional, but a contact holds at least one. */
export const ContactFields = z.object({
  name: optionalText(200),
  line1: optionalText(200),
  line2: optionalText(200),
  city: optionalText(100),
  region: optionalText(100),
  postalCode: optionalText(20),
  country: optionalText(100),
  phone: optionalText(40),
  email: optionalText(254),
});
export type ContactFields = z.output<typeof ContactFields>;
export const CONTACT_FIELDS = Object.keys(ContactFields.shape) as (keyof ContactFields)[];

export const ContactSecretValue = ContactFields.strict().refine(
  (contact) => Object.values(contact).some(Boolean),
  "Fill in at least one field",
);
export type ContactSecretValue = z.output<typeof ContactSecretValue>;

/** Whether a card number passes the Luhn check every issuer's numbers do. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < digits.length; index++) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** Card numbers as people type them, with spaces or dashes, kept as digits only. */
export const CardNumber = z
  .string()
  .transform((value) => value.replace(/[\s-]/g, ""))
  .refine((digits) => /^\d{12,19}$/.test(digits) && luhnValid(digits), "Check the card number");

export const CardSecretValue = z
  .object({
    number: CardNumber,
    expMonth: z.number().int().min(1).max(12),
    expYear: z.number().int().min(2000).max(2100),
    cvc: z
      .string()
      .trim()
      .regex(/^(\d{3,4})?$/, "Check the security code")
      .optional()
      .transform((value) => value || undefined),
    name: optionalText(200),
    /** The name of a saved contact whose address bills this card. */
    billing: BotSecretName.optional(),
  })
  .strict();
export type CardSecretValue = z.output<typeof CardSecretValue>;

const CARD_BRANDS: [RegExp, string][] = [
  [/^4/, "Visa"],
  [/^(5[1-5]|222[1-9]|22[3-9]|2[3-6]|27[01]|2720)/, "Mastercard"],
  [/^3[47]/, "Amex"],
  [/^(6011|65|64[4-9]|622)/, "Discover"],
  [/^3(0[0-5]|[68])/, "Diners Club"],
  [/^35(2[89]|[3-8])/, "JCB"],
  [/^62/, "UnionPay"],
];

/** The card network a number belongs to, by its first digits; "Card" when it is not known. */
export function cardBrand(number: string): string {
  const digits = number.replace(/\D/g, "");
  return CARD_BRANDS.find(([prefix]) => prefix.test(digits))?.[1] ?? "Card";
}

export function cardSummary(card: CardSecretValue): CardSummary {
  return {
    brand: cardBrand(card.number),
    last4: card.number.slice(-4),
    expMonth: card.expMonth,
    expYear: card.expYear,
    ...(card.name ? { name: card.name } : {}),
    ...(card.billing ? { billing: card.billing } : {}),
  };
}

/** MM/YY, as checkouts and card faces show an expiry. */
export function cardExpiry(card: Pick<CardSummary, "expMonth" | "expYear">): string {
  return `${String(card.expMonth).padStart(2, "0")}/${String(card.expYear % 100).padStart(2, "0")}`;
}

/** "Visa ·· 4242", what a card is called when its owner gave it no title. */
export function cardTitle(card: Pick<CardSummary, "brand" | "last4">): string {
  return `${card.brand} ·· ${card.last4}`;
}

export function encodeCardSecret(value: z.input<typeof CardSecretValue>): string {
  return JSON.stringify(CardSecretValue.parse(value));
}

export function decodeCardSecret(plaintext: string): CardSecretValue {
  return CardSecretValue.parse(JSON.parse(plaintext));
}

export function encodeContactSecret(value: z.input<typeof ContactSecretValue>): string {
  return JSON.stringify(ContactSecretValue.parse(value));
}

export function decodeContactSecret(plaintext: string): ContactSecretValue {
  return ContactSecretValue.parse(JSON.parse(plaintext));
}

/**
 * Parse an expiry as people type it ("08/28", "8/2028", "0828") into a month and four-digit year,
 * or undefined when it is not one.
 */
export function parseCardExpiry(text: string): { expMonth: number; expYear: number } | undefined {
  const match = /^\s*(\d{1,2})\s*[/\-. ]?\s*(\d{2}|\d{4})\s*$/.exec(text);
  if (!match) return undefined;
  const expMonth = Number(match[1]);
  const year = Number(match[2]);
  if (expMonth < 1 || expMonth > 12) return undefined;
  return { expMonth, expYear: year < 100 ? 2000 + year : year };
}

/** What people call a vault item, such as "Home" or "Work card"; empty uses a default. */
export const VaultItemTitle = z.string().trim().max(80);
/** When the bot should use an item, such as "For travel". */
export const VaultItemNote = z.string().trim().max(200);

export const VAULT_ALSO_ON_LIMIT = 10;
/** The most items one vault holds. */
export const VAULT_ITEM_LIMIT = 100;

// A blocked item's value is still hidden in every run; a saved card still asks before each use.
// "ask" is for a website login: each browser_act call that signs in with it asks the user first.
export const VaultPolicy = z.enum(["allow", "off", "ask"]);
export type VaultPolicy = z.infer<typeof VaultPolicy>;

/**
 * An item the owner saves in a vault: the account's or, with scope "space", the Space's. Without a
 * name it is a new item, named from its title. With the name of a saved item, `value` may be left
 * out to change only its title or note.
 */
export const VaultPutInput = settingsScopeInput.extend({
  destination: z
    .object({ ...destinationInputShape, name: BotSecretName.optional() })
    .superRefine(requireSite),
  value: BotSecretPutInput.shape.value.optional(),
  title: VaultItemTitle.optional(),
  note: VaultItemNote.optional(),
  policy: VaultPolicy.optional(),
  /**
   * `botIds` limits the item in this Space to those of the owner's bots; `allBots` true lets every
   * bot use it and forgets the choice. Both left out, the bots stay as they are.
   */
  allBots: z.boolean().optional(),
  botIds: z.array(Id).max(100).optional(),
  /** A login's other sites; left as they are when omitted. */
  alsoOn: z.array(z.string().max(2048)).max(VAULT_ALSO_ON_LIMIT).optional(),
});
export type VaultPutInput = z.infer<typeof VaultPutInput>;

export const VaultRevealInput = settingsScopeInput.extend({ name: StoredBotSecretName });

/**
 * A saved value shown to its owner after they confirm it's them: a login's fields, a card, or the
 * value. A contact needs no reveal: its fields are in the list.
 */
export const VaultRevealed = z.union([
  z.object({
    fields: z.array(z.object({ label: z.string(), value: z.string(), hidden: z.boolean() })),
    otp: z.string().optional(),
  }),
  z.object({ card: CardSecretValue }),
  z.object({ value: z.string() }),
]);
export type VaultRevealed = z.infer<typeof VaultRevealed>;

export const VAULT_ACTIVITY_LIMIT = 20;

export const VaultUse = z.strictObject({
  at: z.string(),
  botName: z.string().max(200),
  site: z.string().max(2048).nullable(),
  chat: z.strictObject({ title: z.string() }).nullable(),
});
export type VaultUse = z.infer<typeof VaultUse>;

/** What anyone who may see the item sees of a card: never the number or security code. */
export const CardSummary = z.object({
  brand: z.string(),
  last4: z.string(),
  expMonth: z.number().int(),
  expYear: z.number().int(),
  name: z.string().optional(),
  /** The saved contact whose address bills this card. */
  billing: z.string().optional(),
});
export type CardSummary = z.infer<typeof CardSummary>;

/** What a list shows under an item's title, read from its saved value. */
export const VaultPreview = z.object({
  /** A login's first visible field, usually the username or email. */
  username: z.string().optional(),
  /** A login with an authenticator key. Missing from an older server, which can't keep one. */
  otp: z.literal(true).optional(),
  card: CardSummary.optional(),
  contact: ContactFields.optional(),
});
export type VaultPreview = z.infer<typeof VaultPreview>;

/**
 * What the owner can see about a saved credential. It never carries the protected value.
 * `name` is read loosely and `auth` is nullable so one stored row that no longer passes the
 * current schema cannot fail the whole list call and lock the owner out of removing it.
 * A null `auth` means the stored settings can't be read. `title` is never empty: one the owner
 * left empty is filled from the item itself.
 */
export const BotSecretMetadata = z.object({
  name: StoredBotSecretName,
  origin: z.string(),
  auth: BotSecretAuth.nullable(),
  title: z.string().default(""),
  note: z.string().default(""),
  preview: VaultPreview.optional(),
  /** Missing from an older server, which means "allow". */
  policy: VaultPolicy.optional(),
  /** Both missing from an older server, which lets every bot use every item. */
  allBots: z.boolean().optional(),
  /** The bots chosen in this Space while `allBots` is false; none otherwise. */
  botIds: z.array(z.string()).optional(),
  /** Missing from an older server, which fills a login only on its own site. */
  alsoOn: z.array(z.string()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BotSecretMetadata = z.infer<typeof BotSecretMetadata>;

// Fixed text, so apps can show it translated: an answer's other errors could echo the value.
export const BLOCKED_ITEM_ANSWER =
  "This item is blocked for bots. Allow it in the Vault, or dismiss the request.";
/** As BLOCKED_ITEM_ANSWER, for an item allowed but limited to other bots. */
export const UNCHOSEN_ITEM_ANSWER =
  "This bot can't use this item. Change it in the Vault, or dismiss the request.";

export const SecretHttpRequest = z
  .object({
    name: BotSecretName,
    url: z.string().max(8192),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).default("GET"),
    body: z.string().max(100_000).optional(),
    contentType: z
      .enum(["application/json", "application/x-www-form-urlencoded", "text/plain"])
      .default("application/json"),
  })
  .refine(
    (request) => request.body === undefined || !["GET", "HEAD"].includes(request.method),
    "This method cannot have a body",
  );
