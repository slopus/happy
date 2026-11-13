package com.slopus.happy.onboarding

import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.decode
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import com.slopus.happy.chat.strings
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** `POST /v0/onboarding/complete` refused: these gates still block. */
class OnboardingIncomplete(val blocking: List<String>) : Exception("onboarding_incomplete")

/** A Happy Cloud server's onboarding routes (T09's contract v6). */
object OnboardingApi {
    suspend fun read(client: AgentClient): CloudOnboarding = CloudOnboarding.parse(client.decode<JsonObject>("GET", "/v0/onboarding"))

    /** Skips an optional gate, for the person alone (a member gate) or the whole team (a server gate); answers onboarding as it is now. */
    suspend fun skip(client: AgentClient, gateId: String): CloudOnboarding =
        CloudOnboarding.parse(client.decode<JsonObject>("POST", "/v0/onboarding/gates/${AgentClient.escape(gateId)}/skip", JsonObject(emptyMap())))

    /**
     * Names the admin bot (`PATCH /v0/bots/:id`, `If-Match` the gate's
     * [version]); a version that moved meanwhile (`409`) is read again
     * once and the name sent with it.
     */
    suspend fun renameAdminBot(client: AgentClient, botId: String, name: String, version: String?) {
        val path = "/v0/bots/${AgentClient.escape(botId)}"
        val mutationId = AgentClient.newId()
        var match = version ?: currentVersion(client, path)
        repeat(2) { attempt ->
            try {
                client.send("PATCH", path, buildJsonObject { put("name", name); put("mutationId", mutationId) }, headers = mapOf("If-Match" to match))
                return
            } catch (e: AgentApiException) {
                if (e.status != 409 || attempt == 1) throw e
                match = currentVersion(client, path)
            }
        }
    }

    private suspend fun currentVersion(client: AgentClient, path: String): String =
        client.decode<JsonObject>("GET", path)["bot"].obj?.get("version").str ?: throw AgentApiException(500, "invalid_response", null)

    /** Finishes, skipping every optional gate still open that the person can complete; [OnboardingIncomplete] while one blocks. */
    suspend fun complete(client: AgentClient) {
        try {
            client.send("POST", "/v0/onboarding/complete", JsonObject(emptyMap()))
        } catch (e: AgentApiException) {
            if (e.status == 409 && e.code == "onboarding_incomplete") throw OnboardingIncomplete(e.body.obj?.get("blocking").strings.orEmpty())
            throw e
        }
    }
}
