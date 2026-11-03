package com.slopus.happy.agent

import com.slopus.happy.chat.str
import com.slopus.happy.connection.AgentConnectionException
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.conversation.AgentRequest
import com.slopus.happy.conversation.ConversationApi
import com.slopus.happy.conversation.ConversationApiException
import com.slopus.happy.sync.BashResult
import com.slopus.happy.sync.GitFile
import com.slopus.happy.sync.GitFileContent
import com.slopus.happy.sync.GitState
import com.slopus.happy.sync.HappyAgentGit
import com.slopus.happy.sync.ReadFileResult
import com.slopus.happy.ui.files.SessionFileOps
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers

/** The workspace has no repository (`GET …/git` answered 404). */
class WorkspaceNotRepository : Exception()

/**
 * A Happy Agent workspace's changes over its agent connection (API.md
 * "Git" and "Files"): the git state, and a changed file's two sides, the
 * base's from `file-revision` and the working tree's from `file`, compared
 * by the same rules as session Git ([HappyAgentGit.compare]). It answers
 * the changes screen as session Git does; there is no shell here.
 */
class WorkspaceGit(
    private val request: AgentRequest,
    private val workspaceId: String,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) : SessionFileOps {
    private val root = "/v0/workspaces/${ConversationApi.escape(workspaceId)}"

    override suspend fun gitState(sessionId: String): GitState {
        val response = request("GET", "$root/git", null, RequestCategory.Query)
        if (response.status == 404) throw WorkspaceNotRepository()
        return HappyAgentGit.parseState(ConversationApi.decode(response)["git"], workspace = true)
            ?: throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
    }

    override suspend fun readGitFile(sessionId: String, base: String, file: GitFile): GitFileContent =
        HappyAgentGit.compare(file, io) { path, atBase ->
            val query = "path=${ConversationApi.escape(path)}" + if (atBase) "&revision=${ConversationApi.escape(base)}" else ""
            val answer = ConversationApi.decode(request("GET", "$root/${if (atBase) "file-revision" else "file"}?$query", null, RequestCategory.File))
            answer["content"].str ?: throw ConversationApiException(200, null, null)
        }

    override suspend fun bash(sessionId: String, command: String, cwd: String?, timeoutMs: Long): BashResult = throw UnsupportedOperationException()

    override suspend fun readFile(sessionId: String, path: String): ReadFileResult = throw UnsupportedOperationException()
}
