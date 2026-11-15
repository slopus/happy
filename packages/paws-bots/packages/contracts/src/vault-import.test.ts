import { describe, expect, it } from "vitest";
import { VAULT_ITEM_LIMIT } from "./bot-secrets.js";
import {
  newVaultImportRows,
  noneSkipped,
  parseVaultCsv,
  VAULT_IMPORT_FILE_LIMIT,
  VaultImportInput,
  vaultImportCounts,
  vaultImportProblems,
} from "./vault-import.js";

// RFC 6238's test key, written in pieces so it never reads as a saved secret.
const KEY = ("GEZDGNBV" + "GY3TQOJQ").repeat(2);
const login = {
  title: "Example",
  origin: "https://example.com",
  username: "alice@example.com",
  password: "fake-pass-1",
};

describe("parseVaultCsv", () => {
  it("reads the common header layouts by column name", () => {
    const layouts = [
      "name,url,username,password,note\nExample,https://example.com/login,alice@example.com,fake-pass-1,",
      "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,,login,Example,,,0,https://example.com/login,alice@example.com,fake-pass-1,",
      "Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes\nExample,https://example.com/login,alice@example.com,fake-pass-1,,false,false,,",
      "url,username,password,extra,name,grouping,fav\nhttps://example.com/login,alice@example.com,fake-pass-1,,Example,,0",
      '"Title","Website","Username","Password","Notes"\n"Example","https://example.com/login","alice@example.com","fake-pass-1",""',
      "Title,URL,Username,Password,Notes,OTPAuth\nExample,https://example.com/login,alice@example.com,fake-pass-1,,",
    ];
    for (const csv of layouts) {
      expect(parseVaultCsv(csv), csv.split("\n")[0]).toEqual({
        rows: [login],
        lines: [2],
        skipped: { notHttps: 0, noPassword: 0, duplicate: 0, invalid: 0, limit: 0 },
        problems: [],
      });
    }
  });

  it("reads a fully quoted CRLF export without a name column", () => {
    const csv =
      '"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"\r\n"https://example.com","alice@example.com","fake-pass-1",,"https://example.com","{0}","1","1","1"\r\n';
    expect(parseVaultCsv(csv)).toMatchObject({ rows: [{ ...login, title: "" }], lines: [2] });
  });

  it("keeps quoted commas, quotes and line breaks, a BOM, CRLF and a password's spaces", () => {
    const csv =
      '\uFEFFname,url,username,password,notes\r\n"Work, main",https://work.example.com,bob," fake ""pw"" ","line 1\r\nline 2"\r\n';
    expect(parseVaultCsv(csv)).toMatchObject({
      rows: [
        {
          title: "Work, main",
          origin: "https://work.example.com",
          username: "bob",
          password: ' fake "pw" ',
        },
      ],
    });
  });

  it("keeps a cell that starts like a spreadsheet formula as the text it is", () => {
    // Nothing imported is ever written to a spreadsheet, and a password may start with "=".
    const csv = 'name,url,username,password\n"=HYPERLINK(""x"")",https://example.com,+bob,=fake-pw';
    expect(parseVaultCsv(csv)).toMatchObject({
      rows: [{ title: '=HYPERLINK("x")', username: "+bob", password: "=fake-pw" }],
    });
  });

  it("reads every column of a name the file repeats, using the first cell that isn't empty", () => {
    const csv = "url,password,password,url\n,,fake-pass,https://example.com";
    expect(parseVaultCsv(csv)).toMatchObject({
      rows: [{ origin: "https://example.com", password: "fake-pass" }],
      skipped: noneSkipped(),
    });
  });

  it("imports the logins of a file with an authenticator column, never their keys", () => {
    const csv = [
      "name,url,username,password,totp,2fa",
      `Example,https://example.com,alice,fake-pass,otpauth://totp/x?secret=${KEY},`,
      "Steam,https://store.example.com,bob,fake-steam,steam://GEZDGNBVGY3TQOJQ,Yes",
    ].join("\n");
    const parsed = parseVaultCsv(csv);
    expect(parsed).toMatchObject({
      rows: [
        { origin: "https://example.com", username: "alice" },
        { origin: "https://store.example.com", username: "bob" },
      ],
      skipped: noneSkipped(),
    });
    expect(JSON.stringify(parsed)).not.toContain("GEZDGNBVGY3TQOJQ");
  });

  it("refuses a file whose quoting is broken, and a row with more cells than the header", () => {
    // Text after a closing quote, or a quote inside an unquoted cell, would change a password.
    for (const password of ['"abc"def', 'ab"c', '"abc" ']) {
      expect(parseVaultCsv(`url,username,password\nhttps://example.com,alice,${password}`)).toEqual(
        {
          error: "unreadable",
        },
      );
    }
    const csv = [
      "url,username,password,notes",
      'https://a.example.com,alice,"pa,ss\nword",',
      "https://b.example.com,bob,my,pass,",
      "https://c.example.com,carol,fake-c",
    ].join("\n");
    expect(parseVaultCsv(csv)).toMatchObject({
      rows: [
        { origin: "https://a.example.com", password: "pa,ss\nword" },
        { origin: "https://c.example.com", password: "fake-c" },
      ],
      // The first row's password spans two lines.
      lines: [2, 5],
      problems: [{ line: 4, label: "", reason: "invalid" }],
    });
  });

  it("names a row with more cells than the header by its number only, whatever its cells", () => {
    // An unquoted comma in the name shifts every cell: the "site" is part of the name, and the
    // "name" a cell could be anything, a password included.
    const csv = "name,url,username,password\nShop, Inc,https://shop.example.com,bob,fake-pw";
    expect(parseVaultCsv(csv)).toMatchObject({
      rows: [],
      skipped: { invalid: 1, notHttps: 0 },
      problems: [{ line: 2, label: "", reason: "invalid" }],
    });
  });

  it("reads a backslash as written, as CSV has no escape for it", () => {
    const csv =
      '"Account","Login Name","Password","Web Site"\n"Work","CORP\\\\bob","fake-\\pass","https://example.com"';
    expect(parseVaultCsv(csv)).toMatchObject({
      rows: [{ title: "Work", username: "CORP\\\\bob", password: "fake-\\pass" }],
    });
  });

  it("saves a site written with a trailing dot under its usual address", () => {
    expect(
      parseVaultCsv("url,password\nhttps://EXAMPLE.COM./login,fake-pass\nshop.example.com.,fake-p"),
    ).toMatchObject({
      rows: [{ origin: "https://example.com" }, { origin: "https://shop.example.com" }],
    });
  });

  it("counts rows it can't save and names them by row, never by username or password", () => {
    const csv = [
      "name,url,username,password",
      "Plain,http://example.com,alice,fake-pass",
      "Bare,shop.example.com/login,alice,fake-pass",
      ",https://user:pw@example.com,alice,fake-pass",
      "Note,word,,",
      ",https://empty.example.com,alice,",
      ",,,",
    ].join("\n");
    expect(parseVaultCsv(csv)).toEqual({
      // A site written without its scheme is taken as HTTPS; one that says http:// is not.
      rows: [expect.objectContaining({ title: "Bare", origin: "https://shop.example.com" })],
      lines: [3],
      skipped: { notHttps: 3, noPassword: 1, duplicate: 0, invalid: 0, limit: 0 },
      problems: [
        { line: 2, label: "Plain", reason: "notHttps" },
        { line: 4, label: "", reason: "notHttps" },
        { line: 5, label: "Note", reason: "notHttps" },
        { line: 6, label: "empty.example.com", reason: "noPassword" },
      ],
    });
  });

  it("numbers rows by the file's line they start on, past blank lines and notes on several", () => {
    const parsed = parseVaultCsv(
      'url,password,notes\r\n\r\nhttp://plain.example.com,fake-a,"two\r\nlines"\r\n\nhttps://ok.example.com,fake-b,',
    );
    expect(parsed).toMatchObject({
      lines: [6],
      problems: [{ line: 3, label: "", reason: "notHttps" }],
    });
    // A row the server turns down is named by the same number.
    const rows = "rows" in parsed ? parsed.rows : [];
    const plan = newVaultImportRows(rows, [], "lines" in parsed ? parsed.lines : []);
    const result = {
      added: 0,
      skipped: { notHttps: 0, noPassword: 0, duplicate: 0, invalid: 0, limit: 1 },
      notSaved: [{ index: 0, reason: "limit" as const }],
    };
    expect(vaultImportProblems([], plan, result)).toEqual([
      { line: 6, label: "ok.example.com", reason: "limit" },
    ]);
  });

  it("refuses a file it can't read whole", () => {
    expect(parseVaultCsv('name,url,password\n"open,https://example.com,x')).toEqual({
      error: "unreadable",
    });
    expect(parseVaultCsv("name,username\nExample,alice")).toEqual({ error: "no_logins" });
    expect(parseVaultCsv("name,phone\nAda,+1 555 0100")).toEqual({ error: "no_logins" });
    expect(parseVaultCsv("")).toEqual({ error: "no_logins" });
    expect(parseVaultCsv("x".repeat(VAULT_IMPORT_FILE_LIMIT + 1))).toEqual({ error: "too_large" });
  });

  it("sends every new login for the server to judge, and counts those past the room left", () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      ...login,
      title: `Site ${index}`,
      origin: `https://s${index}.example.com`,
    }));
    const saved = Array.from({ length: VAULT_ITEM_LIMIT - 2 }, (_, index) => ({
      name: `item-${index}`,
      origin: "",
      auth: { type: "command" as const },
      title: "",
      note: "",
      createdAt: "",
      updatedAt: "",
    }));
    const plan = newVaultImportRows(rows, saved, [1, 2, 3]);
    // The review says one looks past the room left, but the server decides: a row it refuses for
    // another reason, or one already saved, leaves the place to the next.
    expect(plan).toMatchObject({ rows, full: 1, problems: [] });
    expect(vaultImportCounts(noneSkipped(), plan)).toEqual([
      ["toAdd", 2],
      ["full", 1],
    ]);
  });

  it("reads a site cell's free text as no site, not as the address inside it", () => {
    const csv = "name,url,password\nBank,my bank.com,fake-pass";
    expect(parseVaultCsv(csv)).toMatchObject({
      rows: [],
      problems: [{ line: 2, label: "Bank", reason: "notHttps" }],
    });
  });

  it("uses the first HTTPS site of a cell, and each row's first identity column", () => {
    const csv = [
      "name,url,username,email,password",
      'A,"http://a.example.com, https://a.example.com/login\nhttps://b.example.com",,a@example.com,fake-a',
      "B,https://b.example.com,bee,b@example.com,fake-b",
    ].join("\n");
    expect(parseVaultCsv(csv)).toMatchObject({
      rows: [
        { origin: "https://a.example.com", username: "a@example.com" },
        { origin: "https://b.example.com", username: "bee" },
      ],
    });
  });

  it("uses each row's first password column that isn't empty, keeping its spaces", () => {
    const csv = [
      "name,url,username,password,login_password",
      "A,https://a.example.com,ay,, fake-a ",
      "B,https://b.example.com,bee,fake-b,fake-other",
      "C,https://c.example.com,cee,,",
      "D,https://d.example.com,dee,   ,",
      // Spaces alone are a password too, so a later column never replaces them.
      "E,https://e.example.com,ee,  , fake-other",
      "F,https://f.example.com,eff,\tfake-f ,",
    ].join("\n");
    expect(parseVaultCsv(csv)).toMatchObject({
      rows: [
        { origin: "https://a.example.com", password: " fake-a " },
        { origin: "https://b.example.com", password: "fake-b" },
        { origin: "https://d.example.com", password: "   " },
        { origin: "https://e.example.com", password: "  " },
        { origin: "https://f.example.com", password: "\tfake-f " },
      ],
      skipped: { noPassword: 1 },
      problems: [{ line: 4, label: "C", reason: "noPassword" }],
    });
  });

  it("counts a row with a value too long to save, and keeps the others", () => {
    const csv = [
      "url,username,password",
      "https://ok.example.com,ok,fake-ok",
      `https://long.example.com,long,${"x".repeat(4097)}`,
    ].join("\n");
    const parsed = parseVaultCsv(csv);
    expect(parsed).toMatchObject({
      rows: [{ origin: "https://ok.example.com" }],
      skipped: { invalid: 1 },
    });
    // What it sends is what the RPC takes.
    expect(VaultImportInput.safeParse({ rows: "rows" in parsed && parsed.rows }).success).toBe(
      true,
    );
  });

  it("leaves a login out as saved only when the list could read who it signs in", () => {
    const row = { ...login, username: "" };
    const saved = (preview?: { username?: string }) => [
      {
        name: "example",
        origin: login.origin,
        auth: { type: "login" as const },
        title: "",
        note: "",
        createdAt: "",
        updatedAt: "",
        ...(preview ? { preview } : {}),
      },
    ];
    // A saved login whose value couldn't be read may be anyone's: the server checks it.
    expect(newVaultImportRows([row], saved())).toMatchObject({ rows: [row], duplicate: 0 });
    // One known to have no username is this one.
    expect(newVaultImportRows([row], saved({}))).toMatchObject({ rows: [], duplicate: 1 });
    expect(newVaultImportRows([row], saved({ username: "alice" }))).toMatchObject({
      rows: [row],
      duplicate: 0,
    });
  });

  it("sends a repeat in the file once, and answers for it as the server did for the first", () => {
    const distinct = Array.from({ length: 115 }, (_, index) => ({
      ...login,
      origin: `https://d${index}.example.com`,
    }));
    // The first 15 logins each appear twice: 130 rows into an empty Vault.
    const rows = distinct.flatMap((row, index) => (index < 15 ? [row, { ...row }] : [row]));
    const plan = newVaultImportRows(rows, []);
    expect(plan.rows).toEqual(distinct.slice(0, VAULT_ITEM_LIMIT));
    // Before the server answers, the review already shows each repeat by its row, as a repeat:
    // nothing is saved yet.
    expect(vaultImportCounts(noneSkipped(), plan)).toEqual([
      ["toAdd", VAULT_ITEM_LIMIT],
      ["repeat", 15],
      ["full", 15],
    ]);
    expect(vaultImportProblems([], plan)[0]).toEqual({
      line: 2,
      label: "Example",
      reason: "repeat",
    });
    const result = { added: VAULT_ITEM_LIMIT, skipped: noneSkipped(), notSaved: [] };
    expect(vaultImportCounts(noneSkipped(), plan, result)).toEqual([
      ["added", VAULT_ITEM_LIMIT],
      ["duplicate", 15],
      ["full", 15],
    ]);
    expect(vaultImportProblems([], plan, result)[0]).toEqual({
      line: 2,
      label: "Example",
      reason: "duplicate",
    });
    // A repeat of one the server turned down gets the same answer.
    const refused = {
      added: VAULT_ITEM_LIMIT - 1,
      skipped: { ...noneSkipped(), invalid: 1 },
      notSaved: [{ index: 0, reason: "invalid" as const }],
    };
    expect(vaultImportProblems([], plan, refused).slice(0, 2)).toEqual([
      { line: 1, label: "Example", reason: "invalid" },
      { line: 2, label: "Example", reason: "invalid" },
    ]);
    expect(vaultImportCounts(noneSkipped(), plan, refused)).toContainEqual(["notSaved", 2]);
  });

  it("sends at most as many logins as one import takes, and counts the rest as full", () => {
    const many = Array.from({ length: VAULT_ITEM_LIMIT + 1 }, (_, index) => ({
      ...login,
      username: `u${index}`,
    }));
    expect(newVaultImportRows(many, [])).toMatchObject({
      full: 1,
      problems: [{ line: VAULT_ITEM_LIMIT + 1, reason: "limit" }],
    });
    expect(newVaultImportRows(many, []).rows).toHaveLength(VAULT_ITEM_LIMIT);
  });

  it("counts a row the server would refuse as not saved, before it can take a place", () => {
    // A site no login may be saved for, and a value too long once saved (each character escaped).
    const csv = [
      "url,username,password",
      "https://169.254.169.254,alice,fake-password",
      `https://a.example.com,alice,${"\u0001".repeat(4096)}`,
      "https://good.example.com,bob,fake-password",
    ].join("\n");
    expect(parseVaultCsv(csv)).toMatchObject({
      rows: [{ origin: "https://good.example.com" }],
      lines: [4],
      skipped: { invalid: 2 },
      problems: [
        { line: 2, reason: "invalid" },
        { line: 3, reason: "invalid" },
      ],
    });
  });

  it("shortens a long name without splitting a character", () => {
    const parsed = parseVaultCsv(`name,url,password\n${"a".repeat(79)}😀,https://example.com,p`);
    expect(parsed).toMatchObject({ rows: [{ title: "a".repeat(79) }] });
    const label = parseVaultCsv(`name,url,password\n${"a".repeat(79)}😀,http://example.com,p`);
    expect(label).toMatchObject({ problems: [{ label: "a".repeat(79) }] });
  });

  it("sends no more logins than a Vault holds, and nothing but logins", () => {
    expect(
      VaultImportInput.safeParse({ rows: Array(VAULT_ITEM_LIMIT + 1).fill(login) }).success,
    ).toBe(false);
    expect(VaultImportInput.safeParse({ rows: [{ ...login, url: "x" }] }).success).toBe(false);
  });
});

describe("newVaultImportRows", () => {
  it("leaves out a login saved for the same site and username, and sends a repeat in the file once", () => {
    const other = { ...login, username: "bob" };
    const elsewhere = { ...login, origin: "https://www.example.com" };
    const saved = {
      name: "example",
      origin: login.origin,
      auth: { type: "login" },
      title: "",
      note: "",
      preview: { username: "alice@example.com" },
      createdAt: "",
      updatedAt: "",
    } as const;
    const plan = newVaultImportRows([login, other, other, elsewhere], [saved], [2, 4, 5, 7]);
    // A repeat follows the server's answer for its first copy, which may not be saved.
    expect(plan).toEqual({
      rows: [other, elsewhere],
      lines: [4, 7],
      duplicate: 1,
      full: 0,
      pastRoom: 0,
      problems: [{ line: 2, label: "Example", reason: "duplicate" }],
      repeats: [{ line: 5, label: "Example", reason: "repeat", of: 0 }],
    });
    // A login also on a site is already saved there.
    const alsoOn = { ...saved, alsoOn: ["https://www.example.com"] };
    expect(newVaultImportRows([elsewhere], [alsoOn])).toMatchObject({ rows: [], duplicate: 1 });
    const skipped = { notHttps: 1, noPassword: 0, duplicate: 0, invalid: 0, limit: 0 };
    // The repeat on line 5 is shown before the server answers.
    expect(vaultImportCounts(skipped, plan)).toEqual([
      ["toAdd", 2],
      ["duplicate", 1],
      ["repeat", 1],
      ["notHttps", 1],
    ]);
    // The rows left out, in file order: the file's, the duplicates, then the server's by place.
    const file = [{ line: 1, label: "Plain", reason: "notHttps" as const }];
    const result = {
      added: 1,
      skipped: { ...skipped, notHttps: 0, limit: 1 },
      notSaved: [{ index: 1, reason: "limit" as const }],
    };
    expect(vaultImportCounts(skipped, plan, result)).toEqual([
      ["added", 1],
      ["duplicate", 2],
      ["notHttps", 1],
      ["full", 1],
    ]);
    expect(vaultImportProblems(file, plan, result)).toEqual([
      file[0],
      { line: 2, label: "Example", reason: "duplicate" },
      { line: 5, label: "Example", reason: "duplicate" },
      { line: 7, label: "Example", reason: "limit" },
    ]);
  });
});
