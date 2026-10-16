package com.slopus.happy.sync

import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** sync.ts `new-session`: the listing is fetched again, so a body this app can't decode still brings the session in. */
@RunWith(AndroidJUnit4::class)
class NewSessionUpdateTest {
    private lateinit var h: AccountHarness

    @Before
    fun setUp() {
        h = AccountHarness()
    }

    @After
    fun tearDown() = h.close()

    @Test
    fun anUndecodableNewSessionAsksForTheListing() {
        h.startAndSync()
        h.server.addSession("s2", updatedAt = 500)
        h.server.requests.clear()
        // Not an ApiSession: no seq, no metadata.
        h.server.emitUpdate(buildJsonObject { put("t", "new-session"); put("id", "s2") })
        eventually(message = "listing fetched") { h.server.requestsTo("/v2/sessions").isNotEmpty() }
        eventually(message = "session stored") { h.store.session("s2") != null }
    }
}
