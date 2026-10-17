import { createHmac } from "crypto";
import fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { VoiceConversationResponseSchema, VoiceUsageResponseSchema } from "@slopus/happy-wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";
import { voiceRoutes } from "./voiceRoutes";

const userId = "voice-user";
const agentId = "test-agent";
const masterSecret = "test-master-secret";
const elevenUserId = `u_${createHmac("sha256", masterSecret).update(userId).digest("base64url")}`;
// Only the provider's JWT payload is read by this route; signing belongs to ElevenLabs.
const conversationToken = [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ video: { room: "agent_conv_test123" } })).toString("base64url"),
    "provider-signature",
].join(".");

describe("voiceRoutes", () => {
    let app: Fastify;
    const fetchMock = vi.fn<typeof fetch>();

    beforeEach(async () => {
        vi.stubEnv("ELEVENLABS_API_KEY", "test-elevenlabs-key");
        vi.stubEnv("HANDY_MASTER_SECRET", masterSecret);
        vi.stubEnv("REVENUECAT_API_KEY", undefined);
        fetchMock.mockReset();
        // Unexpected network requests must fail, never reach a real service.
        fetchMock.mockRejectedValue(new Error("Unexpected provider request"));
        vi.stubGlobal("fetch", fetchMock);

        app = fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
            const authenticatedUserId = request.headers["x-user-id"];
            if (typeof authenticatedUserId !== "string") {
                return reply.code(401).send({ error: "Unauthorized" });
            }
            request.userId = authenticatedUserId;
        });
        voiceRoutes(app);
        await app.ready();
    });

    afterEach(async () => {
        await app.close();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    function mockUsage(durations: number[]) {
        fetchMock.mockResolvedValueOnce(Response.json({
            conversations: durations.map(call_duration_secs => ({ call_duration_secs })),
        }));
    }

    function mockToken() {
        fetchMock.mockResolvedValueOnce(Response.json({ token: conversationToken }));
    }

    function requestConversation(authenticated = true) {
        return app.inject({
            method: "POST",
            url: "/v1/voice/conversations",
            headers: authenticated ? { "x-user-id": userId } : {},
            payload: { agentId },
        });
    }

    it.each([0, 1199])("grants free voice at %i seconds without RevenueCat configuration", async (usedSeconds) => {
        mockUsage(usedSeconds ? [usedSeconds] : []);
        mockToken();

        const requestStartedAt = Date.now();
        const response = await requestConversation();

        expect(response.statusCode).toBe(200);
        expect(VoiceConversationResponseSchema.parse(response.json())).toEqual({
            allowed: true,
            conversationToken,
            conversationId: "conv_test123",
            agentId,
            elevenUserId,
            usedSeconds,
            limitSeconds: 1200,
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const usageUrl = new URL(String(fetchMock.mock.calls[0][0]));
        expect(usageUrl.origin).toBe("https://api.elevenlabs.io");
        expect(usageUrl.pathname).toBe("/v1/convai/conversations");
        expect(usageUrl.searchParams.get("user_id")).toBe(elevenUserId);
        expect(usageUrl.searchParams.get("page_size")).toBe("100");
        const windowStart = Date.parse(usageUrl.searchParams.get("created_after")!);
        expect(windowStart).toBeGreaterThanOrEqual(requestStartedAt - 30 * 86400 * 1000);
        expect(windowStart).toBeLessThanOrEqual(Date.now() - 30 * 86400 * 1000);
        expect(fetchMock).toHaveBeenNthCalledWith(2,
            `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${agentId}&participant_name=${elevenUserId}`,
            { headers: { "xi-api-key": "test-elevenlabs-key" } },
        );
    });

    it.each([1200, 17999])("requires a subscription at %i seconds without RevenueCat configuration", async (usedSeconds) => {
        mockUsage([usedSeconds]);

        const response = await requestConversation();

        expect(response.statusCode).toBe(200);
        expect(VoiceConversationResponseSchema.parse(response.json())).toEqual({
            allowed: false,
            reason: "subscription_required",
            usedSeconds,
            limitSeconds: 1200,
            agentId,
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("requires authentication before querying usage or minting a token", async () => {
        const response = await requestConversation(false);

        expect(response.statusCode).toBe(401);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("still requires ElevenLabs credentials", async () => {
        vi.stubEnv("ELEVENLABS_API_KEY", undefined);

        const response = await requestConversation();

        expect(response.statusCode).toBe(500);
        expect(response.json()).toEqual({ error: "ELEVENLABS_API_KEY not configured" });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([undefined, "test-revenuecat-key"])("enforces the hard cap with RevenueCat key %s", async (key) => {
        vi.stubEnv("REVENUECAT_API_KEY", key);
        mockUsage([18000]);

        const response = await requestConversation();

        expect(response.statusCode).toBe(200);
        expect(VoiceConversationResponseSchema.parse(response.json())).toEqual({
            allowed: false,
            reason: "voice_hard_limit_reached",
            usedSeconds: 18000,
            limitSeconds: 18000,
            agentId,
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([undefined, "test-revenuecat-key"])("enforces the conversation cap with RevenueCat key %s", async (key) => {
        vi.stubEnv("REVENUECAT_API_KEY", key);
        mockUsage(Array.from({ length: 100 }, () => 1));

        const response = await requestConversation();

        expect(response.statusCode).toBe(200);
        expect(VoiceConversationResponseSchema.parse(response.json())).toEqual({
            allowed: false,
            reason: "voice_conversation_limit_reached",
            usedSeconds: 100,
            limitSeconds: 18000,
            agentId,
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("allows an active subscription above the free limit when RevenueCat is configured", async () => {
        vi.stubEnv("REVENUECAT_API_KEY", "test-revenuecat-key");
        mockUsage([1200]);
        fetchMock.mockResolvedValueOnce(Response.json({ items: [{ entitlement_id: "voice" }] }));
        mockToken();

        const response = await requestConversation();

        expect(response.statusCode).toBe(200);
        expect(VoiceConversationResponseSchema.parse(response.json())).toEqual({
            allowed: true,
            conversationToken,
            conversationId: "conv_test123",
            agentId,
            elevenUserId,
            usedSeconds: 1200,
            limitSeconds: 18000,
        });
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(fetchMock).toHaveBeenNthCalledWith(2,
            `https://api.revenuecat.com/v2/projects/proj493735ad/customers/${userId}/active_entitlements`,
            { method: "GET", headers: { Authorization: "Bearer test-revenuecat-key" } },
        );
    });

    it.each([
        { name: "no active entitlement", status: 200, body: { items: [] } },
        { name: "a failed subscription check", status: 503, body: {} },
    ])("requires a subscription with $name when RevenueCat is configured", async ({ status, body }) => {
        vi.stubEnv("REVENUECAT_API_KEY", "test-revenuecat-key");
        mockUsage([1200]);
        fetchMock.mockResolvedValueOnce(Response.json(body, { status }));

        const response = await requestConversation();

        expect(response.statusCode).toBe(200);
        expect(VoiceConversationResponseSchema.parse(response.json())).toEqual({
            allowed: false,
            reason: "subscription_required",
            usedSeconds: 1200,
            limitSeconds: 1200,
            agentId,
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("reports the free allowance in usage without RevenueCat configuration", async () => {
        mockUsage([400, 800]);

        const response = await app.inject({
            method: "GET",
            url: "/v1/voice/usage",
            headers: { "x-user-id": userId },
        });

        expect(response.statusCode).toBe(200);
        expect(VoiceUsageResponseSchema.parse(response.json())).toEqual({
            usedSeconds: 1200,
            limitSeconds: 1200,
            conversationCount: 2,
            conversationLimit: 100,
            elevenUserId,
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
