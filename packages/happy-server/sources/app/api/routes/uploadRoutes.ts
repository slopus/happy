import { createUploadConfig } from "pushduck/dist/server";
import { toFastifyHandler } from "pushduck/dist/adapters/index";
import { Fastify } from "../types";
import { auth } from "@/app/auth/auth";
import { processImage } from "@/storage/processImage";
import { db } from "@/storage/db";
import { allocateUserSeq } from "@/storage/seq";
import { eventRouter } from "@/app/events/eventRouter";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { log } from "@/utils/log";
import type { UpdatePayload } from "@/app/events/eventRouter";

//
// R2 configuration
//
// Required environment variables:
//   CLOUDFLARE_R2_ACCESS_KEY_ID      — R2 API token access key ID
//   CLOUDFLARE_R2_SECRET_ACCESS_KEY  — R2 API token secret access key
//   CLOUDFLARE_ACCOUNT_ID            — Cloudflare account ID
//   CLOUDFLARE_R2_BUCKET             — R2 bucket name
//   CLOUDFLARE_R2_PUBLIC_URL         — Public base URL for the bucket
//                                       (e.g. https://pub-abc123.r2.dev or custom domain)
//

const r2Configured =
    !!process.env.CLOUDFLARE_R2_ACCESS_KEY_ID &&
    !!process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY &&
    !!process.env.CLOUDFLARE_ACCOUNT_ID &&
    !!process.env.CLOUDFLARE_R2_BUCKET;

if (!r2Configured) {
    log(
        { module: "upload", level: "warn" },
        "Cloudflare R2 is not fully configured — upload routes will return 503 until all CLOUDFLARE_R2_* env vars are set"
    );
}

const { s3 } = createUploadConfig()
    .provider("cloudflareR2", {
        accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID ?? "",
        secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY ?? "",
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
        bucket: process.env.CLOUDFLARE_R2_BUCKET ?? "",
        customDomain: process.env.CLOUDFLARE_R2_PUBLIC_URL,
    })
    .build();

const uploadRouter = s3.createRouter({
    avatarUpload: s3
        .image()
        .maxFileSize("5MB")
        .middleware(async ({ req }) => {
            if (!r2Configured) {
                throw new Error("Upload service is not configured");
            }

            const authHeader = req.headers.get("authorization");
            if (!authHeader?.startsWith("Bearer ")) {
                throw new Error("Unauthorized");
            }

            const token = authHeader.substring(7);
            const verified = await auth.verifyToken(token);
            if (!verified) {
                throw new Error("Unauthorized");
            }

            return { userId: verified.userId };
        })
        .paths({
            generateKey: ({ file, metadata }) => {
                const ext = file.name.toLowerCase().endsWith(".png") ? "png" : "jpg";
                const key = randomKeyNaked(12);
                return `public/users/${metadata.userId}/avatars/${key}.${ext}`;
            },
        })
        .onUploadComplete(async ({ file: _file, url, key, metadata }) => {
            try {
                if (!url) {
                    throw new Error("Upload completed but no public URL was returned");
                }

                // Fetch the uploaded image from R2 to generate the thumbhash
                // and extract dimensions — this runs server-side via Sharp.
                const imageResponse = await fetch(url);
                if (!imageResponse.ok) {
                    throw new Error(
                        `Failed to fetch uploaded avatar from R2: ${imageResponse.status}`
                    );
                }
                const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
                const processed = await processImage(imageBuffer);

                // Update the database atomically: remove any old user-uploaded avatar
                // record, insert the new one, and point the account to the new avatar.
                await db.$transaction(async (tx: Parameters<typeof db.$transaction>[0] extends (arg: infer T) => unknown ? T : never) => {
                    await tx.uploadedFile.deleteMany({
                        where: {
                            accountId: metadata.userId,
                            path: {
                                startsWith: `public/users/${metadata.userId}/avatars/`,
                            },
                        },
                    });

                    await tx.uploadedFile.create({
                        data: {
                            accountId: metadata.userId,
                            path: key,
                            width: processed.width,
                            height: processed.height,
                            thumbhash: processed.thumbhash,
                        },
                    });

                    await tx.account.update({
                        where: { id: metadata.userId },
                        data: {
                            avatar: {
                                path: key,
                                width: processed.width,
                                height: processed.height,
                                thumbhash: processed.thumbhash,
                            },
                        },
                    });
                });

                // Push a real-time update to all connected clients so the avatar
                // refreshes immediately without a manual profile reload.
                const updSeq = await allocateUserSeq(metadata.userId);
                const updatePayload: UpdatePayload = {
                    id: randomKeyNaked(12),
                    seq: updSeq,
                    body: {
                        t: "update-account",
                        id: metadata.userId,
                        avatar: {
                            path: key,
                            width: processed.width,
                            height: processed.height,
                            thumbhash: processed.thumbhash,
                            url,
                        },
                    },
                    createdAt: Date.now(),
                };
                eventRouter.emitUpdate({
                    userId: metadata.userId,
                    payload: updatePayload,
                    recipientFilter: { type: "user-scoped-only" },
                });

                log(
                    { module: "upload" },
                    `Avatar upload complete for user ${metadata.userId}: ${key}`
                );
            } catch (error) {
                log(
                    { module: "upload", level: "error" },
                    `Failed to process avatar upload for user ${metadata.userId}: ${error}`
                );
                throw error;
            }
        }),
});

const { GET, POST } = uploadRouter.handlers;
const uploadHandler = toFastifyHandler({ GET, POST });

export function uploadRoutes(app: Fastify) {
    // The pushduck handler uses GET for presigned-URL info and POST for
    // the presign + complete actions. Auth is validated inside the route
    // middleware above, not via Fastify's preHandler, so that pushduck
    // can return a structured JSON error response.
    app.get("/v1/upload", uploadHandler);
    app.post("/v1/upload", uploadHandler);
}
