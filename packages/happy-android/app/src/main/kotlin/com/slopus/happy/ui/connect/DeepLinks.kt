package com.slopus.happy.ui.connect

import android.content.Intent
import com.slopus.happy.push.ACTION_OPEN_PUSH
import com.slopus.happy.push.EXTRA_PUSH_SESSION_ID
import com.slopus.happy.ui.RestoreManualRoute
import com.slopus.happy.ui.RestoreRoute
import com.slopus.happy.ui.ServerRoute
import com.slopus.happy.ui.SettingsRoute
import com.slopus.happy.ui.files.MessageDetailRoute
import com.slopus.happy.ui.files.SessionChangesRoute
import com.slopus.happy.ui.files.SessionFileRoute
import com.slopus.happy.ui.home.NewSessionRoute
import com.slopus.happy.ui.machine.MachineRoute
import com.slopus.happy.ui.onboarding.OnboardingSettingsRoute
import com.slopus.happy.ui.onboarding.TroubleshootRoute
import com.slopus.happy.ui.session.SessionInfoRoute
import com.slopus.happy.ui.settings.AccountRoute
import com.slopus.happy.ui.settings.AgentsRoute
import com.slopus.happy.ui.settings.AppearanceRoute
import com.slopus.happy.ui.settings.ChangelogRoute
import com.slopus.happy.ui.settings.ConnectClaudeRoute
import com.slopus.happy.ui.settings.LanguageRoute
import com.slopus.happy.ui.voice.VoiceSettingsRoute
import com.slopus.happy.ui.voice.VoiceLanguageRoute
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.net.URI
import java.net.URISyntaxException
import java.net.URLDecoder
import java.util.Base64

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

    /**
     * Any other app screen, as its navigation route. [signedOut] marks the
     * screens that work without an account (server, restore, troubleshoot,
     * changelog, onboarding settings), which open signed out too.
     */
    data class Screen(val route: Any, val signedOut: Boolean = false) : DeepLink

    /** `/`, and app paths with no screen on Android (excluded features, or none at all): Home. */
    data object Home : DeepLink
}

/**
 * Turns a link into a route the way expo-router does for happy-app: the
 * `happy` scheme treats the host as the first path segment
 * (`happy://terminal?k` and `happy:///terminal?k` are both `/terminal`), and
 * `https://app.happy.engineering/<path>` (app.config.js's production intent
 * filter) is the same path. Every app path maps to its screen; a path
 * Android has no screen for opens Home. Null only for links that aren't the
 * app's (another scheme or host, or not a URL).
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
    return route(segments, uri.rawQuery) ?: DeepLink.Home
}

/** app/(app)'s file routes. Static segments win over `[id]`, as in expo-router (`session/recent`). */
private fun route(segments: List<String>, rawQuery: String?): DeepLink? {
    val query by lazy { queryParams(rawQuery) }
    fun screen(route: Any) = DeepLink.Screen(route)
    fun signedOut(route: Any) = DeepLink.Screen(route, signedOut = true)
    return when (segments) {
        listOf("terminal") -> DeepLink.Terminal(firstParamName(rawQuery))
        listOf("terminal", "connect") -> DeepLink.TerminalWeb
        listOf("new") -> screen(NewSessionRoute)
        listOf("settings") -> screen(SettingsRoute)
        listOf("settings", "account") -> screen(AccountRoute)
        listOf("settings", "appearance") -> screen(AppearanceRoute)
        listOf("settings", "agents") -> screen(AgentsRoute)
        listOf("settings", "language") -> screen(LanguageRoute)
        listOf("settings", "voice") -> screen(VoiceSettingsRoute)
        listOf("settings", "voice", "language") -> screen(VoiceLanguageRoute)
        listOf("settings", "connect", "claude") -> screen(ConnectClaudeRoute)
        listOf("server") -> signedOut(ServerRoute)
        listOf("restore") -> signedOut(RestoreRoute)
        listOf("restore", "manual") -> signedOut(RestoreManualRoute)
        listOf("troubleshoot") -> signedOut(TroubleshootRoute)
        listOf("changelog") -> signedOut(ChangelogRoute)
        listOf("onboarding", "settings") -> signedOut(OnboardingSettingsRoute)
        else -> when {
            segments.size == 2 && segments[0] == "machine" -> screen(MachineRoute(segments[1]))
            segments.size < 2 || segments[0] != "session" || segments[1] == "recent" -> null
            else -> sessionRoute(segments[1], segments.drop(2), query)
        }
    }
}

/** session/[id] and the screens under it. */
private fun sessionRoute(id: String, rest: List<String>, query: Map<String, String>): DeepLink? = when {
    rest.isEmpty() -> DeepLink.Session(id)
    rest == listOf("info") -> DeepLink.Screen(SessionInfoRoute(id))
    rest == listOf("changes") -> DeepLink.Screen(SessionChangesRoute(id, query["file"]))
    rest == listOf("file") -> query["path"]?.let { path ->
        DeepLink.Screen(SessionFileRoute(id, decodeFilePath(path), query["line"]?.toIntOrNull(), query["column"]?.toIntOrNull()))
    }
    rest.size == 2 && rest[0] == "message" -> DeepLink.Screen(MessageDetailRoute(id, rest[1], query["file"]))
    else -> null
}

/**
 * file.tsx's `atob(path)`: the path as happy-app's `btoa` wrote it (Latin-1
 * bytes, not percent-encoded, so a `+` may arrive as a space); the raw value
 * if it isn't base64.
 */
internal fun decodeFilePath(encoded: String): String = try {
    String(Base64.getDecoder().decode(encoded.replace(' ', '+')), Charsets.ISO_8859_1)
} catch (_: IllegalArgumentException) {
    encoded
}

/** URLSearchParams: each name's first value, `+` and `%xx` decoded. */
private fun queryParams(rawQuery: String?): Map<String, String> {
    val params = LinkedHashMap<String, String>()
    for (pair in rawQuery.orEmpty().split('&')) {
        if (pair.isEmpty()) continue
        val name = decode(pair.substringBefore('='))
        params.putIfAbsent(name, if ('=' in pair) decode(pair.substringAfter('=')) else "")
    }
    return params
}

/** `Object.keys(useLocalSearchParams())[0]`: the name of the first query parameter. */
private fun firstParamName(rawQuery: String?): String? {
    val name = rawQuery?.substringBefore('&')?.substringBefore('=') ?: return null
    return decode(name).takeIf { it.isNotEmpty() }
}

private fun decode(value: String): String = try {
    URLDecoder.decode(value, "UTF-8") // The Charset overload is API 33.
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
