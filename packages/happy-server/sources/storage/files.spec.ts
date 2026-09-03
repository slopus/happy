import { afterEach, describe, expect, it, vi } from "vitest";

const { copyObject } = vi.hoisted(() => ({
    copyObject: vi.fn(async () => undefined),
}));

vi.mock("minio", () => ({
    Client: class Client {
        copyObject = copyObject;
    },
}));

const originalEnv = { ...process.env };

async function importFilesWithEnv(env: NodeJS.ProcessEnv) {
    vi.resetModules();
    process.env = { ...originalEnv, ...env };
    return import("./files");
}

describe("getPublicUrl", () => {
    afterEach(() => {
        process.env = { ...originalEnv };
        vi.resetModules();
    });

    it("returns a server /files URL for public objects when S3 storage is private", async () => {
        const { getPublicUrl } = await importFilesWithEnv({
            S3_HOST: "oss-cn-hangzhou.aliyuncs.com",
            S3_ACCESS_KEY: "access",
            S3_SECRET_KEY: "secret",
            S3_BUCKET: "happy-attachments-jacky",
            S3_PUBLIC_URL: "https://happy-attachments-jacky.oss-cn-hangzhou.aliyuncs.com",
        });

        expect(getPublicUrl("public/users/u1/avatars/avatar.jpg", "https://happy.test")).toBe(
            "https://happy.test/files/public/users/u1/avatars/avatar.jpg",
        );
    });

    it("uses the object-store server-side copy primitive without downloading bytes", async () => {
        const { copyFile } = await importFilesWithEnv({
            S3_HOST: "oss-cn-hangzhou.aliyuncs.com",
            S3_ACCESS_KEY: "access",
            S3_SECRET_KEY: "secret",
            S3_BUCKET: "happy-attachments-jacky",
            S3_PUBLIC_URL: "https://happy-attachments-jacky.oss-cn-hangzhou.aliyuncs.com",
        });

        await copyFile("private/session-shares/share/active/cover", "private/session-shares/share/pending/cover");

        expect(copyObject).toHaveBeenCalledWith(
            "happy-attachments-jacky",
            "private/session-shares/share/pending/cover",
            "/happy-attachments-jacky/private/session-shares/share/active/cover",
        );
    });
});
