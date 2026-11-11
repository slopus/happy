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
    fun accountsHaveTheirOwnOriginAndServersLiveUnderBase() {
        assertEquals(BuildConfig.HAPPY_CLOUD_ACCOUNTS.removeSuffix("/"), HappyCloud.accounts?.value)
        assertEquals("https://auth.happy.engineering", HappyCloud.originOf("https://auth.happy.engineering/")?.value)
        assertNull(HappyCloud.originOf("https://auth.happy.engineering/v1"))
        assertNull(HappyCloud.originOf("http://auth.happy.engineering"))
        assertEquals("https://acme.happy.computer", HappyCloud.serverOf("happy.computer", "acme")?.value)
        assertNull(HappyCloud.serverOf("happy computer", "acme"))
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
        assertNull(HappyCloud.handle("https://a.b.happy.computer", base))
        assertNull(HappyCloud.handle("https://happy.acme.example", base))
        assertNull(HappyCloud.handle(null, base))
    }

    /** What a server's placeholder is picked by, on every client: its bare name. */
    @Test
    fun aServersNameIsItsHandleWithoutTheAt() {
        val base = "happy.computer"
        assertEquals("acme", HappyCloud.serverName("https://acme.happy.computer", base))
        assertNull(HappyCloud.serverName("https://a.b.happy.computer", base))
        assertNull(HappyCloud.serverName("https://happy.acme.example", base))
    }

    @Test
    fun theOpenConnectionToAServerFirstThenTheOldest() {
        val acme = "https://acme.happy.computer"
        val accounts = listOf(connection("other", "https://beta.happy.computer"), connection("new", acme, 2), connection("old", acme, 1))
        assertEquals("old", HappyCloud.connection(accounts, acme)?.id)
        assertEquals("new", HappyCloud.connection(accounts, acme, open = "new")?.id)
        assertNull(HappyCloud.connection(accounts, "https://gamma.happy.computer"))
    }

    @Test
    fun aServersWebSettingsAreUnderTheWebAppsDomain() {
        val base = "happy.computer"
        assertEquals("https://acme.happybases.com/#/settings/providers", HappyCloud.webSettings("https://acme.happy.computer", "providers", base, "happybases.com"))
        assertEquals("https://acme.happybases.com/#/settings/providers/import", HappyCloud.webSettings("https://acme.happy.computer", "providers/import", base, "happybases.com"))
        assertEquals(null, HappyCloud.webSettings("https://studio.example", "providers", base, "happybases.com"))
    }
}
