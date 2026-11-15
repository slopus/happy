import { describe, expect, it } from "vitest";
import {
  authenticatorKey,
  BOT_SECRET_ORIGIN_MISSING_MESSAGE,
  BotSecretDestination,
  BotSecretDestinationInput,
  botSecretDestinationSchema,
  commandVariableName,
  commandVariableProblem,
  decodeLoginSecret,
  encodeLoginSecret,
  LOGIN_FIELD_LIMIT,
  LoginFieldLabels,
  loginCardFields,
  normalizeOneTimeCode,
  OneTimeCodeTarget,
  SecretHttpRequest,
} from "./bot-secrets.js";
import { AGENT_SECRET_NAME_PATTERN } from "./domain.js";

const destination = {
  name: "example_api",
  origin: "https://api.example.test",
  auth: { type: "bearer" },
};

describe("credential contracts", () => {
  it.each([
    "http://api.example.test",
    "https://user:pass@api.example.test",
    "https://api.example.test/path",
    "https://api.example.test?query=1",
    "https://api.example.test#fragment",
  ])("rejects non-origin destination %s", (origin) => {
    expect(BotSecretDestination.safeParse({ ...destination, origin }).success).toBe(false);
  });
  it.each([undefined, ""])(
    "reports a missing origin (%j) as missing, for a login too",
    (origin) => {
      for (const auth of [{ type: "login" }, { type: "bearer" }]) {
        const result = BotSecretDestination.safeParse({ name: "example_login", origin, auth });
        expect(result.success).toBe(false);
        expect(
          result.error?.issues.map((issue) => ({ path: issue.path, message: issue.message })),
        ).toEqual([{ path: ["origin"], message: BOT_SECRET_ORIGIN_MISSING_MESSAGE }]);
      }
    },
  );
  it("keeps the origin rule message for an origin that is present but invalid", () => {
    const result = BotSecretDestination.safeParse({
      name: "example_login",
      origin: "www.example.com",
      auth: { type: "login" },
    });
    const messages = result.error?.issues.map((issue) => issue.message) ?? [];
    expect(messages).toEqual([
      "Expected an HTTPS origin without a path, credentials, query, or fragment",
    ]);
  });
  it("accepts a valid login origin, and a command variable without one", () => {
    expect(
      BotSecretDestination.safeParse({
        name: "example_login",
        origin: "https://www.example.com",
        auth: { type: "login" },
      }).success,
    ).toBe(true);
    expect(
      BotSecretDestination.safeParse({ name: "example_cmd", auth: { type: "command" } }).success,
    ).toBe(true);
  });
  it.each(["feishu-app-credentials", "my-creds-2", "team_a-bot"])(
    "accepts hyphenated credential names like %s",
    (name) => {
      expect(BotSecretDestination.safeParse({ ...destination, name }).success).toBe(true);
    },
  );
  it.each(["Feishu App", "-leading", "with space", ""])(
    "rejects malformed credential names %s",
    (name) => {
      expect(BotSecretDestination.safeParse({ ...destination, name }).success).toBe(false);
    },
  );
  it.each([
    "Host",
    "Connection",
    "Content-Length",
    "Cookie",
    "Proxy-Authorization",
    "X-Forwarded-Host",
    "Sec-Fetch-Site",
    "X-Key\r\nHost",
  ])("rejects reserved or malformed header %s", (name) => {
    expect(
      BotSecretDestination.safeParse({ ...destination, auth: { type: "header", name } }).success,
    ).toBe(false);
  });
  it.each(["GET", "HEAD"])("rejects even an empty body on %s", (method) => {
    expect(
      SecretHttpRequest.safeParse({
        name: "example_api",
        url: destination.origin,
        method,
        body: "",
      }).success,
    ).toBe(false);
  });
  it("accepts ordinary authentication and bounds request inputs", () => {
    expect(BotSecretDestination.parse(destination)).toEqual(destination);
    expect(
      BotSecretDestination.safeParse({
        ...destination,
        auth: { type: "header", name: "X-Api-Key" },
      }).success,
    ).toBe(true);
    expect(
      SecretHttpRequest.safeParse({ name: "example_api", url: destination.origin, body: "body" })
        .success,
    ).toBe(false);
    expect(
      SecretHttpRequest.safeParse({
        name: "example_api",
        url: destination.origin,
        method: "POST",
        body: "x".repeat(100_001),
      }).success,
    ).toBe(false);
  });
});

describe("private HTTP credential origins", () => {
  const relaxed = botSecretDestinationSchema({ allowPrivateHttpOrigin: true });

  it("rejects private HTTP origins by default", () => {
    expect(
      BotSecretDestination.safeParse({ ...destination, origin: "http://192.168.2.10:8080" })
        .success,
    ).toBe(false);
  });
  it.each([
    "http://192.168.2.10:8080",
    "http://10.1.2.3",
    "http://172.16.5.4",
    "http://172.31.255.254",
    "http://100.100.1.5",
    "http://localhost:3000",
    "http://nas.local",
  ])("accepts private HTTP origin %s when the owner opts in", (origin) => {
    expect(relaxed.safeParse({ ...destination, origin }).success).toBe(true);
  });
  it("still rejects public HTTP origins when the owner opts in", () => {
    expect(relaxed.safeParse({ ...destination, origin: "http://api.example.test" }).success).toBe(
      false,
    );
  });
  it("rejects a private HTTP origin for a website login even when the owner opts in", () => {
    expect(
      relaxed.safeParse({
        ...destination,
        origin: "http://192.168.2.10:8080",
        auth: { type: "login" },
      }).success,
    ).toBe(false);
    expect(relaxed.safeParse({ ...destination, auth: { type: "login" } }).success).toBe(true);
  });
  it.each([
    "http://192.168.2.10:8080/upload",
    "http://192.168.2.10:8080?key=1",
    "http://100.100.100.200",
    "http://169.254.170.2",
    "http://169.254.169.254",
  ])("relaxed schema still rejects non-origin URLs %s", (origin) => {
    expect(relaxed.safeParse({ ...destination, origin }).success).toBe(false);
  });
  it.each([
    "https://[::ffff:169.254.169.254]",
    "https://[fd00:ec2::254]",
    "https://metadata.goog.",
  ])("rejects a metadata origin in any form %s", (origin) => {
    expect(relaxed.safeParse({ ...destination, origin }).success).toBe(false);
    expect(BotSecretDestination.safeParse({ ...destination, origin }).success).toBe(false);
  });
});

describe("login credentials", () => {
  const fields = [
    { label: "ID number", value: "fake-id-123", hidden: false },
    { label: "Phone number", value: "+1 555 0100", hidden: true },
    { label: "PIN", value: " 0000 ", hidden: true },
  ];

  it("accepts a login destination and round-trips its fields in order", () => {
    expect(
      BotSecretDestination.safeParse({ ...destination, auth: { type: "login" } }).success,
    ).toBe(true);
    expect(decodeLoginSecret(encodeLoginSecret({ fields }))).toEqual({ fields });
  });

  it("writes only the fields, so a release without them fails to read a new login", () => {
    const stored = JSON.parse(encodeLoginSecret({ fields }));
    expect(Object.keys(stored)).toEqual(["fields"]);
    expect(stored).not.toHaveProperty("username");
    expect(stored).not.toHaveProperty("password");
  });

  it("reads a saved username and password as a visible Username and a hidden Password", () => {
    const legacy = JSON.stringify({
      username: "fake-user",
      password: "fake:password\nwith newline",
    });
    expect(decodeLoginSecret(legacy)).toEqual({
      fields: [
        { label: "Username", value: "fake-user", hidden: false },
        { label: "Password", value: "fake:password\nwith newline", hidden: true },
      ],
    });
  });

  it("trims visible values and labels but keeps hidden values exactly as typed", () => {
    const { fields: saved } = decodeLoginSecret(
      encodeLoginSecret({
        fields: [
          { label: " Email ", value: " fake@example.test ", hidden: false },
          { label: "Password", value: " fake password ", hidden: true },
        ],
      }),
    );
    expect(saved).toEqual([
      { label: "Email", value: "fake@example.test", hidden: false },
      { label: "Password", value: " fake password ", hidden: true },
    ]);
  });

  it.each([
    ["no fields", { fields: [] }],
    ["an empty value", { fields: [{ label: "Code", value: "", hidden: true }] }],
    ["a blank visible value", { fields: [{ label: "ID", value: "  ", hidden: false }] }],
    ["an empty label", { fields: [{ label: " ", value: "fake", hidden: true }] }],
    ["a long label", { fields: [{ label: "x".repeat(65), value: "fake", hidden: true }] }],
    ["a long value", { fields: [{ label: "Password", value: "x".repeat(4097), hidden: true }] }],
    [
      "too many fields",
      {
        fields: Array.from({ length: LOGIN_FIELD_LIMIT + 1 }, (_, index) => ({
          label: `Field ${index}`,
          value: "fake",
          hidden: true,
        })),
      },
    ],
    [
      "labels that differ only in case",
      {
        fields: [
          { label: "Code", value: "fake-1", hidden: true },
          { label: "code ", value: "fake-2", hidden: true },
        ],
      },
    ],
    ["a field without hidden", { fields: [{ label: "Password", value: "fake" }] }],
  ])("rejects a login with %s", (_, value) => {
    expect(() => encodeLoginSecret(value as never)).toThrow();
    expect(() => decodeLoginSecret(JSON.stringify(value))).toThrow();
  });

  it("rejects a login longer than a credential can be", () => {
    const value = {
      fields: Array.from({ length: 5 }, (_, index) => ({
        label: `Field ${index}`,
        value: "x".repeat(4096),
        hidden: true,
      })),
    };
    expect(() => encodeLoginSecret(value)).toThrow();
  });

  it.each([
    { username: "", password: "fake-password" },
    { username: "fake-user", password: "" },
    { username: "fake-user" },
  ])("rejects an incomplete saved pair %j", (value) => {
    expect(() => decodeLoginSecret(JSON.stringify(value))).toThrow();
  });

  it("starts the default card as logins always have", () => {
    expect(loginCardFields(undefined)).toEqual([
      { label: "Username", value: "", hidden: false },
      { label: "Password", value: "", hidden: true },
    ]);
    // Naming the default labels gives the same card, so the bot gains nothing by it.
    expect(loginCardFields(["Username", "Password"])).toEqual(loginCardFields(undefined));
  });

  it("starts an ID and a phone visible for a sign-in with no password field", () => {
    expect(loginCardFields(["ID number", "Phone number", "SMS code"])).toEqual([
      { label: "ID number", value: "", hidden: false },
      { label: "Phone number", value: "", hidden: false },
      { label: "SMS code", value: "", hidden: true },
    ]);
  });

  it.each([
    "ID",
    "ID number",
    "  id-number ",
    "Email",
    "E-mail address",
    "e/mail",
    "Email or phone",
    "Mobile phone",
    "Account number",
    "Customer ID",
    "National ID",
    "Tax ID",
    "Employee ID",
    "Login name",
    "Last 4 digits of ID",
    "Account #",
    "ID \u2116",
    "Account \u2116",
    "Acc\u200Bount",
    "PHONE",
    "Télephone",
    "ＩＤ ｎｕｍｂｅｒ",
    "תעודת זהות",
    "ת.ז.",
    "הטלפון הנייד",
    "מספר טלפון",
    "מספר חשבון",
    "\u200Fמייל\u200F",
    "שם משתמש",
  ])("starts %j visible", (label) => {
    expect(loginCardFields([label])[0]!.hidden).toBe(false);
  });

  it.each([
    "Password",
    "PIN",
    "Account PIN",
    "Phone password",
    "Email code",
    "Verification code",
    "One-time code (OTP)",
    "ID answer",
    "API key",
    "Token",
    "CVV",
    // Plurals, abbreviations and other spellings of a secret.
    "Account passwords",
    "Account PINs",
    "Account codes",
    "Account pwd",
    "Account passwd",
    "Account pw",
    "Account pincode",
    "Account credentials",
    "Account 2FA",
    "Account TOTP",
    "Account CVV2",
    // Look-alike and invisible letters.
    "Account P\u0430ssword",
    "Account \uFF30\uFF29\uFF2E",
    "Account PIN\u3164",
    "Account\u3164",
    "Account\u{1F511}",
    "Account \u{1F512}",
    "Phone \u2731\u2731\u2731",
    "ID \u{1F511} number",
    "Account +",
    // Labels we don't recognise stay hidden.
    "Memorable word",
    "Mother's maiden name",
    "Card number",
    "Date of birth",
    "Name",
    "Number",
    "Hid",
    "Provider",
    "סיסמה",
    "קוד SMS",
    "הקוד",
    "טלפון סודי",
    "קוד אימות",
    "סיסמת חשבון",
    "ססמת חשבון",
    "חשבון פין",
    "טלפון וסיסמה",
    "חשבון וקוד",
  ])("starts %j hidden", (label) => {
    expect(loginCardFields([label])[0]!.hidden).toBe(true);
  });

  it.each([[["Username", "Password"]], [["ID", "Phone", "Code"]]])(
    "accepts requested labels %j",
    (labels) => {
      expect(LoginFieldLabels.safeParse(labels).success).toBe(true);
    },
  );

  it.each([[[]], [["Code", "CODE"]], [[""]]])("rejects requested labels %j", (labels) => {
    expect(LoginFieldLabels.safeParse(labels).success).toBe(false);
  });
});

describe("command variables", () => {
  const command = { type: "command" } as const;

  it.each([
    ["netbird-setup-key", "NETBIRD_SETUP_KEY"],
    ["github_pat", "GITHUB_PAT"],
    ["a", "A"],
    ["x-1_y-2", "X_1_Y_2"],
  ])("exports %s as $%s, a valid space variable name", (name, variable) => {
    expect(commandVariableName(name)).toBe(variable);
    expect(AGENT_SECRET_NAME_PATTERN.test(variable)).toBe(true);
    expect(commandVariableProblem(variable)).toBeUndefined();
  });

  it.each([
    "PATH",
    "HOME",
    "IFS",
    "ENV",
    "BASH_ENV",
    "PROMPT_COMMAND",
    "PS4",
    "SSH_AUTH_SOCK",
    "NODE_OPTIONS",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "PYTHONPATH",
    "PERL5OPT",
    "RUBYOPT",
    "JDK_JAVA_OPTIONS",
    "HTTPS_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
    "SSLKEYLOGFILE",
    "GIT_SSL_CAINFO",
    "GIT_SSL_NO_VERIFY",
    "OPENSSL_CONF",
    "OPENSSL_ENGINES",
    "OPENSSL_MODULES",
    "GIT_SSH_COMMAND",
    "GIT_PROXY_COMMAND",
    "GIT_EXTERNAL_DIFF",
    "GIT_PAGER",
    "GIT_EDITOR",
    "GIT_EXEC_PATH",
    "GIT_TEMPLATE_DIR",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_COUNT",
    "GCONV_PATH",
    "NPM_CONFIG_PREFIX",
    "NPM_CONFIG_REGISTRY",
    "SSH_ASKPASS",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "LD_ANYTHING",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_ANYTHING",
    "RAKAZO_TOKEN",
  ])("reserves $%s", (variable) => {
    expect(commandVariableProblem(variable)).toBe("reserved");
  });

  it("reserves exact names and prefixes only", () => {
    expect(commandVariableProblem("PATHS")).toBeUndefined();
    expect(commandVariableProblem("MY_PATH")).toBeUndefined();
    expect(commandVariableProblem("OLD_LD_FLAG")).toBeUndefined();
  });

  it("marks a name outside the space variable pattern invalid", () => {
    expect(commandVariableProblem("lower")).toBe("invalid");
    expect(commandVariableProblem("1ABC")).toBe("invalid");
    expect(commandVariableProblem("A".repeat(65))).toBe("invalid");
  });

  it("accepts a command destination with a missing or empty origin", () => {
    for (const schema of [
      BotSecretDestination,
      botSecretDestinationSchema({ allowPrivateHttpOrigin: true }),
    ]) {
      expect(schema.parse({ name: "netbird-setup-key", auth: command })).toEqual({
        name: "netbird-setup-key",
        origin: "",
        auth: command,
      });
      expect(
        schema.safeParse({ name: "netbird-setup-key", origin: "", auth: command }).success,
      ).toBe(true);
    }
  });

  it("rejects a site on a command destination", () => {
    const result = BotSecretDestination.safeParse({
      name: "netbird-setup-key",
      origin: "https://api.example.test",
      auth: command,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["origin"]);
  });

  it.each([
    ["ld_preload", "$LD_PRELOAD"],
    ["dyld-insert-libraries", "$DYLD_INSERT_LIBRARIES"],
    ["path", "$PATH"],
    ["rakazo-token", "$RAKAZO_TOKEN"],
  ])("rejects %s because %s is reserved", (name, variable) => {
    const result = BotSecretDestination.safeParse({ name, auth: command });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ["name"],
      message: expect.stringContaining(`${variable} is reserved`),
    });
  });

  it("does not reserve names for credentials that are not command variables", () => {
    expect(BotSecretDestination.safeParse({ ...destination, name: "path" }).success).toBe(true);
  });

  it.each([
    { type: "bearer" },
    { type: "header", name: "X-Api-Key" },
    { type: "basic", username: "api-user" },
    { type: "login" },
  ])("still requires a valid HTTPS origin for %j", (auth) => {
    const relaxed = botSecretDestinationSchema({ allowPrivateHttpOrigin: true });
    for (const schema of [BotSecretDestination, relaxed]) {
      expect(schema.safeParse({ name: "api", auth }).success).toBe(false);
      expect(schema.safeParse({ name: "api", origin: "", auth }).success).toBe(false);
      expect(
        schema.safeParse({ name: "api", origin: "http://api.example.test", auth }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ name: "api", origin: "https://api.example.test/path", auth }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ name: "api", origin: "https://api.example.test", auth }).success,
      ).toBe(true);
    }
    const missing = BotSecretDestination.safeParse({ name: "api", auth });
    expect(missing.error?.issues[0]?.message).toBe(BOT_SECRET_ORIGIN_MISSING_MESSAGE);
  });

  it("lets the owner input omit the origin only for a command variable", () => {
    expect(BotSecretDestinationInput.parse({ name: "cli-token", auth: command })).toEqual({
      name: "cli-token",
      origin: "",
      auth: command,
    });
    expect(
      BotSecretDestinationInput.safeParse({ name: "api", auth: { type: "bearer" } }).success,
    ).toBe(false);
    expect(
      BotSecretDestinationInput.safeParse({ name: "api", origin: "", auth: { type: "bearer" } })
        .success,
    ).toBe(false);
  });
});

describe("one-time code contracts", () => {
  it.each([
    ["482913", "482913"],
    [" 482 913 ", "482913"],
    ["G-482913", "G-482913"],
    ["1234", "1234"],
    ["abcd1234efgh", "abcd1234efgh"],
    ["123-456", "123-456"],
    ["12-34-56", "12-34-56"],
  ])("takes %j as %j", (typed, code) => {
    expect(normalizeOneTimeCode(typed)).toBe(code);
  });

  it.each([
    "",
    "   ",
    "ok",
    "123",
    "x".repeat(13),
    "12 34 56 78 90 12 3",
    "----",
    "1---",
    "a-b-",
    "-1234",
    "12--34",
    "1-2-3",
    "12.34",
    "12_34",
    "١٢٣٤٥٦",
  ])("takes %j as no code", (typed) => {
    expect(normalizeOneTimeCode(typed)).toBeUndefined();
  });

  it("is for an HTTPS origin only, never a path, credentials or plain HTTP", () => {
    expect(OneTimeCodeTarget.safeParse({ origin: "https://login.example.test" }).success).toBe(
      true,
    );
    for (const origin of [
      "http://login.example.test",
      "http://192.168.1.20",
      "https://user:pass@example.test",
      "https://login.example.test/verify",
      "",
    ]) {
      expect(OneTimeCodeTarget.safeParse({ origin }).success).toBe(false);
    }
  });
});

describe("authenticatorKey", () => {
  // RFC 6238's test key, "12345678901234567890" in base32, written in pieces so it never reads
  // as a saved secret.
  const K = ("GEZDGNBV" + "GY3TQOJQ").repeat(2);
  // As issuers hand keys out, and as a slip of the finger changes them.
  it.each([
    ["a plain key", K, K],
    [
      "lower case, in groups of four",
      K.toLowerCase()
        .replace(/(.{4})/g, "$1 ")
        .trim(),
      K,
    ],
    ["dashed", K.replace(/(.{4})/g, "$1-").slice(0, -1), K],
    ["26 characters, unpadded", `${K}GEZDGNBVGY`, `${K}GEZDGNBVGY`],
    ["26 characters, padded", `${K}GEZDGNBVGY======`, `${K}GEZDGNBVGY`],
    ["a setup link", `otpauth://totp/Example:alice?secret=${K}&issuer=Example`, K],
    [
      "a setup link with its own digits, period and algorithm",
      `otpauth://totp/x?secret=${K}&digits=8&period=60&algorithm=SHA512`,
      K,
    ],
    ["one character too many", `${K}G`, undefined],
    ["three characters over a whole group", `${K}GEZ`, undefined],
    ["six characters over a whole group", `${K}GEZDGN`, undefined],
    ["a letter base32 doesn't use", `${K.slice(0, -1)}1`, undefined],
    ["too short to be a secret", "GEZDGNBV", undefined],
    ["padding where none belongs", `${K}====`, undefined],
    ["padding of the wrong length", `${K}GEZDGNBVGY====`, undefined],
    ["a whole group of padding", `${K}========`, undefined],
    ["a setup link without a secret", "otpauth://totp/Example:alice?issuer=Example", undefined],
    ["a counter-based setup link", `otpauth://hotp/x?secret=${K}`, undefined],
  ])("%s", (_, text, secret) => {
    expect(authenticatorKey(text)?.secret).toBe(secret);
  });

  it("refuses a login whose key no save accepts", () => {
    const fields = [{ label: "Password", value: "fake-pass", hidden: true }];
    expect(() => decodeLoginSecret(JSON.stringify({ fields, otp: `${K}G` }))).toThrow();
    expect(decodeLoginSecret(JSON.stringify({ fields, otp: K }))).toEqual({ fields, otp: K });
  });
});
