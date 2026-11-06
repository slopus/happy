package com.slopus.happy.connection

import com.slopus.happy.BuildConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Happy Cloud's addresses: the accounts service and each server, all under one BASE. */
class HappyCloudTest {
    private fun connection(id: String, server: String?, addedAt: Long = 0) = AgentConnection(id = id, name = id, addedAt = addedAt, server = server)

    @Test
    fun accountsAndServersLiveUnderTheBuildsBase() {
        assertEquals("https://accounts.${BuildConfig.HAPPY_CLOUD_BASE}", HappyCloud.accounts?.value)
        assertEquals("https://accounts.happy.computer", HappyCloud.accountsOf("happy.computer")?.value)
        assertEquals("https://acme.happy.computer", HappyCloud.serverOf("happy.computer", "acme")?.value)
        assertNull(HappyCloud.accountsOf("happy.computer/team"))
        assertNull(HappyCloud.accountsOf("happy computer"))
    }

    @Test
    fun onlyDevAndPreviewBuildsOfferIt() {
        assertTrue(HappyCloud.offeredIn("debug"))
        assertTrue(HappyCloud.offeredIn("preview"))
        assertFalse(HappyCloud.offeredIn("release"))
        assertFalse(HappyCloud.offeredIn("bench"))
    }

    @Test
    fun aServerIsOneNameDirectlyUnderBase() {
        val base = "happy.computer"
        assertTrue(HappyCloud.isServer("https://acme.happy.computer", base))
        assertFalse(HappyCloud.isServer("https://accounts.happy.computer", base))
        assertFalse(HappyCloud.isServer("https://a.b.happy.computer", base))
        assertFalse(HappyCloud.isServer("https://happy.computer", base))
        assertFalse(HappyCloud.isServer("https://acme.happy.computer:8443", base))
        assertFalse(HappyCloud.isServer("https://acmehappy.computer", base))
        assertFalse(HappyCloud.isServer("https://happy.acme.example", base))
        assertFalse(HappyCloud.isServer(null, base))
        assertFalse(HappyCloud.isServer("https://acme.happy.computer", null))
    }

    @Test
    fun aServerReadsLikeAUsername() {
        val base = "happy.computer"
        assertEquals("@acme", HappyCloud.handle("https://acme.happy.computer", base))
        assertNull(HappyCloud.handle("https://accounts.happy.computer", base))
        assertNull(HappyCloud.handle("https://happy.acme.example", base))
        assertNull(HappyCloud.handle(null, base))
    }

    @Test
    fun theOpenConnectionToAServerFirstThenTheOldest() {
        val acme = "https://acme.happy.computer"
        val accounts = listOf(connection("other", "https://beta.happy.computer"), connection("new", acme, 2), connection("old", acme, 1))
        assertEquals("old", HappyCloud.connection(accounts, acme)?.id)
        assertEquals("new", HappyCloud.connection(accounts, acme, open = "new")?.id)
        assertNull(HappyCloud.connection(accounts, "https://gamma.happy.computer"))
    }
}
