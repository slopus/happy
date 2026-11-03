package com.slopus.happy.browser

import android.webkit.WebViewClient
import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentLinkStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** iOS's BrowserStateTests (34aa464e1): the loading bar's run and what each failure is shown as. */
class BrowserStateModelTest {
    @Test fun theBarStartsAtOnceTricklesAndNeverGoesBack() {
        var bar = BrowserProgress().begin()
        assertEquals(BrowserProgress(BrowserProgress.Phase.Loading, 0.1f), bar)
        bar = bar.trickle()
        assertEquals(0.136f, bar.value, 0.0001f)
        bar = bar.trickle()
        assertEquals(0.16984f, bar.value, 0.0001f)
        // WebView's 10 % while the tunnel opens is behind it: kept where it is.
        assertEquals(bar, bar.estimate(0.1f))
        bar = bar.estimate(0.8f)
        assertEquals(0.8f, bar.value)
        // Past the trickle's ceiling it waits for the page.
        assertEquals(bar, bar.trickle())
        // A redirect begins again without moving back.
        assertEquals(bar, bar.begin())
        bar = bar.finish()
        assertEquals(BrowserProgress(BrowserProgress.Phase.Finishing, 1f), bar)
        assertEquals(bar, bar.estimate(0.5f))
        assertEquals(BrowserProgress(), bar.hide())
    }

    @Test fun trickleApproachesItsCeilingAndStopsShortOfIt() {
        var bar = BrowserProgress().begin()
        repeat(200) { bar = bar.trickle() }
        assertTrue(bar.value < BrowserProgress.TRICKLE_CEILING)
        assertTrue(bar.value > 0.69f)
    }

    @Test fun nothingMovesAHiddenBar() {
        val hidden = BrowserProgress()
        assertEquals(hidden, hidden.estimate(0.5f))
        assertEquals(hidden, hidden.trickle())
        assertEquals(hidden, hidden.finish())
        assertEquals(hidden, BrowserProgress().begin().estimate(Float.NaN).hide())
    }

    @Test fun webViewFailuresAreShownAsWhatWentWrong() {
        fun nav(code: Int, description: String, refusal: BrowserProxyRefusal? = null, link: BrowserLink? = BrowserLink.Online, url: String = "https://example.com/") =
            BrowserProblem.navigation(code, description, url, refusal, link)
        assertNull(nav(WebViewClient.ERROR_UNKNOWN, "net::ERR_ABORTED"))
        assertNull(nav(WebViewClient.ERROR_UNKNOWN, "net::ERR_ABORTED", link = BrowserLink.NoNetwork))
        assertEquals(BrowserProblem.NoNetwork, nav(WebViewClient.ERROR_CONNECT, "net::ERR_TUNNEL_CONNECTION_FAILED", link = BrowserLink.NoNetwork))
        assertEquals(BrowserProblem.ComputerUnreachable, nav(WebViewClient.ERROR_CONNECT, "net::ERR_TUNNEL_CONNECTION_FAILED", link = BrowserLink.Offline))
        assertEquals(BrowserProblem.ComputerUnreachable, nav(WebViewClient.ERROR_CONNECT, "net::ERR_TUNNEL_CONNECTION_FAILED"))
        assertEquals(
            BrowserProblem.ServerNotResponding,
            nav(WebViewClient.ERROR_CONNECT, "net::ERR_TUNNEL_CONNECTION_FAILED", BrowserProxyRefusal(502, "browser_proxy_upstream_refused")),
        )
        assertEquals(BrowserProblem.TimedOut, nav(WebViewClient.ERROR_CONNECT, "net::ERR_TUNNEL_CONNECTION_FAILED", BrowserProxyRefusal(504, "browser_proxy_upstream_timeout")))
        assertEquals(BrowserProblem.Cleartext, nav(WebViewClient.ERROR_UNKNOWN, "net::ERR_CLEARTEXT_NOT_PERMITTED", url = "http://example.com/"))
        assertEquals(BrowserProblem.Insecure, nav(WebViewClient.ERROR_FAILED_SSL_HANDSHAKE, "net::ERR_SSL_PROTOCOL_ERROR"))
        assertEquals(BrowserProblem.Insecure, nav(WebViewClient.ERROR_FAILED_SSL_HANDSHAKE, ""))
        // WebView reports a refused tunnel under the TLS code: what the proxy said wins.
        assertEquals(
            BrowserProblem.ServerNotResponding,
            nav(WebViewClient.ERROR_FAILED_SSL_HANDSHAKE, "net::ERR_TUNNEL_CONNECTION_FAILED", BrowserProxyRefusal(502, "browser_proxy_upstream_refused")),
        )
        assertEquals(
            BrowserProblem.Insecure,
            nav(WebViewClient.ERROR_UNKNOWN, "net::ERR_CERT_DATE_INVALID", BrowserProxyRefusal(502, "browser_proxy_upstream_refused")),
        )
        assertEquals(BrowserProblem.Insecure, nav(WebViewClient.ERROR_UNKNOWN, "net::ERR_CERT_AUTHORITY_INVALID"))
        assertEquals(BrowserProblem.HostNotFound, nav(WebViewClient.ERROR_HOST_LOOKUP, "net::ERR_NAME_NOT_RESOLVED"))
        assertEquals(BrowserProblem.TimedOut, nav(WebViewClient.ERROR_TIMEOUT, "net::ERR_TIMED_OUT"))
        assertEquals(BrowserProblem.ServerNotResponding, nav(WebViewClient.ERROR_CONNECT, "net::ERR_CONNECTION_REFUSED"))
        assertEquals(BrowserProblem.ServerNotResponding, nav(WebViewClient.ERROR_UNKNOWN, "net::ERR_EMPTY_RESPONSE"))
        assertEquals(BrowserProblem.Unavailable, nav(WebViewClient.ERROR_CONNECT, "net::ERR_PROXY_CONNECTION_FAILED"))
        assertEquals(BrowserProblem.Unsupported("intent"), nav(WebViewClient.ERROR_UNSUPPORTED_SCHEME, "net::ERR_UNKNOWN_URL_SCHEME", url = "intent://x"))
        assertEquals(BrowserProblem.Other("net::ERR_FAILED"), nav(WebViewClient.ERROR_UNKNOWN, "net::ERR_FAILED"))
    }

    @Test fun errorStatusesShowOnlyWithNothingToShow() {
        assertNull(BrowserProblem.response(200, null, hasBody = true, link = null))
        assertNull(BrowserProblem.response(404, null, hasBody = true, link = null))
        assertEquals(BrowserProblem.Http(404, "Not Found"), BrowserProblem.response(404, null, hasBody = false, link = null, reason = "Not Found"))
        assertEquals(BrowserProblem.Http(500), BrowserProblem.response(500, null, hasBody = false, link = null, reason = " "))
        // The proxy's own error says which side failed; a code it doesn't explain is the server behind it.
        assertEquals(BrowserProblem.ComputerUnreachable, BrowserProblem.response(502, "browser_proxy_upstream_transport", hasBody = true, link = BrowserLink.Online))
        assertEquals(BrowserProblem.TimedOut, BrowserProblem.response(504, "browser_proxy_upstream_timeout", hasBody = true, link = BrowserLink.Online))
        assertEquals(BrowserProblem.ServerNotResponding, BrowserProblem.response(503, "browser_proxy_route_unavailable", hasBody = true, link = BrowserLink.Online))
        assertEquals(BrowserProblem.NoNetwork, BrowserProblem.response(503, "browser_proxy_route_unavailable", hasBody = true, link = BrowserLink.NoNetwork))
        // A page's own error status is its own, network or not.
        assertNull(BrowserProblem.response(503, null, hasBody = true, link = BrowserLink.NoNetwork))
        assertEquals(BrowserProblem.ComputerUnreachable, BrowserProblem.response(502, "browser_proxy_upstream_transport", hasBody = true, link = BrowserLink.Offline))
        assertEquals(BrowserProblem.Http(403), BrowserProblem.response(403, "browser_proxy_forbidden", hasBody = true, link = null))
    }

    @Test fun openingFailuresSayWhetherThereIsARoute() {
        assertEquals(BrowserProblem.Unavailable, BrowserProblem.opening(BrowserException(BrowserException.Kind.Unavailable), BrowserLink.Online))
        assertEquals(BrowserProblem.Unavailable, BrowserProblem.opening(AgentApiException(404, "not_found", "gone"), null))
        assertEquals(BrowserProblem.ComputerUnreachable, BrowserProblem.opening(IllegalStateException("no connection"), null))
        assertEquals(BrowserProblem.ComputerUnreachable, BrowserProblem.opening(BrowserException(BrowserException.Kind.Unavailable), BrowserLink.Offline))
        assertEquals(BrowserProblem.NoNetwork, BrowserProblem.opening(IllegalStateException(), BrowserLink.NoNetwork))
    }

    @Test fun refusalsSayWhatTheProxyMeant() {
        assertEquals(BrowserProblem.ComputerUnreachable, BrowserProxyRefusal(502, "browser_proxy_upstream_transport").problem)
        assertEquals(BrowserProblem.ComputerUnreachable, BrowserProxyRefusal(503, "browser_proxy_upstream_capacity").problem)
        assertEquals(BrowserProblem.ComputerUnreachable, BrowserProxyRefusal(502, "browser_proxy_socket_transport").problem)
        assertEquals(BrowserProblem.TimedOut, BrowserProxyRefusal(504, "browser_proxy_upstream_timeout").problem)
        assertEquals(BrowserProblem.ServerNotResponding, BrowserProxyRefusal(502, "browser_proxy_upstream_response_invalid").problem)
        assertEquals(BrowserProblem.ServerNotResponding, BrowserProxyRefusal(503, "browser_proxy_upstream_refused").problem)
        assertEquals(BrowserProblem.Unavailable, BrowserProxyRefusal(404, "browser_proxy_upstream_refused").problem)
        assertEquals(BrowserProblem.Unavailable, BrowserProxyRefusal(403, "browser_proxy_forbidden").problem)
    }

    @Test fun theLinkIsTheAgentsUnlessThePhoneHasNoNetwork() {
        assertEquals(BrowserLink.NoNetwork, BrowserLink.of(AgentLinkStatus.Offline, network = false))
        assertEquals(BrowserLink.NoNetwork, BrowserLink.of(null, network = false))
        // A connected computer is proof of a network the phone's own check missed.
        assertEquals(BrowserLink.Online, BrowserLink.of(AgentLinkStatus.Connected, network = false))
        assertEquals(BrowserLink.Online, BrowserLink.of(AgentLinkStatus.Connected, network = true))
        assertEquals(BrowserLink.Offline, BrowserLink.of(AgentLinkStatus.Offline, network = true))
        assertNull(BrowserLink.of(AgentLinkStatus.Connecting, network = true))
        assertNull(BrowserLink.of(null, network = true))
    }

    @Test fun inPageAddressesStayInThePage() {
        assertTrue(BrowserPolicy.isInPage("about:blank"))
        assertTrue(BrowserPolicy.isInPage("data:text/html,hi"))
        assertTrue(BrowserPolicy.isInPage("blob:https://example.com/1"))
        assertTrue(BrowserPolicy.isInPage("JavaScript:void(0)"))
        assertFalse(BrowserPolicy.isInPage("https://example.com/"))
        assertFalse(BrowserPolicy.isInPage("mailto:a@b.c"))
    }
}
