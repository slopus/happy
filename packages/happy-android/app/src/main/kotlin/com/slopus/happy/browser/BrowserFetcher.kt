package com.slopus.happy.browser

import com.slopus.happy.agent.AgentClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runInterruptible
import okhttp3.OkHttpClient
import okhttp3.Request
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URI
import java.util.concurrent.TimeUnit

/** The app's one browser proxy (see [BrowserProxy]); started when a page or fetcher first opens. */
object Browser {
    val proxy: BrowserProxy by lazy { BrowserProxy(CoroutineScope(SupervisorJob() + Dispatchers.IO)) }
}

/**
 * iOS's `BrowserFetcher`: single resources (a document's pictures) fetched as
 * the in-app browser reaches the web, through the computer's [BrowserNetwork],
 * never the phone's network, with no fallback. `https` goes through the
 * loopback [BrowserProxy] as OkHttp's CONNECT proxy, so TLS stays end to
 * end; plain `http` is one GET over a CONNECT tunnel. Nothing is sent with a
 * request but the request: no cookies, no cache.
 */
class BrowserFetcher(
    private val client: AgentClient,
    network: suspend () -> BrowserNetwork,
    private val proxy: BrowserProxy = Browser.proxy,
) {
    private val page = proxy.open(BrowserProxy.Scope.Web(client, network), webView = false)
    private val lazyHttp = lazy {
        OkHttpClient.Builder()
            .proxy(Proxy(Proxy.Type.HTTP, InetSocketAddress(BrowserProxy.LOOPBACK, proxy.port)))
            .proxyAuthenticator { _, response ->
                // Answers the loopback proxy alone, once.
                if (response.request.header("Proxy-Authorization") != null) null
                else response.request.newBuilder().header("Proxy-Authorization", page.authorization).build()
            }
            .followRedirects(true)
            .followSslRedirects(false)
            .cache(null)
            .callTimeout(35, TimeUnit.SECONDS)
            .build()
    }
    private val http: OkHttpClient by lazyHttp

    suspend fun data(url: String): ByteArray = data(url, REDIRECTS)

    private suspend fun data(url: String, redirects: Int): ByteArray {
        val uri = runCatching { URI(url) }.getOrNull() ?: throw BrowserException(BrowserException.Kind.Malformed)
        return when (uri.scheme?.lowercase()) {
            "https" -> secure(url)
            "http" -> plain(uri, redirects)
            else -> throw BrowserException(BrowserException.Kind.Forbidden)
        }
    }

    private suspend fun secure(url: String): ByteArray = runInterruptible(Dispatchers.IO) {
        http.newCall(Request.Builder().url(url).header("Accept", "image/*,*/*;q=0.8").build()).execute().use { response ->
            if (!response.isSuccessful) throw BrowserException(BrowserException.Kind.Upstream, response.code)
            val body = response.body
            if (body.contentLength() > LIMIT) throw BrowserException(BrowserException.Kind.TooLarge)
            val out = java.io.ByteArrayOutputStream()
            val buffer = ByteArray(65536)
            body.byteStream().use { input ->
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    out.write(buffer, 0, count)
                    if (out.size() > LIMIT) throw BrowserException(BrowserException.Kind.TooLarge)
                }
            }
            out.toByteArray()
        }
    }

    private suspend fun plain(uri: URI, redirects: Int): ByteArray {
        val authority = BrowserPolicy.Authority.of(uri.toString()) ?: throw BrowserException(BrowserException.Kind.Malformed)
        val target = (uri.rawPath?.takeIf { it.isNotEmpty() } ?: "/") + (uri.rawQuery?.let { "?$it" } ?: "")
        // The address's own authority, as a browser sends it; credentials in it were refused above.
        val hostField = uri.rawAuthority ?: throw BrowserException(BrowserException.Kind.Malformed)
        if ((target + hostField).any { it.code < 33 || it.code == 127 }) throw BrowserException(BrowserException.Kind.Malformed)
        val stream = BrowserTunnel.open(client, page.network(), authority)
        val (head, body, status) = try {
            stream.write("GET $target HTTP/1.1\r\nHost: $hostField\r\nAccept: image/*,*/*;q=0.8\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n".toByteArray())
            BrowserRelay.response(stream, LIMIT)
        } finally {
            stream.close()
        }
        if (status in setOf(301, 302, 303, 307, 308)) {
            val location = head.value("location")
            if (redirects <= 0 || location == null) throw BrowserException(BrowserException.Kind.Upstream, status)
            return data(uri.resolve(location).toString(), redirects - 1)
        }
        if (status !in 200..299) throw BrowserException(BrowserException.Kind.Upstream, status)
        return body
    }

    /** Lets go of the proxy page and its connections. */
    fun close() {
        page.close()
        if (lazyHttp.isInitialized()) http.connectionPool.evictAll()
    }

    companion object {
        /** The largest body read; past it the fetch fails. */
        const val LIMIT = 32 * 1024 * 1024
        private const val REDIRECTS = 5
    }
}
