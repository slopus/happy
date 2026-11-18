package com.slopus.happy.ui.connect

import java.net.URI

/** Copy only, for input already rejected by HappyCode. Never opens a URL. */
internal enum class RejectedPairingLink {
    Download, HappyWebsite, LegacyWebPairing;

    companion object {
        fun classify(text: String): RejectedPairingLink? {
            val url = runCatching { URI(text.trim()) }.getOrNull() ?: return null
            val scheme = url.scheme?.lowercase()
            if (scheme != "http" && scheme != "https") return null
            val host = url.host?.lowercase() ?: return null
            // iOS can use the CLI's browser link; Android's scanner has never
            // supported it. Keep that fallback instead of calling it a website.
            if (url.path.endsWith("/terminal/connect") && url.fragment?.startsWith("key=") == true) return LegacyWebPairing
            if (url.rawUserInfo != null || url.port != -1) return null
            val path = url.rawPath.split('/').filter { it.isNotEmpty() }
            return when (host) {
                "link.happy.engineering" -> if (path == listOf("download")) Download else HappyWebsite
                "happy.engineering", "www.happy.engineering" ->
                    if (path == listOf("download") || (path.isEmpty() && url.fragment == "download")) Download else HappyWebsite
                "app.happy.engineering" -> HappyWebsite
                "testflight.apple.com" -> Download.takeIf { path.size == 2 && path.first() == "join" }
                "apps.apple.com", "itunes.apple.com" -> {
                    val last = path.lastOrNull().orEmpty()
                    val id = last.removePrefix("id")
                    Download.takeIf { "app" in path && last.startsWith("id") && id.isNotEmpty() && id.all { it in '0'..'9' } }
                }
                "play.google.com" -> Download.takeIf {
                    path == listOf("store", "apps", "details") &&
                        url.rawQuery?.split('&')?.any { it.startsWith("id=") && it.length > 3 } == true
                }
                else -> null
            }
        }
    }
}