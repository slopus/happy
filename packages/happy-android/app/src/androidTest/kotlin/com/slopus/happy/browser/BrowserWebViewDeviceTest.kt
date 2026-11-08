package com.slopus.happy.browser

import android.annotation.SuppressLint
import android.webkit.HttpAuthHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import androidx.activity.ComponentActivity
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.connection.AgentConnectionException
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.connection.TransportSocket
import com.slopus.happy.ui.browser.BrowserPage
import com.slopus.happy.ui.browser.WebViewProfiles
import com.slopus.happy.ui.browser.WebViewProxyOverride
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread

/**
 * The in-app browser on a real WebView (iOS's HostedBrowserTests): pages
 * load only through [BrowserProxy] via ProxyController's override, against
 * a byte-level fake daemon in this process standing in for the agent's
 * Tailcat socket. Two artifact pages open at once, each WebView in a profile
 * of its own answering the 407 with its page's credential: both load their
 * own files and API, which only works if each profile kept its own proxy
 * credential. A public http page is reached through the workspace CONNECT,
 * never resolved on the phone.
 */
@RunWith(AndroidJUnit4::class)
class BrowserWebViewDeviceTest {
    /** Answers artifact files and API for any id, and workspace CONNECTs to one fake public site. */
    private class Daemon {
        val server = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
        val heads = CopyOnWriteArrayList<String>()

        init {
            thread(isDaemon = true) {
                while (true) {
                    val socket = runCatching { server.accept() }.getOrNull() ?: return@thread
                    thread(isDaemon = true) { runCatching { serve(socket) }; runCatching { socket.close() } }
                }
            }
        }

        private fun serve(socket: Socket) {
            val input = socket.getInputStream()
            val output = socket.getOutputStream()
            while (true) {
                val head = StringBuilder()
                while (!head.endsWith("\r\n\r\n")) {
                    val byte = input.read()
                    if (byte < 0) return
                    head.append(byte.toChar())
                }
                val text = head.toString()
                heads += text
                val length = Regex("(?i)content-length: (\\d+)").find(text)?.groupValues?.get(1)?.toInt() ?: 0
                val body = ByteArray(length).also { var read = 0; while (read < length) read += input.read(it, read, length - read) }
                val (method, target) = text.substringBefore("\r\n").split(' ').let { it[0] to it[1] }
                fun answer(type: String, content: String) {
                    val bytes = content.toByteArray()
                    output.write("HTTP/1.1 200 OK\r\nContent-Type: $type\r\nContent-Length: ${bytes.size}\r\n\r\n".toByteArray() + bytes)
                    output.flush()
                }
                val file = Regex("^/v0/artifacts/([a-z0-9]+)/versions/1/files/index.html$").find(target)
                val api = Regex("^/v0/artifacts/([a-z0-9]+)/api/echo$").find(target)
                when {
                    method == "CONNECT" -> output.write("HTTP/1.1 200 Connection Established\r\n\r\n".toByteArray()).also { output.flush() }
                    file != null -> answer(
                        "text/html",
                        "<html><head><title>loading</title></head><body><script>" +
                            "fetch('/api/echo',{method:'POST',body:'one'}).then(r=>r.text()).then(t=>{document.title='${file.groupValues[1]}:'+t})" +
                            ".catch(e=>{document.title='failed'})</script></body></html>",
                    )
                    api != null -> answer("text/plain", "echo:" + body.decodeToString())
                    target == "/" && text.contains("Host: localhost:3000") -> {
                        answer("text/html", "<html><head><title>remote page</title></head><body>hi</body></html>")
                        return
                    }
                    else -> output.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".toByteArray()).also { output.flush() }
                }
            }
        }

        fun close() = server.close()
    }

    private class Sockets(val port: Int) : Transport {
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse =
            throw AgentConnectionException(AgentConnectionException.Reason.Unavailable)

        override suspend fun socket(): TransportSocket = LocalSocket(Socket(InetAddress.getLoopbackAddress(), port))
        override suspend fun close() {}
    }

    private lateinit var daemon: Daemon
    private lateinit var scope: CoroutineScope
    private lateinit var proxy: BrowserProxy
    private lateinit var client: AgentClient
    private lateinit var activity: ActivityScenario<ComponentActivity>
    private val titles = ConcurrentHashMap<String, String>()
    private val errors = ConcurrentHashMap<String, String>()

    @Before fun setUp() {
        daemon = Daemon()
        scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        proxy = BrowserProxy(scope)
        client = AgentClient(Sockets(daemon.server.localPort), "device-token")
        activity = ActivityScenario.launch(ComponentActivity::class.java)
        activity.onActivity { it.setContentView(LinearLayout(it).apply { orientation = LinearLayout.VERTICAL }) }
    }

    @After fun tearDown() {
        runBlocking(Dispatchers.Main) { WebViewProxyOverride.release() }
        activity.close()
        proxy.shutdown()
        scope.cancel()
        daemon.close()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun show(name: String, page: BrowserPage, session: BrowserProxy.Page) {
        activity.onActivity { host ->
            val web = WebView(host)
            if (session.isolated) WebViewProfiles.assign(web)
            web.settings.javaScriptEnabled = true
            web.webChromeClient = object : WebChromeClient() {
                override fun onReceivedTitle(view: WebView, title: String?) {
                    if (title != null) titles[name] = title
                }
            }
            web.webViewClient = object : WebViewClient() {
                override fun onReceivedHttpAuthRequest(view: WebView, handler: HttpAuthHandler, host: String?, realm: String?) {
                    if (session.isolated) handler.proceed(session.username, session.password) else handler.proceed(proxy.webUsername, proxy.webPassword)
                }

                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                    if (request.isForMainFrame) errors[name] = "${error.errorCode} ${error.description}"
                }
            }
            (host.findViewById<android.view.ViewGroup>(android.R.id.content).getChildAt(0) as LinearLayout).addView(web, LinearLayout.LayoutParams(-1, 600))
            web.loadUrl(page.url)
        }
    }

    private fun await(name: String, expected: String) {
        val deadline = System.currentTimeMillis() + 30_000
        while (titles[name] != expected && errors[name] == null && System.currentTimeMillis() < deadline) Thread.sleep(100)
        assertEquals("$name (error: ${errors[name]})", expected, titles[name])
    }

    @Test fun twoArtifactPagesInTheirOwnProfilesLoadTheirOwnFilesAndApi() {
        assumeTrue("WebView has profiles", WebViewProfiles.supported)
        val pages = listOf("aone", "atwo").map { id ->
            val page = BrowserPage.artifact({ authority -> BrowserProxy.Scope.Artifact(client, id, 1, authority, network = null) }, id, "index.html")
            id to (page to proxy.open(page.scope, isolated = true))
        }
        assertTrue(runBlocking(Dispatchers.Main) { WebViewProxyOverride.acquire(proxy.port) })
        for ((id, opened) in pages) show(id, opened.first, opened.second)
        await("aone", "aone:echo:one")
        await("atwo", "atwo:echo:one")
        // Each page's requests reached only its own artifact.
        assertTrue(daemon.heads.any { it.startsWith("POST /v0/artifacts/aone/api/echo ") })
        assertTrue(daemon.heads.any { it.startsWith("POST /v0/artifacts/atwo/api/echo ") })
        assertTrue(daemon.heads.all { it.contains("Authorization: Bearer device-token") || it.startsWith("CONNECT ") })
        pages.forEach { it.second.second.close() }
    }

    /** The computer's dev server, at the address the agent gave: localhost there, never the phone's. */
    @Test fun localhostIsTheComputersReachedThroughTheWorkspace() {
        val page = BrowserPage("http://localhost:3000/", BrowserProxy.Scope.Web(client) { BrowserNetwork.workspace("wsone") })
        val session = proxy.open(page.scope, isolated = WebViewProfiles.supported)
        assertTrue(runBlocking(Dispatchers.Main) { WebViewProxyOverride.acquire(proxy.port) })
        show("public", page, session)
        await("public", "remote page")
        val connects = daemon.heads.filter { it.startsWith("CONNECT ") }.map { it.substringBefore("\r\n") }
        assertEquals(listOf("CONNECT /v0/workspaces/wsone/proxy HTTP/1.1", "CONNECT localhost:3000 HTTP/1.1"), connects.take(2))
        assertTrue(daemon.heads.first().contains("Authorization: Bearer device-token"))
        assertFalse(daemon.heads.first { it.startsWith("CONNECT localhost") }.contains("Authorization"))
        session.close()
    }

    /**
     * Android limit: plain http outside network_security_config's list is
     * refused by WebView before any proxy sees it (iOS allows it in web
     * content). Nothing reaches the computer, and nothing the phone's network.
     */
    @Test fun plainHttpElsewhereIsRefusedBeforeTheProxy() {
        val page = BrowserPage("http://public.example.com/", BrowserProxy.Scope.Web(client) { BrowserNetwork.workspace("wsone") })
        val session = proxy.open(page.scope, isolated = WebViewProfiles.supported)
        assertTrue(runBlocking(Dispatchers.Main) { WebViewProxyOverride.acquire(proxy.port) })
        show("public", page, session)
        val deadline = System.currentTimeMillis() + 30_000
        while (errors["public"] == null && System.currentTimeMillis() < deadline) Thread.sleep(100)
        assertTrue(errors["public"].orEmpty(), errors["public"].orEmpty().contains("CLEARTEXT"))
        assertTrue(daemon.heads.isEmpty())
        session.close()
    }
}
