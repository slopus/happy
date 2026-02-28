import { z } from "zod";
import { type Fastify } from "../types";
import * as semver from 'semver';
import { ANDROID_UP_TO_DATE, IOS_UP_TO_DATE } from "@/versions";

export function versionRoutes(app: Fastify) {
    app.post('/v1/version', {
        schema: {
            body: z.object({
                platform: z.string(),
                version: z.string(),
                app_id: z.string()
            }),
            response: {
                200: z.object({
                    updateUrl: z.string().nullable()
                })
            }
        }
    }, async (request, reply) => {
        const { platform, version, app_id } = request.body;

        // Check ios
        if (platform.toLowerCase() === 'ios') {
            if (semver.satisfies(version, IOS_UP_TO_DATE)) {
                reply.send({ updateUrl: null });
            } else {
                reply.send({ updateUrl: null }); // TODO: fill in App Store URL after publishing
            }
            return;
        }

        // Check android
        if (platform.toLowerCase() === 'android') {
            if (semver.satisfies(version, ANDROID_UP_TO_DATE)) {
                reply.send({ updateUrl: null });
            } else {
                reply.send({ updateUrl: 'https://play.google.com/store/apps/details?id=com.hitosea.happy' });
            }
            return;
        }

        // Fallbacke
        reply.send({ updateUrl: null });
    });
}