package com.slopus.happy.connection

import kotlinx.coroutines.flow.StateFlow
import java.net.URI
import java.net.URISyntaxException

/**
 * What a link at an invite's address holds: the [CloudInvite], or nothing
 * usable ([Malformed]), which the invite screen says without asking the
 * API anything.
 */
sealed interface CloudInviteLink {
    /** At an invite's address with no token, a misshapen one, or one put anywhere but the fragment. */
    data object Malformed : CloudInviteLink

    companion object {
        /** The app's own scheme and where the web join page's "Open in Happy" points: `happy://cloud/join#<token>`. */
        private const val SCHEME = "happy"
        private const val SCHEME_HOST = "cloud"
        private const val PATH = "/join"

        /**
         * [link] as an invite link: `https://<webHost>/join#<token>` or
         * `happy://cloud/join#<token>`, and nothing else. Null for any other
         * host or path (the web host's `/` is the server picker and
         * `<name>.<webHost>` a server's web app), and wherever the build has
         * no Happy Cloud (a null [webHost]). At that address, anything but a
         * bare 43-character token as the whole fragment (none, a misshapen
         * one, a query, a port, user info) is [Malformed].
         */
        fun of(link: String, webHost: String? = HappyCloud.webHost): CloudInviteLink? {
            if (webHost == null) return null
            val uri = try {
                URI(link.trim())
            } catch (_: URISyntaxException) {
                return null
            }
            val host = uri.host?.lowercase() ?: return null
            val ours = when (uri.scheme?.lowercase()) {
                "https" -> host == webHost.lowercase()
                SCHEME -> host == SCHEME_HOST
                else -> false
            }
            if (!ours || uri.rawPath.orEmpty().removeSuffix("/") != PATH) return null
            if (uri.rawUserInfo != null || uri.port != -1 || uri.rawQuery != null) return Malformed
            return uri.rawFragment?.takeIf(CloudInvite.TOKEN::matches)?.let(::CloudInvite) ?: Malformed
        }
    }
}

/**
 * A private invite to a Happy Cloud server, from its link
 * ([CloudInviteLink.of]). The token rides in the fragment, which a browser
 * never sends, and it is the whole capability, so it is held in memory
 * only, never prints, and goes nowhere but the API's preview and accept.
 */
data class CloudInvite(val token: String) : CloudInviteLink {
    override fun toString() = "CloudInvite(…)"

    companion object {
        internal val TOKEN = Regex("[A-Za-z0-9_-]{43}")

        /** [link]'s invite; null for any link that isn't one, and for one whose token is missing or misshapen. */
        fun parse(link: String, webHost: String? = HappyCloud.webHost): CloudInvite? = CloudInviteLink.of(link, webHost) as? CloudInvite
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
    /** A link used as many times as it allows (`exhausted`). */
    data object UsedUp : CloudInviteRefusal
    /** An invite for one address, already taken, perhaps by this account (`accepted`). */
    data object Accepted : CloudInviteRefusal
    /** No such invite (`invalid`), or a link with no usable token ([CloudInviteLink.Malformed]). */
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
