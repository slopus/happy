package com.slopus.happy.ui.files

import com.slopus.happy.R
import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.WorkspaceFiles
import com.slopus.happy.text.Words
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** A workspace folder's listing: folders first by name, paged, a failure said with Retry. */
@OptIn(ExperimentalCoroutinesApi::class)
class WorkspaceFolderTest {
    private fun file(name: String) = WorkspaceFiles.Entry(name, "d/$name", directory = false, size = 1)
    private fun dir(name: String) = WorkspaceFiles.Entry(name, "d/$name", directory = true, size = 0)

    @Test
    fun foldersComeFirstThenFilesByNameIgnoringCase() = runTest(StandardTestDispatcher()) {
        val folder = WorkspaceFolder(this as TestScope, { _, _ -> WorkspaceFiles.Page(listOf(file("b.txt"), dir("src"), file("A.md"), dir("Docs")), null) }, "d")
        assertTrue(folder.state.value.loading)
        folder.open()
        advanceUntilIdle()
        assertEquals(listOf("Docs", "src", "A.md", "b.txt"), folder.state.value.entries.map { it.name })
        assertFalse(folder.state.value.loading)
    }

    @Test
    fun theNextPageIsAskedOnceAndJoinsInOrder() = runTest(StandardTestDispatcher()) {
        val asked = ArrayList<String?>()
        val folder = WorkspaceFolder(this as TestScope, { _, cursor ->
            asked += cursor
            if (cursor == null) WorkspaceFiles.Page(listOf(file("b.txt")), "c2") else WorkspaceFiles.Page(listOf(dir("z"), file("a.txt")), null)
        }, "d")
        folder.open()
        advanceUntilIdle()
        folder.more()
        folder.more()
        advanceUntilIdle()
        assertEquals(listOf(null, "c2"), asked)
        assertEquals(listOf("z", "a.txt", "b.txt"), folder.state.value.entries.map { it.name })
        folder.more()
        advanceUntilIdle()
        assertEquals(2, asked.size)
    }

    @Test
    fun aFailureSaysWhyAndRetryReadsAgain() = runTest(StandardTestDispatcher()) {
        var fail = true
        val folder = WorkspaceFolder(this as TestScope, { _, _ ->
            if (fail) throw AgentApiException(404, "not_found", "gone")
            WorkspaceFiles.Page(emptyList(), null)
        }, "d")
        folder.open()
        advanceUntilIdle()
        assertEquals(Words.ours(R.string.workspace_not_found), folder.state.value.error)
        fail = false
        folder.open()
        advanceUntilIdle()
        assertTrue(folder.state.value.empty)
    }
}
