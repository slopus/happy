package com.slopus.happy.onboarding

import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.decode
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * An invite to a Happy Cloud server (`POST /v0/invites`), as made: its
 * [link] is shown once, to whoever made it. [deliveryStatus] says whether
 * an email invite's email went out ("failed" when it didn't); null for a
 * link.
 */
data class TeamInvite(val id: String, val link: String?, val deliveryStatus: String? = null) {
    val emailFailed: Boolean get() = deliveryStatus == "failed"
}

/** Why an invite wasn't made. */
sealed class TeamInviteRefusal(message: String?) : Exception(message) {
    /** The server can't send email (`503 email_not_configured`): a link invite, shared by hand, still works. */
    object EmailNotConfigured : TeamInviteRefusal("email_not_configured")

    /** The server has no invite route. */
    object Unsupported : TeamInviteRefusal("unsupported")

    /** Refused as it was asked: an address it won't take, a role; the server's words when it gave some. */
    class Refused(message: String?) : TeamInviteRefusal(message)
}

object TeamInvites {
    /** Invites [email] as a member, or makes a link anyone may join by when null. */
    suspend fun invite(client: AgentClient, email: String?): TeamInvite {
        val body = buildJsonObject {
            put("mutationId", AgentClient.newId())
            if (email != null) put("email", email)
        }
        val answer = try {
            client.decode<JsonObject>("POST", "/v0/invites", body)
        } catch (e: AgentApiException) {
            throw when {
                e.status == 503 && e.code == "email_not_configured" -> TeamInviteRefusal.EmailNotConfigured
                e.status == 404 || e.status == 405 -> TeamInviteRefusal.Unsupported
                e.status in 400..499 && e.status != 401 -> TeamInviteRefusal.Refused(e.message)
                else -> e
            }
        }
        val invite = answer["invite"].obj ?: throw AgentApiException(500, "invalid_response", null)
        val id = invite["id"].str ?: throw AgentApiException(500, "invalid_response", null)
        return TeamInvite(id, invite["link"].str, invite["deliveryStatus"].str)
    }
}

/** An email address as far as it can be told while typing: something, an @, and a domain with a dot in it. */
object EmailAddress {
    fun looksValid(text: String): Boolean {
        val parts = text.split("@")
        if (parts.size != 2 || parts[0].isEmpty() || text.any { it.isWhitespace() }) return false
        val domain = parts[1].split(".")
        return domain.size >= 2 && domain.all { it.isNotEmpty() }
    }
}
