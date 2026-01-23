import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { RelationshipStatus, db, isPrismaErrorCode } from "./prisma";

function parseEnumValues(schemaText: string, enumName: string): string[] {
    const block = schemaText.match(new RegExp(`enum\\s+${enumName}\\s*\\{([\\s\\S]*?)\\}`, "m"));
    if (!block?.[1]) {
        throw new Error(`enum ${enumName} not found in schema`);
    }
    return block[1]
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("//"))
        .map((line) => line.split(/\s+/)[0])
        .filter(Boolean);
}

describe("storage/prisma", () => {
    it("throws a helpful error when db is accessed before initialization", () => {
        // `db` is a proxy so simply importing it is fine; accessing properties should fail loudly until initDb* runs.
        // Use a regex match to avoid brittle exact-string assertions.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(() => (db as any).user).toThrow(/not initialized/i);
    });

    it("RelationshipStatus matches prisma/schema.prisma and prisma/sqlite/schema.prisma", () => {
        const root = join(process.cwd());
        const fullSchema = readFileSync(join(root, "prisma", "schema.prisma"), "utf-8");
        const sqliteSchema = readFileSync(join(root, "prisma", "sqlite", "schema.prisma"), "utf-8");

        const fullValues = parseEnumValues(fullSchema, "RelationshipStatus");
        const sqliteValues = parseEnumValues(sqliteSchema, "RelationshipStatus");

        // sqlite schema is generated from full schema; these must stay identical.
        expect(sqliteValues).toEqual(fullValues);

        const exportedValues = Object.values(RelationshipStatus);
        expect(exportedValues.sort()).toEqual([...new Set(fullValues)].sort());
    });

    it("detects Prisma-like error codes without relying on Prisma error classes", () => {
        expect(isPrismaErrorCode({ code: "P2034" }, "P2034")).toBe(true);
        expect(isPrismaErrorCode({ code: "P2002" }, "P2034")).toBe(false);
        expect(isPrismaErrorCode(new Error("no code"), "P2034")).toBe(false);
        expect(isPrismaErrorCode(null, "P2034")).toBe(false);
    });
});
