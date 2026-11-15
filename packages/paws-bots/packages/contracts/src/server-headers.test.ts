import { describe, expect, it } from "vitest";
import { parseServerHeaders, serverHeadersFromRows } from "./server-headers.js";

describe("server request headers", () => {
  it("keeps access proxy credentials and ignores blank rows", () => {
    expect(
      serverHeadersFromRows([
        { name: " CF-Access-Client-Id ", value: "id.access" },
        { name: "CF-Access-Client-Secret", value: "secret" },
        { name: "", value: "" },
      ]),
    ).toEqual({ "CF-Access-Client-Id": "id.access", "CF-Access-Client-Secret": "secret" });
    expect(serverHeadersFromRows([])).toEqual({});
  });

  it("refuses headers Rakazo or the transport own, without echoing values", () => {
    for (const name of ["Authorization", "Cookie", "Origin", "X-Rakazo-Space-Id", "Host"]) {
      expect(() => serverHeadersFromRows([{ name, value: "secret" }])).toThrow(
        /^Invalid custom headers$/,
      );
    }
    expect(() => serverHeadersFromRows([{ name: "x-a", value: "" }])).toThrow(
      /^Invalid custom headers$/,
    );
  });

  it("rejects injection, duplicate names, reserved prefixes and oversized inputs", () => {
    for (const name of ["a:b", "a b", "pRoXy-Test", "sEc-Test", "oRiGiN", "x-RAKAZO-test"]) {
      expect(parseServerHeaders({ [name]: "secret" })).toBeNull();
    }
    for (const value of ["a\r", "a\n", "a\0", "a\t", "a\x7f", "a".repeat(1025)]) {
      expect(parseServerHeaders({ "x-test": value })).toBeNull();
    }
    expect(parseServerHeaders({ "x-a": "1", "X-A": "2" })).toBeNull();
    expect(
      parseServerHeaders(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`x-${i}`, "v"]))),
    ).toBeNull();
  });

  it("drops a damaged saved value", () => {
    expect(parseServerHeaders({ "x-a": "1" })).toEqual({ "x-a": "1" });
    expect(parseServerHeaders({ origin: "rakazo://" })).toBeNull();
    expect(parseServerHeaders("x-a: 1")).toBeNull();
    expect(parseServerHeaders({ "x-a": "line\nbreak" })).toBeNull();
  });
});
