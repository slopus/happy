package com.slopus.happy.conversation

import com.slopus.happy.connection.TransportResponse
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** API.md's artifact/version objects: entry is a file, files are ordered by path. */
class ArtifactTest {
    private fun obj(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject
    private val metadata = obj("""{"id":"report","type":"markdown","status":"active","deletedAt":null}""")
    private val manifest = obj("""{
        "artifactId":"report","number":2,"title":"Report",
        "entry":{"path":"report.md","mimeType":"text/markdown","size":10},
        "files":[
            {"path":"images/chart.png","mimeType":"image/png","size":4},
            {"path":"report.md","mimeType":"text/markdown","size":10}
        ],"live":null
    }""")

    @Test fun `the declared entry is read even when another file sorts first`() {
        val artifact = Artifact.parse(metadata, manifest)!!
        assertEquals("report.md", artifact.entryFile!!.path)
        assertEquals(2, artifact.version)
        assertFalse(artifact.deleted)
    }

    @Test fun `a malformed or missing entry cannot silently select another file`() {
        for (entry in listOf("null", "\"report.md\"", "{}", "{\"path\":\"absent.md\"}")) {
            val altered = JsonObject(manifest + ("entry" to Json.parseToJsonElement(entry)))
            assertNull("entry=$entry", Artifact.parse(metadata, altered))
        }
    }

    @Test fun `a live version does not need a file entry`() {
        val live = obj("""{"number":3,"entry":null,"files":[],"live":{"url":"https://example.com"}}""")
        assertTrue(Artifact.parse(metadata, live)!!.view() is ArtifactView.NotHere)
    }

    @Test fun `deletion is recognized before asking for inaccessible versions`() = runTest {
        for (deletion in listOf("\"status\":\"deleted\",\"deletedAt\":1755400000000", "\"deletedAt\":1755400000000")) {
            val paths = mutableListOf<String>()
            val api = ConversationApi { _, path, _ ->
                paths += path
                TransportResponse(200, body = """{"artifact":{"id":"report","type":"markdown",$deletion}}""".toByteArray())
            }
            assertTrue(api.readArtifact("report")!!.deleted)
            assertEquals(listOf("/v0/artifacts/report"), paths)
        }
    }

    @Test fun `file reads encode every nested path segment and preserve the response bytes`() = runTest {
        val paths = mutableListOf<String>()
        val bytes = byteArrayOf(0, 1, -1)
        val api = ConversationApi { method, path, body ->
            assertEquals("GET", method)
            assertNull(body)
            paths += path
            TransportResponse(200, body = bytes)
        }
        assertTrue(bytes.contentEquals(api.artifactFile("report #1", "2", "images/plot #1+é.png")))
        assertEquals(listOf("/v0/artifacts/report%20%231/versions/2/files/images/plot%20%231%2B%C3%A9.png"), paths)
    }
}