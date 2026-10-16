package com.slopus.happy.ui.home

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.data.HappyDatabase
import com.slopus.happy.data.HappyStore
import com.slopus.happy.data.SessionRecord
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

/** FlatSessionRow's draft glyph: each session carries its composer draft (storage.ts `hasDraft: !!session.draft`). */
@RunWith(AndroidJUnit4::class)
class SessionDraftRowsTest {
    @Test
    fun snapshotsCarryEachSessionsDraft() = runBlocking {
        val store = HappyStore(HappyDatabase(ApplicationProvider.getApplicationContext(), name = null))
        store.upsertSessions(
            listOf("s1", "s2").map { id ->
                SessionRecord(
                    id = id, seq = 1, createdAt = 1, updatedAt = 1, active = true, activeAt = 1,
                    metadataJson = """{"path":"/repo","host":"h"}""", metadataVersion = 1,
                    agentStateJson = null, agentStateVersion = 0, wrappedDataKey = "", projectId = null,
                )
            },
        )
        val drafts = MutableStateFlow(mapOf("s1" to "half a thought"))
        val snapshot = homeSnapshots(store, MutableStateFlow(emptyMap()), MutableStateFlow(emptyMap()), drafts = drafts).first()
        val byId = snapshot.sessions.associateBy { it.id }
        assertEquals("half a thought", byId.getValue("s1").draft)
        assertNull(byId.getValue("s2").draft)
    }
}
