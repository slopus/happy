package com.slopus.happy.ui.connection

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.navigation.compose.rememberNavController
import androidx.navigation.toRoute
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.ComputeRole
import com.slopus.happy.agent.decode
import com.slopus.happy.agent.ComputeSource
import com.slopus.happy.agent.ServerPermissions
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import com.slopus.happy.connection.HttpResponseParser
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.TailcatHttp
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.ui.RetainedNavHost
import com.slopus.happy.ui.backdrop
import com.slopus.happy.ui.page
import com.slopus.happy.ui.rememberNavMotion
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI

/**
 * Debug builds only: Settings › Compute and a computer's page over a live
 * Happy Cloud API at a plain-HTTP test address, with a bearer token given
 * in the intent, for checking the computers contract on an emulator:
 * `adb shell am start -n com.slopus.happy.dev/com.slopus.happy.ui.connection.ComputeLiveActivity
 * --es url http://host:port --es token <jwt> [--es computer <id>]`.
 * The reader and their role come from `/v0/profile` and `/v0/permissions`,
 * as on a signed-in connection. The plain socket here is this fixture's
 * alone; the app's transports stay TLS-only.
 */
class ComputeLiveActivity : ComponentActivity() {
    @Serializable private data object LiveListRoute
    @Serializable private data class LiveComputerRoute(val id: String)

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val url = URI(requireNotNull(intent.getStringExtra("url")))
        val token = requireNotNull(intent.getStringExtra("token"))
        val start = intent.getStringExtra("computer")
        val client = AgentClient(PlainHttpTransport(url.host, url.port), token, cloud = true)
        setContent {
            HappyTheme {
                val reader by produceState<Pair<String?, ComputeRole>?>(null) {
                    val profile = client.decode<JsonObject>("GET", "/v0/profile")["profile"].obj
                    val granted = client.decode<JsonObject>("GET", "/v0/permissions")["granted"].arr.orEmpty().mapNotNull { it.str }.toSet()
                    value = profile?.get("userId").str to ComputeRole.of(true, ServerPermissions(true, granted))
                }
                val (readerId, role) = reader ?: return@HappyTheme
                val source = remember(readerId) {
                    ComputeSource(client, readerId) { ids ->
                        client.decode<JsonObject>("GET", "/v0/members")["members"].arr.orEmpty().mapNotNull { it.obj }
                            .mapNotNull { m -> m["userId"].str?.takeIf { it in ids }?.let { id -> m["name"].str?.let { id to it } } }.toMap()
                    }
                }
                LaunchedEffect(source) { source.observe(MutableSharedFlow()) }
                val nav = rememberNavController()
                val first = remember { mutableStateOf(start) }
                RetainedNavHost(nav, LiveListRoute, rememberNavMotion(), modifier = Modifier.backdrop(nav)) {
                    page<LiveListRoute> {
                        LaunchedEffect(Unit) { first.value?.let { first.value = null; nav.navigate(LiveComputerRoute(it)) } }
                        ComputePage(role, source, onOpen = { nav.navigate(LiveComputerRoute(it.id)) }, onBack = ::finish)
                    }
                    page<LiveComputerRoute> { entry ->
                        ComputerPage(role, source, entry.toRoute<LiveComputerRoute>().id) { nav.popBackStack() }
                    }
                }
            }
        }
    }
}

/** HTTP/1.1 in clear over one socket per request; this fixture's test servers only. */
private class PlainHttpTransport(private val host: String, private val port: Int) : Transport {
    override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse =
        withContext(Dispatchers.IO) {
            Socket().use { socket ->
                socket.connect(InetSocketAddress(host, port), 10_000)
                socket.soTimeout = 30_000
                val out = socket.getOutputStream()
                out.write(TailcatHttp.requestHead(method, path, port, credential, body, headers, "$host:$port"))
                body?.let(out::write)
                out.flush()
                val input = socket.getInputStream()
                val parser = HttpResponseParser()
                val buffer = ByteArray(65536)
                var response: TransportResponse? = null
                while (response == null) {
                    val read = input.read(buffer)
                    response = parser.append(if (read > 0) buffer.copyOf(read) else ByteArray(0), eof = read < 0)
                }
                response
            }
        }

    override suspend fun close() {}
}
