package com.slopus.happy.connection

import kotlinx.coroutines.flow.StateFlow
import java.net.URI
import java.net.URISyntaxException

/**
 * A private invite to a Happy Cloud server: `https://<invite host>/#<token>`,
 * or the older `https://<web host>/join#<token>`. The token rides in the
 * fragment, which a browser never sends, and it is the whole capability, so
 * it is held in memory only and never prints.
 */
data class CloudInvite(val token: String) {
    override fun toString() = "CloudInvite(…)"

    companion object {
        private val TOKEN = Regex("[A-Za-z0-9_-]{43}")

        /**
         * [link] as an invite: https on [inviteHost] at `/`, or on [webHost]
         * at `/join`, with no user info, port or query, and a 43-character
         * base64url token as its whole fragment. Null for anything else, and
         * wherever the build has no Happy Cloud (null hosts).
         */
        fun parse(link: String, inviteHost: String? = HappyCloud.inviteHost, webHost: String? = HappyCloud.webHost): CloudInvite? {
            val uri = try {
                URI(link.trim())
            } catch (_: URISyntaxException) {
                return null
            }
            if (uri.scheme?.lowercase() != "https" || uri.rawUserInfo != null || uri.port != -1 || uri.rawQuery != null) return null
            val host = uri.host?.lowercase() ?: return null
            val path = uri.rawPath.orEmpty().removeSuffix("/")
            val at = (host == inviteHost && path.isEmpty()) || (host == webHost && path == "/join")
            if (!at) return null
            return uri.rawFragment?.takeIf(TOKEN::matches)?.let(::CloudInvite)
        }
    }
}

/**
 * What the accounts service says of an invite (`POST /v1/invites/preview`):
 * the server it opens (its name, display name and picture only; no id or
 * address until the accept) and the name of the role it gives, the
 * server's own words ("Viewer").
 */
data class CloudInvitePreview(val server: CloudServer, val roleName: String?, val inviter: CloudInviter? = null)

/** Who sent the invite: their name, and their picture as a data: URL when they have one. */
data class CloudInviter(val name: String, val image: String?)

/**
 * A preview's picture: the bytes of a base64 `data:image/…` URL, which is
 * how the preview sends it. Null for anything else.
 */
fun inviteImage(url: String): ByteArray? {
    val match = DATA_IMAGE.matchEntire(url) ?: return null
    if (match.groupValues[1].length > MAX_IMAGE_BASE64) return null
    return try {
        java.util.Base64.getDecoder().decode(match.groupValues[1])
    } catch (_: IllegalArgumentException) {
        null
    }
}

private val DATA_IMAGE = Regex("data:image/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=]+)", RegexOption.IGNORE_CASE)
private const val MAX_IMAGE_BASE64 = 8 * 1024 * 1024

/** Why an invite can't be used, from the accounts service's `code`. */
sealed interface CloudInviteRefusal {
    data object Expired : CloudInviteRefusal
    data object Revoked : CloudInviteRefusal
    /** A link used as many times as it allows, or an emailed invite already accepted. */
    data object UsedUp : CloudInviteRefusal
    /** No such invite, or a malformed token. */
    data object Unknown : CloudInviteRefusal
    /** The invite was sent to another address; [emailHint] is the service's masked form of it. */
    data class EmailMismatch(val emailHint: String?) : CloudInviteRefusal
}

/** A preview or accept the service refused for a reason the person can act on. */
class CloudInviteException(val refusal: CloudInviteRefusal) : Exception(refusal.toString())

/** An invite's calls to the accounts service, and where the account's sign-in stands ([CloudAccount]'s). */
interface CloudInviteService {
    val state: StateFlow<CloudAccountState>
    suspend fun previewInvite(invite: CloudInvite): CloudInvitePreview
    suspend fun acceptInvite(invite: CloudInvite): CloudServer
}
