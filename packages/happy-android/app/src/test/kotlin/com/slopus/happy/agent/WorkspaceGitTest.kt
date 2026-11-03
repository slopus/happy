package com.slopus.happy.agent

import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.conversation.AgentRequest
import com.slopus.happy.sync.GitFile
import com.slopus.happy.sync.GitFileContent
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

/**
 * A workspace's changes over the agent connection (API.md "Git", "Files"):
 * the state as the workspace API sends it, unset strings left out and the
 * base any commit-ish; a file's base side from `file-revision` and its
 * working side from `file`; and a workspace without a repository.
 */
class WorkspaceGitTest {
    private val requests = ArrayList<String>()
    private var gitStatus = 200

    private val state = """{"git":{
        "facts":{"branch":"main","detached":false,"ahead":0,"behind":0},
        "comparison":"ready","base":"origin/main",
        "changedFiles":2,"insertions":3,"deletions":1,"countsExact":true,"conflicted":false,
        "files":[
          {"path":"src/a.ts","status":"modified","staged":false,"unstaged":true,"binary":false,"insertions":2,"deletions":1},
          {"path":"src/new.ts","status":"untracked","staged":false,"unstaged":true,"binary":false,"insertions":1,"deletions":0}
        ],
        "filesTruncated":false,"scannedAt":1755400000000}}"""

    private fun b64(text: String) = Base64.getEncoder().encodeToString(text.toByteArray())

    private val request: AgentRequest = { method, path, _, _ ->
        requests += "$method $path"
        val body = when {
            path.endsWith("/git") -> if (gitStatus == 404) """{"error":"No repository.","code":"not_found"}""" else state
            path.contains("/file-revision?") -> """{"content":"${b64("one\ntwo\n")}"}"""
            path.contains("/file?") && path.contains("new.ts") -> """{"content":"${b64("fresh\n")}","hash":"${"b".repeat(64)}"}"""
            path.contains("/file?") -> """{"content":"${b64("one\nthree\n")}","hash":"${"b".repeat(64)}"}"""
            else -> "{}"
        }
        TransportResponse(if (path.endsWith("/git")) gitStatus else 200, body = body.toByteArray())
    }

    private val git = WorkspaceGit(request, "w 1", Dispatchers.Unconfined)

    @Test fun `the workspace's state reads with unset strings left out and a named base`() = runBlocking {
        val read = git.gitState("ignored")
        assertEquals("origin/main", read.base)
        assertNull(read.facts.head)
        assertNull(read.facts.upstream)
        assertEquals(listOf("src/a.ts", "src/new.ts"), read.files.map { it.path })
        assertEquals("GET /v0/workspaces/w%201/git", requests.single())
    }

    @Test fun `a changed file reads its base side at the base and its working side from the tree`() = runBlocking {
        val read = git.gitState("ignored")
        val content = git.readGitFile("ignored", read.base!!, read.files[0])
        assertEquals(GitFileContent.Text("one\ntwo\n", "one\nthree\n"), content)
        assertTrue(requests.any { it == "GET /v0/workspaces/w%201/file-revision?path=src%2Fa.ts&revision=origin%2Fmain" })
        assertTrue(requests.any { it == "GET /v0/workspaces/w%201/file?path=src%2Fa.ts" })
    }

    @Test fun `an untracked file has no base side to read`() = runBlocking {
        val content = git.readGitFile("ignored", "origin/main", GitFile("src/new.ts", status = "untracked", staged = false, unstaged = true, binary = false))
        assertEquals(GitFileContent.Text("", "fresh\n"), content)
        assertTrue(requests.none { "file-revision" in it })
    }

    @Test(expected = WorkspaceNotRepository::class)
    fun `a workspace without a repository says so`(): Unit = runBlocking {
        gitStatus = 404
        git.gitState("ignored")
    }
}
