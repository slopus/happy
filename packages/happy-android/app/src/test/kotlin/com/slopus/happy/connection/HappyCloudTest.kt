package com.slopus.happy.connection

import com.slopus.happy.BuildConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Happy Cloud: the compiled-in team server, told apart from any other by its origin. */
class HappyCloudTest {
    private val cloud = HappyCloud.origin!!.value

    private fun connection(id: String, server: String?, addedAt: Long = 0) = AgentConnection(id = id, name = id, addedAt = addedAt, server = server)

    @Test
    fun theBuildsAddressIsAnOrigin() {
        assertEquals(HappyCloud.of(BuildConfig.HAPPY_CLOUD_URL)?.value, cloud)
        assertEquals("https://cloud.example", HappyCloud.of("https://cloud.example/")?.value)
        assertNull(HappyCloud.of("https://cloud.example/team/"))
        assertNull(HappyCloud.of("http://cloud.example/"))
    }

    @Test
    fun onlyDevAndPreviewBuildsOfferIt() {
        assertTrue(HappyCloud.offeredIn("debug"))
        assertTrue(HappyCloud.offeredIn("preview"))
        assertFalse(HappyCloud.offeredIn("release"))
        assertFalse(HappyCloud.offeredIn("bench"))
    }

    @Test
    fun onlyTheCloudsOriginIsTheCloud() {
        assertTrue(HappyCloud.isCloud(connection("a", cloud)))
        assertFalse(HappyCloud.isCloud(connection("b", "https://happy.acme.example")))
        assertFalse(HappyCloud.isCloud(connection("c", null)))
        assertFalse(HappyCloud.isCloud(null))
    }

    @Test
    fun theOpenCloudTeamFirstThenTheOldest() {
        val accounts = listOf(connection("other", "https://happy.acme.example"), connection("new", cloud, 2), connection("old", cloud, 1))
        assertEquals("old", HappyCloud.connection(accounts)?.id)
        assertEquals("new", HappyCloud.connection(accounts, open = "new")?.id)
        assertNull(HappyCloud.connection(accounts.take(1)))
    }
}
