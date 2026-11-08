package com.slopus.happy.browser

import android.webkit.WebViewClient
import com.slopus.happy.agent.AgentLinkStatus

/**
 * How the way to the computer stands, as the browser reads it (iOS's
 * `LinkState`, the cases it uses): the phone has no network, the agent
 * connection is offline, or it is up.
 */
enum class BrowserLink {
    Online, Offline, NoNetwork;

    companion object {
        /** [status] of the agent connection, or no network when it isn't connected and the phone has none; null while neither says. */
        fun of(status: AgentLinkStatus?, network: Boolean): BrowserLink? = when {
            // A connected computer is proof of a network, whatever the phone's check of it says.
            status == AgentLinkStatus.Connected -> Online
            !network -> NoNetwork
            status == AgentLinkStatus.Offline -> Offline
            else -> null
        }
    }
}

/**
 * Why the browser shows its error page instead of the page (iOS's
 * `BrowserProblem`, 34aa464e1), worked out from what WebView, the agent
 * proxy and the agent connection each say. The classifiers return null
 * where nothing went wrong that a person needs to hear about: a load that
 * was cancelled or replaced by another.
 */
sealed interface BrowserProblem {
    /** The phone has no network at all. */
    data object NoNetwork : BrowserProblem
    /** The computer the page opens through isn't answering. */
    data object ComputerUnreachable : BrowserProblem
    /** There is no agent connection or route to open the page through. */
    data object Unavailable : BrowserProblem
    /** A live artifact's page: the computer it was made on isn't there for it now, or it is no longer live (its proxy refused). */
    data object LiveUnavailable : BrowserProblem
    /** The computer couldn't find the site's address. */
    data object HostNotFound : BrowserProblem
    /** The server on the computer refused the connection or isn't answering. */
    data object ServerNotResponding : BrowserProblem
    /** The page took too long to answer. */
    data object TimedOut : BrowserProblem
    /** A secure connection couldn't be made. */
    data object Insecure : BrowserProblem
    /**
     * Android only: a plain-http page off localhost, which WebView refuses
     * before the proxy sees it (network_security_config; iOS allows it in
     * web content).
     */
    data object Cleartext : BrowserProblem
    /** The page answered with an error status and nothing to show; [reason] is the server's phrase, if it gave one. */
    data class Http(val status: Int, val reason: String? = null) : BrowserProblem
    /** The page's renderer stopped again after being reloaded once. */
    data object Crashed : BrowserProblem
    /** A link to an app or scheme this phone has nothing to open with. */
    data class Unsupported(val scheme: String) : BrowserProblem
    /** Anything else, in WebView's own words. */
    data class Other(val description: String) : BrowserProblem

    companion object {
        /**
         * A main-frame load that failed (`onReceivedError`): WebView's
         * [code] (`WebViewClient.ERROR_*`) and [description] (Chromium's
         * `net::ERR_*`). [refusal] is what the agent proxy last said for the
         * page's host, if it refused the tunnel.
         */
        fun navigation(code: Int, description: String, url: String?, refusal: BrowserProxyRefusal?, link: BrowserLink?): BrowserProblem? {
            val net = description.substringAfter("net::", "")
            if (isCancellation(net)) return null
            // The daemon itself refused the live artifact's route: whatever the phone thinks of its network, the computer answered.
            if (refusal?.problem == LiveUnavailable) return LiveUnavailable
            if (link == BrowserLink.NoNetwork) return NoNetwork
            if (net == "ERR_CLEARTEXT_NOT_PERMITTED") return Cleartext
            if (net.startsWith("ERR_CERT_") || net.startsWith("ERR_SSL_")) return Insecure
            if (code == WebViewClient.ERROR_UNSUPPORTED_SCHEME || net == "ERR_UNKNOWN_URL_SCHEME") {
                return Unsupported(url?.substringBefore(':', "")?.takeIf { it.isNotEmpty() && ':' in url }.orEmpty())
            }
            if (link == BrowserLink.Offline) return ComputerUnreachable
            // What the proxy said wins over WebView's code, which reports a refused tunnel under the TLS one.
            refusal?.let { return it.problem }
            if (code == WebViewClient.ERROR_FAILED_SSL_HANDSHAKE) return Insecure
            return when {
                net == "ERR_INTERNET_DISCONNECTED" -> NoNetwork
                // The loopback proxy itself is gone: nothing is there to open the page through.
                net == "ERR_PROXY_CONNECTION_FAILED" -> Unavailable
                // A tunnel the proxy refused without saying why it was kept: the way to the computer failed.
                net == "ERR_TUNNEL_CONNECTION_FAILED" -> ComputerUnreachable
                code == WebViewClient.ERROR_HOST_LOOKUP || net == "ERR_NAME_NOT_RESOLVED" -> HostNotFound
                code == WebViewClient.ERROR_TIMEOUT || net == "ERR_TIMED_OUT" || net == "ERR_CONNECTION_TIMED_OUT" -> TimedOut
                code == WebViewClient.ERROR_CONNECT || net == "ERR_CONNECTION_REFUSED" || net == "ERR_CONNECTION_RESET" ||
                    net == "ERR_CONNECTION_CLOSED" || net == "ERR_EMPTY_RESPONSE" || net == "ERR_INVALID_RESPONSE" -> ServerNotResponding
                else -> Other(description)
            }
        }

        /**
         * The main frame's error status (`onReceivedHttpError`). An error
         * status with a body is the page's own error page and shows; one
         * without has nothing to show. The agent proxy's own 502, 503 and
         * 504 (`X-Happy-Proxy-Error`) mean the server behind it isn't
         * answering, whatever its body says.
         */
        fun response(status: Int, proxyError: String?, hasBody: Boolean, link: BrowserLink?, reason: String? = null): BrowserProblem? {
            if (status < 400) return null
            if (proxyError != null) {
                if (BrowserProxyRefusal(status, proxyError).problem == LiveUnavailable) return LiveUnavailable
                if (link == BrowserLink.NoNetwork) return NoNetwork
                if (link == BrowserLink.Offline) return ComputerUnreachable
                // The proxy's own answer says which side failed (docs/browser-proxy.md: a failed tunnel to the computer is Can't Reach).
                BrowserProxyRefusal(status, proxyError).problem.takeIf { it != Unavailable }?.let { return it }
                if (status in 502..504) return ServerNotResponding
            }
            return if (hasBody && proxyError == null) null else Http(status, reason?.takeIf { it.isNotBlank() })
        }

        /** Opening the page failed before WebView had it: finding the workspace, or starting the proxy. */
        fun opening(error: Throwable, link: BrowserLink?): BrowserProblem = when {
            link == BrowserLink.NoNetwork -> NoNetwork
            link == BrowserLink.Offline -> ComputerUnreachable
            error is BrowserException && error.kind == BrowserException.Kind.LiveUnavailable -> LiveUnavailable
            error is BrowserException || error is com.slopus.happy.agent.AgentApiException -> Unavailable
            else -> ComputerUnreachable
        }

        /** Chromium's words for a load that was stopped or replaced, never an error to show. */
        private fun isCancellation(net: String) = net == "ERR_ABORTED" || net == "ERR_BLOCKED_BY_CLIENT"
    }
}

/**
 * What the agent proxy answered instead of opening a tunnel to a page's
 * host ([BrowserFailure]), kept so the screen can say why: WebView only
 * reports `ERR_TUNNEL_CONNECTION_FAILED`.
 */
data class BrowserProxyRefusal(val status: Int, val code: String) {
    val problem: BrowserProblem get() = when (code) {
        "browser_proxy_upstream_transport", "browser_proxy_socket_transport", "browser_proxy_upstream_capacity" -> BrowserProblem.ComputerUnreachable
        "browser_proxy_upstream_timeout" -> BrowserProblem.TimedOut
        "browser_proxy_upstream_response_invalid" -> BrowserProblem.ServerNotResponding
        "browser_proxy_upstream_refused" if status in 502..504 -> BrowserProblem.ServerNotResponding
        "browser_proxy_live_unavailable" -> BrowserProblem.LiveUnavailable
        else -> BrowserProblem.Unavailable
    }
}

/**
 * A page's proxy refusals by host, newest kept (iOS's `BrowserRefusals`),
 * read by the screen when WebView says a load failed. Written from the
 * proxy's connections, read on the main thread.
 */
class BrowserRefusals {
    private val byAuthority = HashMap<String, BrowserProxyRefusal>()

    @Synchronized
    fun record(refusal: BrowserProxyRefusal, authority: BrowserPolicy.Authority) {
        byAuthority[authority.text] = refusal
    }

    /** The last refusal for [url]'s host, if any since it was last cleared. */
    @Synchronized
    fun last(url: String): BrowserProxyRefusal? = BrowserPolicy.Authority.of(url)?.let { byAuthority[it.text] }

    /** Forgets what was refused, before a new load of the page. */
    @Synchronized
    fun clear() = byAuthority.clear()
}
