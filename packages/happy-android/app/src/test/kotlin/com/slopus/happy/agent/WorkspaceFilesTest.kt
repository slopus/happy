package com.slopus.happy.agent

import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.util.Base64

/** A workspace's folder through the agent API (API.md "Files"; desktop's happyAgentClient.ts). */
class WorkspaceFilesTest {
    private class Routes(val answer: (path: String) -> TransportResponse) : Transport {
        val asked = mutableListOf<Pair<String, RequestCategory>>()
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
            asked += path to category
            return answer(path)
        }

        override suspend fun close() {}
    }

    private fun json(status: Int, text: String) = TransportResponse(status, mapOf("content-type" to "application/json"), text.toByteArray())
    private fun b64(text: String) = Base64.getEncoder().encodeToString(text.toByteArray())

    @Test fun aFolderLeavesOutGitAndOtherEntriesAndPagesOn() = runBlocking {
        val routes = Routes {
            json(200, """{"entries":[
                {"name":".git","path":".git","type":"directory","size":0,"modified":1},
                {"name":"src","path":"src","type":"directory","size":0,"modified":1},
                {"name":"fifo","path":"fifo","type":"other","size":0,"modified":1},
                {"name":"link","path":"link","type":"symlink","size":12,"modified":1},
                {"name":"README.md","path":"README.md","type":"file","size":2048,"modified":1}],"nextCursor":"c2"}""")
        }
        val page = WorkspaceFiles(AgentClient(routes, "t")).tree("w", "docs/a b", "c1")
        assertEquals(
            listOf(
                WorkspaceFiles.Entry("src", "src", directory = true, size = 0),
                WorkspaceFiles.Entry("link", "link", directory = false, size = 12),
                WorkspaceFiles.Entry("README.md", "README.md", directory = false, size = 2048),
            ),
            page.entries,
        )
        assertEquals("c2", page.nextCursor)
        assertEquals("/v0/workspaces/w/file-tree?path=docs%2Fa%20b&cursor=c1&limit=500", routes.asked.single().first)
    }

    @Test fun theRootAsksWithoutAPathAndTheLastPageHasNoCursor() = runBlocking {
        val routes = Routes { json(200, """{"entries":[],"nextCursor":null}""") }
        val page = WorkspaceFiles(AgentClient(routes, "t")).tree("w", "")
        assertNull(page.nextCursor)
        assertEquals("/v0/workspaces/w/file-tree?limit=500", routes.asked.single().first)
    }

    @Test fun aFileIsItsBytesAndPastTheLimitItIsTooLarge() = runBlocking {
        val bytes = byteArrayOf(0, 1, 2, -1)
        val ok = Routes { json(200, """{"content":"${Base64.getEncoder().encodeToString(bytes)}","hash":"h1"}""") }
        val file = WorkspaceFiles(AgentClient(ok, "t")).read("w", "bin/x")
        assertArrayEquals(bytes, file.bytes)
        assertEquals("h1", file.hash)
        assertEquals(RequestCategory.File, ok.asked.single().second)
        val big = Routes { json(413, """{"error":"too large"}""") }
        val failure = runCatching { WorkspaceFiles(AgentClient(big, "t")).read("w", "big.bin") }.exceptionOrNull()
        assertEquals(WorkspaceFiles.TooLarge::class, failure!!::class)
    }
}
