package com.slopus.happy.ui.connect

import android.content.Intent
import com.slopus.happy.push.ACTION_OPEN_PUSH
import com.slopus.happy.push.EXTRA_PUSH_SESSION_ID
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.net.URI
import java.net.URISyntaxException
import java.net.URLDecoder

/** Where a link from outside the app goes. */
sealed interface DeepLink {
    /**
     * terminal/index.tsx: the confirm screen for `happy://terminal?<key>`.
     * [publicKey] is the first search parameter's name, as the screen reads
     * it; null shows "Invalid Connection Link".
     */
    data class Terminal(val publicKey: String?) : DeepLink

    /**
     * terminal/connect.tsx: the CLI's web link (`/terminal/connect#key=…`).
     * Outside a browser it only says to use a browser or the scanner.
     */
    data object TerminalWeb : DeepLink

    /** session/[id]: an app link or a notification for a session. */
    data class Session(val id: String) : DeepLink
}

/**
 * Turns a link into a route the way expo-router does for happy-app: the
 * `happy` scheme treats the host as the first path segment
 * (`happy://terminal?k` and `happy:///terminal?k` are both `/terminal`), and
 * `https://app.happy.engineering/<path>` (app.config.js's production intent
 * filter) is the same path. Null for anything without a matching route.
 */
fun parseDeepLink(link: String): DeepLink? {
    val uri = try {
        URI(link.trim())
    } catch (_: URISyntaxException) {
        return null
    }
    val segments = when (uri.scheme?.lowercase()) {
        SCHEME -> listOfNotNull(uri.host) + uri.rawPath.orEmpty().split('/')
        "https" -> if (uri.host?.lowercase() == APP_LINK_HOST) uri.rawPath.orEmpty().split('/') else return null
        else -> return null
    }.filter { it.isNotEmpty() }.map(::decode)
    return when {
        segments == listOf("terminal") -> DeepLink.Terminal(firstParamName(uri.rawQuery))
        segments == listOf("terminal", "connect") -> DeepLink.TerminalWeb
        segments.size == 2 && segments[0] == "session" -> DeepLink.Session(segments[1])
        else -> null
    }
}

/** `Object.keys(useLocalSearchParams())[0]`: the name of the first query parameter. */
private fun firstParamName(rawQuery: String?): String? {
    val name = rawQuery?.substringBefore('&')?.substringBefore('=') ?: return null
    return decode(name).takeIf { it.isNotEmpty() }
}

private fun decode(value: String): String = try {
    URLDecoder.decode(value, Charsets.UTF_8)
} catch (_: IllegalArgumentException) {
    value
}

private const val SCHEME = "happy"
const val APP_LINK_HOST = "app.happy.engineering"

/**
 * Links handed to the app from outside, waiting for the UI to take them.
 * MainActivity offers every launching and new intent (links, and taps on
 * push notifications, see [com.slopus.happy.push.pushTapIntent]); HappyApp consumes
 * them through [DeepLinkEffect] once the signed-in screens are up.
 */
object DeepLinks {
    private val inbox = MutableStateFlow<DeepLink?>(null)

    val pending: StateFlow<DeepLink?> = inbox.asStateFlow()

    /** Takes a VIEW intent's link or a notification tap's session. True if it was one the app handles. */
    fun offer(intent: Intent?): Boolean {
        if (intent?.action == ACTION_OPEN_PUSH) {
            val sessionId = intent.getStringExtra(EXTRA_PUSH_SESSION_ID) ?: return false
            offer(DeepLink.Session(sessionId))
            return true
        }
        if (intent?.action != Intent.ACTION_VIEW) return false
        val link = intent.dataString?.let(::parseDeepLink) ?: return false
        offer(link)
        return true
    }

    fun offer(link: DeepLink) {
        inbox.value = link
    }

    /** Takes [link] off the inbox if it is still the pending one. */
    fun consume(link: DeepLink): Boolean = inbox.compareAndSet(link, null)
}
