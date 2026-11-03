package com.slopus.happy.guest

import kotlinx.serialization.Serializable
import java.net.URI
import java.net.URISyntaxException
import java.security.MessageDigest
import java.text.BreakIterator
import java.text.Normalizer

/**
 * An invitation to chat with someone's bot as a guest (happy-ios
 * HappyGuest/GuestInvitation.swift, docs/APP-CLIP.md): an opaque token at
 * `https://app.happy.engineering/bot/invite/<token>`, and the origin its
 * bridge answers on (the link's own). It is the whole capability: no owner credential ever
 * takes part.
 */
data class GuestInvitation(val token: String, val origin: String) {
    val url: String get() = "$origin/bot/invite/$token"

    /** What the vault keys this invitation's session by: the SHA-256 of its origin and token, never the token itself. */
    val identifier: String
        get() = MessageDigest.getInstance("SHA-256").digest("$origin/$token".toByteArray()).joinToString("") { "%02x".format(it) }

    override fun toString() = "GuestInvitation($origin, …)"

    companion object {
        /**
         * The one host an invitation comes from. iOS's Preview build also takes
         * an ephemeral demo host (`GuestInvitation.previewHost`); no Android
         * build opens links from it, so none is taken here.
         */
        const val HOST = "app.happy.engineering"

        private val TOKEN = Regex("[A-Za-z0-9_-]{16,512}")

        /**
         * [link] as an invitation: https on a trusted host, exactly
         * `/bot/invite/<token>` with a 16–512-character base64url token, and
         * no user info, port, query or fragment. Null for anything else.
         */
        fun parse(link: String): GuestInvitation? {
            val uri = try {
                URI(link.trim())
            } catch (_: URISyntaxException) {
                return null
            }
            if (uri.scheme != "https" || uri.rawUserInfo != null || uri.port != -1) return null
            if (uri.rawQuery != null || uri.rawFragment != null) return null
            val host = uri.host ?: return null
            if (host != HOST) return null
            val parts = uri.rawPath.orEmpty().split('/')
            if (parts.size != 4 || parts[0].isNotEmpty() || parts[1] != "bot" || parts[2] != "invite") return null
            val token = parts[3].takeIf(TOKEN::matches) ?: return null
            return GuestInvitation(token, "https://$host")
        }
    }
}

/** A guest's scoped session, as the bridge redeemed it. [expiresAt] is Unix milliseconds. */
@Serializable
data class GuestSession(
    val sessionId: String,
    val sessionToken: String,
    val botName: String,
    val displayName: String? = null,
    val expiresAt: Double,
    val readOnly: Boolean = false,
) {
    override fun toString() = "GuestSession($sessionId, $botName)"
}

@Serializable
data class GuestMessage(
    val id: String,
    val role: String,
    val text: String,
    val createdAt: Double = 0.0,
    val senderName: String? = null,
    val isMine: Boolean? = null,
)

@Serializable
data class GuestMessages(val messages: List<GuestMessage> = emptyList(), val cursor: String? = null, val status: String = "online")

/** How the bridge refused, as the guest screen tells it. */
sealed class GuestError : Exception() {
    data object Expired : GuestError()
    data object Revoked : GuestError()
    data object AlreadyRedeemed : GuestError()
    data object InviteFull : GuestError()
    data object InvalidName : GuestError()
    data object ReadOnly : GuestError()
    data object Unavailable : GuestError()
    data object InvalidResponse : GuestError()

    /** Busy: try again in [seconds]. */
    data class RetryAfter(val seconds: Double) : GuestError()
}

/** A message the bridge won't take as written ([InvalidMessage]), or no more from this guest ([LimitReached]). */
sealed class GuestSendRejection : Exception() {
    data object InvalidMessage : GuestSendRejection()
    data object LimitReached : GuestSendRejection()
}

/**
 * A guest's name, as iOS's `GuestDisplayName`: NFC, spaces collapsed and
 * trimmed, 1–40 characters as a person counts them; letters, marks and
 * numbers, spaces and `. ' - _ ’`; no control, format, private-use,
 * unassigned or separator characters, no leading mark and at most four
 * marks on a character. Null when it isn't one.
 */
object GuestDisplayName {
    fun normalized(value: String): String? {
        val composed = Normalizer.normalize(value, Normalizer.Form.NFC)
        if (composed.codePoints().anyMatch { Character.getType(it).toByte() in REFUSED }) return null
        val name = composed.split(WHITESPACE).filter { it.isNotEmpty() }.joinToString(" ")
        val characters = graphemes(name)
        if (characters.size !in 1..40) return null
        for (character in characters) {
            var marks = 0
            character.codePoints().toArray().forEachIndexed { index, point ->
                when (Character.getType(point).toByte()) {
                    in LETTERS -> Unit
                    in MARKS -> {
                        marks++
                        if (index == 0 || marks > 4) return null
                    }
                    else -> if (point !in ALLOWED) return null
                }
            }
        }
        return name
    }

    private fun graphemes(text: String): List<String> {
        val breaks = BreakIterator.getCharacterInstance()
        breaks.setText(text)
        val out = ArrayList<String>()
        var start = breaks.first()
        var end = breaks.next()
        while (end != BreakIterator.DONE) {
            out += text.substring(start, end)
            start = end
            end = breaks.next()
        }
        return out
    }

    private val WHITESPACE = Regex("[\\s\\p{Z}]+")
    private val ALLOWED = " .'-_’".codePoints().toArray().toSet()
    private val REFUSED = setOf(
        Character.CONTROL, Character.FORMAT, Character.SURROGATE, Character.PRIVATE_USE,
        Character.UNASSIGNED, Character.LINE_SEPARATOR, Character.PARAGRAPH_SEPARATOR,
    )
    private val LETTERS = setOf(
        Character.UPPERCASE_LETTER, Character.LOWERCASE_LETTER, Character.TITLECASE_LETTER, Character.MODIFIER_LETTER,
        Character.OTHER_LETTER, Character.DECIMAL_DIGIT_NUMBER, Character.LETTER_NUMBER, Character.OTHER_NUMBER,
    )
    private val MARKS = setOf(Character.NON_SPACING_MARK, Character.COMBINING_SPACING_MARK, Character.ENCLOSING_MARK)
}
