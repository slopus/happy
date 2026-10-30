package com.slopus.happy.fixture

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.pdf.PdfDocument
import androidx.test.platform.app.InstrumentationRegistry
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.conversation.AgentRequest
import kotlinx.serialization.json.JsonElement
import java.io.ByteArrayOutputStream
import java.util.Collections

/**
 * A paired agent that exists only in this test's memory. It answers the
 * conversation and artifact routes with made-up content, so the real
 * Conversation, ConversationApi and screens run on a device without a
 * computer, an account or anything of Steve's. Nothing it answers is real,
 * and nothing it is sent leaves the process: every request is recorded
 * here and nowhere else.
 */
class FixtureTransport {
    val requests: MutableList<String> = Collections.synchronizedList(ArrayList())

    /** The pending question `GET .../question` answers with, or none. */
    @Volatile var question: String? = null

    val png: ByteArray by lazy { picture() }
    val pdf: ByteArray by lazy { document() }
    val mp4: ByteArray by lazy {
        // The test APK's own assets: a synthetic 2 s testsrc clip, nobody's video.
        InstrumentationRegistry.getInstrumentation().context.assets.open("sample.mp4").use { it.readBytes() }
    }

    val request: AgentRequest = { method: String, path: String, _: JsonElement? ->
        requests += "$method $path"
        answer(method, path.substringBefore('?'))
    }

    private fun answer(method: String, route: String): TransportResponse = when {
        // The conversation only asks for a question the agent says is pending.
        route == "/v0/agents/$AGENT/bootstrap" -> json(bootstrap(if (question != null) "fx-q" else null))
        route == "/v0/agents/$AGENT/messages" -> json(PAGE)
        route == "/v0/agents/$AGENT/question" -> json("""{"question":${question ?: "null"}}""")
        route == "/v0/agents/$AGENT/tool-calls/c1/media/0" -> bytes(png)
        route == "/v0/agents/$AGENT/tool-calls/c1/media/1" -> bytes(mp4)
        route == "/v0/agents/$AGENT/tool-calls/c1/media/2" -> bytes(pdf)
        route == "/v0/config" -> json(CONFIG)
        route == "/v0/secrets" && method == "GET" -> json("""{"secrets":[]}""")
        route == "/v0/artifacts/fx-notes" -> json(artifact("fx-notes", "markdown", "Fixture notes"))
        route == "/v0/artifacts/fx-notes/versions/latest" -> json(version("Fixture notes", "index.md", "text/markdown", NOTES.size))
        route == "/v0/artifacts/fx-notes/versions/1/files/index.md" -> bytes(NOTES)
        route == "/v0/artifacts/fx-picture" -> json(artifact("fx-picture", "image", "Fixture picture"))
        route == "/v0/artifacts/fx-picture/versions/latest" -> json(version("Fixture picture", "sample.png", "image/png", png.size))
        route == "/v0/artifacts/fx-picture/versions/1/files/sample.png" -> bytes(png)
        route == "/v0/artifacts/fx-video" -> json(artifact("fx-video", "video", "Fixture video"))
        route == "/v0/artifacts/fx-video/versions/latest" -> json(version("Fixture video", "sample.mp4", "video/mp4", mp4.size))
        route == "/v0/artifacts/fx-video/versions/1/files/sample.mp4" -> bytes(mp4)
        route == "/v0/artifacts/fx-document" -> json(artifact("fx-document", "document", "Fixture document"))
        route == "/v0/artifacts/fx-document/versions/latest" -> json(version("Fixture document", "sample.pdf", "application/pdf", pdf.size))
        route == "/v0/artifacts/fx-document/versions/1/files/sample.pdf" -> bytes(pdf)
        // Draft saves, read marks and the like: accepted and forgotten.
        method != "GET" -> json("{}")
        else -> TransportResponse(404, body = """{"error":"not in the fixture","code":"not_found"}""".toByteArray())
    }

    private fun json(text: String) = TransportResponse(200, mapOf("content-type" to "application/json"), text.toByteArray())
    private fun bytes(body: ByteArray) = TransportResponse(200, body = body)

    private fun artifact(id: String, type: String, title: String) =
        """{"artifact":{"id":"$id","type":"$type","title":"$title","status":"active","deletedAt":null}}"""

    private fun version(title: String, path: String, mimeType: String, size: Int) =
        """{"version":{"number":1,"title":"$title","live":null,"entry":{"path":"$path"},"files":[{"path":"$path","mimeType":"$mimeType","size":$size}]}}"""

    companion object {
        const val AGENT = "fx-agent"

        private const val MODE = """{"providerId":"fx","modelId":"fx/model","effort":"medium","serviceTier":null,"permissionMode":"read_only"}"""

        private fun bootstrap(pendingQuestionId: String?) =
            """{"agent":{"id":"$AGENT","workspaceId":"fx-workspace","status":"idle","title":"Fixture chat","pendingQuestionId":${pendingQuestionId?.let { "\"$it\"" } ?: "null"}},"mode":$MODE,"draft":{"value":null,"updatedAt":null},"pending":[]}"""

        private const val CONFIG = """{"config":{
            "defaults":{"providerId":"fx","modelId":"fx/model","permissionMode":"read_only"},
            "models":{"fx/model":{"name":"Fixture model","efforts":["medium"],"defaultEffort":"medium","serviceTiers":[]}},
            "providers":{"fx":{"name":"Fixture","type":"fixture","models":[{"id":"fx/model"}]}}
        }}"""

        private fun card(id: String, artifactId: String, type: String, title: String) =
            """{"type":"tool_call","id":"$id","name":"create_artifact","status":"completed","presentation":{"type":"artifact","artifactId":"$artifactId","artifactType":"$type","title":"$title","version":1}}"""

        private val PAGE = """{"hasMore":false,"runs":[{"id":"r1","status":"completed","startedAt":1,"messages":[
            {"id":"m1","role":"user","createdAt":1,"content":[{"type":"text","text":"Show me the samples."}],"metadata":{}},
            {"id":"m2","role":"agent","createdAt":2,"content":[
                {"type":"text","text":"Here they are. Every one of these is a test fixture."},
                {"type":"tool_call","id":"c1","name":"present_files","status":"completed","presentation":{"type":"media","items":[
                    {"kind":"image","name":"sample.png","mimeType":"image/png","width":640,"height":400},
                    {"kind":"video","name":"sample.mp4","mimeType":"video/mp4","width":320,"height":240},
                    {"kind":"file","name":"sample.pdf","mimeType":"application/pdf"}
                ]}},
                ${card("c2", "fx-notes", "markdown", "Fixture notes")},
                ${card("c3", "fx-picture", "image", "Fixture picture")},
                ${card("c4", "fx-video", "video", "Fixture video")},
                ${card("c5", "fx-document", "document", "Fixture document")}
            ],"metadata":{}}
        ]}]}"""

        private val NOTES = """
            # Fixture notes

            A **test fixture**, not anyone's artifact. It has a [link](https://example.com), a list:

            - one
            - two

            and code:

            ```
            val fixture = true
            ```
        """.trimIndent().toByteArray()

        /** A secret request with two synthetic variables; nothing is ever saved from it. */
        const val SECRET_QUESTION = """{"id":"fx-q","status":"pending","context":"The fixture needs a token.","questions":[{"id":"secret","header":"Secret","question":"Fixture token","multiSelect":false,"options":[],"secretRequest":{"suggestedId":"fixture-api","description":"Fixture credentials","environmentVariables":[{"name":"FIXTURE_TOKEN","description":"A made-up token"},{"name":"FIXTURE_ORGANIZATION","description":null}]}}]}"""

        private fun picture(): ByteArray {
            val bitmap = Bitmap.createBitmap(640, 400, Bitmap.Config.ARGB_8888)
            Canvas(bitmap).apply {
                drawColor(Color.rgb(32, 96, 160))
                drawText("FIXTURE", 220f, 210f, Paint().apply { color = Color.WHITE; textSize = 56f; isAntiAlias = true })
            }
            return ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
        }

        private fun document(): ByteArray {
            val pdf = PdfDocument()
            val page = pdf.startPage(PdfDocument.PageInfo.Builder(595, 842, 1).create())
            page.canvas.drawText("Fixture document - synthetic test content.", 72f, 120f, Paint().apply { textSize = 18f })
            pdf.finishPage(page)
            return ByteArrayOutputStream().also { pdf.writeTo(it); pdf.close() }.toByteArray()
        }
    }
}
