import { describe, expect, it } from "vitest";
import { suggestEmailCorrection } from "./email-typo.js";

describe("suggestEmailCorrection", () => {
  it.each([
    ["sam@gmail.con", "sam@gmail.com"],
    ["sam@gamil.com", "sam@gmail.com"],
    ["sam@gmial.com", "sam@gmail.com"],
    ["sam@gmailc.om", "sam@gmail.com"],
    ["sam@gmail.come", "sam@gmail.com"],
    ["sam@gmai.com", "sam@gmail.com"],
    ["sam@gmail.vom", "sam@gmail.com"],
    ["sam@outloook.com", "sam@outlook.com"],
    ["sam@hotmial.com", "sam@hotmail.com"],
    ["sam@qq.con", "sam@qq.com"],
    ["Sam@GMAIL.CON ", "Sam@gmail.com"],
    ["sam@example.con", "sam@example.com"],
    ["sam@gmial.con", "sam@gmail.com"],
    ["sam@gmail.om", "sam@gmail.com"],
    ["sam@gmailcom", "sam@gmail.com"],
  ])("suggests a fix for %s", (email, expected) => {
    expect(suggestEmailCorrection(email)).toBe(expected);
  });

  it.each([
    "sam@gmail.com",
    "sam@126.com",
    "sam@gmx.com",
    "sam@gmx.de",
    "sam@ymail.com",
    "sam@hey.com",
    "sam@web.de",
    "sam@hotmail.co.uk",
    "sam@outlook.de",
    "sam@company.co",
    "sam@company.io",
    "sam@protonmail.ch",
    "sam@hotmail.ca",
    "sam@yahoo.ca",
    "sam@gm.com",
    "sam@ge.com",
    "sam@aon.com",
    "sam@cloud.com",
    "sam@qq.co",
    `sam@${"x".repeat(100_000)}.com`,
    "sam",
    "@gmail.con",
  ])("leaves %s alone", (email) => {
    expect(suggestEmailCorrection(email)).toBeNull();
  });
});
