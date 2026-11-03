package com.slopus.happy.guest

import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.concurrent.TimeUnit

/** happy-ios Tests/HappyGuestTests/GuestClientTests.swift's vault cases, against a local bridge. */
class GuestSessionVaultTest {
    /** The Keystore-sealed item, in memory; [value] null once deleted. */
    class MemoryStorage : GuestSecretStorage {
        @Volatile var value: String? = null
        var deletes = 0
        override fun read() = value
        override fun write(value: String) { this.value = value }
        override fun delete() { value = null; deletes++ }
    }

    private val invitation = GuestInvitation.parse("https://app.happy.engineering/bot/invite/abcdefghijklmnop")!!

    private fun MockWebServer.origin() = url("/").toString().trimEnd('/')

    private fun session(expiresAt: Double = 4102444800000.0) = GuestSession("s_1", "scoped", "Helper", "Ada", expiresAt)

    @Test
    fun aSessionSurvivesARestartAndRemovalWipesIt() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(MockResponse.Builder().body(GuestClientTest.SESSION).build())
            val storage = MemoryStorage()
            val stored = GuestSessionVault(storage).redeem(invitation, server.origin(), "Ada")
            assertEquals("Ada Lovelace", stored.displayName)
            // A new vault over the same item: what a new process sees.
            val restarted = GuestSessionVault(storage)
            assertEquals(stored, restarted.restore(invitation.identifier))
            assertEquals(stored, restarted.restore())
            restarted.remove(invitation.identifier)
            assertNull(restarted.restore(invitation.identifier))
            assertNull(storage.value)
        }
    }

    @Test
    fun aLostRedeemAnswerKeepsTheNonceAndRecoversTheSameSeatAfterARestart() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(MockResponse.Builder().code(500).build())
            server.enqueue(MockResponse.Builder().body(GuestClientTest.SESSION).build())
            val storage = MemoryStorage()
            try {
                GuestSessionVault(storage).redeem(invitation, server.origin(), "Ada")
                fail()
            } catch (e: GuestError) {
                assertEquals(GuestError.Unavailable, e)
            }
            val pending = GuestSessionVault(storage).pendingRedemption(invitation.identifier)!!
            assertEquals(43, pending.redeemNonce.length)
            assertEquals("Ada", pending.displayName)
            // Asked again under another name, the kept name and nonce are what is sent.
            assertNotNull(GuestSessionVault(storage).redeem(invitation, server.origin(), "Grace"))
            val first = server.takeRequest().body!!.utf8()
            val second = server.takeRequest().body!!.utf8()
            assertEquals(first, second)
            assertTrue(pending.redeemNonce in second && "\"Ada\"" in second)
        }
    }

    @Test
    fun concurrentRedeemsShareOneRequest() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(MockResponse.Builder().body(GuestClientTest.SESSION).headersDelay(300, TimeUnit.MILLISECONDS).build())
            val vault = GuestSessionVault(MemoryStorage())
            val sessions = (1..3).map { async { vault.redeem(invitation, server.origin(), "Ada") } }.awaitAll()
            assertEquals(1, sessions.toSet().size)
            assertEquals(1, server.requestCount)
        }
    }

    @Test
    fun aRemovalDuringARedeemCannotBringItsCredentialsBack() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(MockResponse.Builder().body(GuestClientTest.SESSION).headersDelay(300, TimeUnit.MILLISECONDS).build())
            val storage = MemoryStorage()
            val vault = GuestSessionVault(storage)
            val join = async { runCatching { vault.redeem(invitation, server.origin(), "Ada") } }
            kotlinx.coroutines.delay(100)
            vault.remove(invitation.identifier)
            assertEquals(GuestError.Revoked, join.await().exceptionOrNull())
            assertNull(vault.restore(invitation.identifier))
            assertNull(storage.value)
        }
    }

    @Test
    fun aSessionADayPastItsExpiryIsPruned() = runBlocking {
        val storage = MemoryStorage()
        val now = 1_000_000_000_000L
        val vault = GuestSessionVault(storage, now = { now })
        vault.save(StoredGuestSession("https://app.happy.engineering", "old", session(expiresAt = (now - 86_400_001).toDouble())))
        vault.save(StoredGuestSession("https://app.happy.engineering", "recent", session(expiresAt = (now - 3_600_000).toDouble())))
        assertNull(vault.restore("old"))
        assertNotNull(vault.restore("recent"))
        assertEquals("recent", vault.restore()?.invitationId)
    }

    @Test
    fun aFullInviteIsNotExpiryAndRemovesTheKeptJoin() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(MockResponse.Builder().code(410).body("""{"code":"invite_full"}""").build())
            val storage = MemoryStorage()
            val vault = GuestSessionVault(storage)
            assertEquals(GuestError.InviteFull, runCatching { vault.redeem(invitation, server.origin(), "Ada") }.exceptionOrNull())
            assertNull(vault.pendingRedemption(invitation.identifier))
            assertNull(storage.value)
        }
    }

    @Test
    fun aNameRefusedHereNeverMakesANonceOrReachesTheBridge() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            val storage = MemoryStorage()
            assertEquals(GuestError.InvalidName, runCatching { GuestSessionVault(storage).redeem(invitation, server.origin(), "<Ada>") }.exceptionOrNull())
            assertNull(storage.value)
            assertEquals(0, server.requestCount)
        }
    }

    @Test
    fun aNameTheBridgeRefusedMayBeCorrectedWithTheSameNonce() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(MockResponse.Builder().code(400).body("""{"code":"invalid_name"}""").build())
            server.enqueue(MockResponse.Builder().body(GuestClientTest.SESSION).build())
            val vault = GuestSessionVault(MemoryStorage())
            assertEquals(GuestError.InvalidName, runCatching { vault.redeem(invitation, server.origin(), "Ada") }.exceptionOrNull())
            assertEquals(true, vault.pendingRedemption(invitation.identifier)?.nameRejected)
            vault.redeem(invitation, server.origin(), "Grace")
            val first = server.takeRequest().body!!.utf8()
            val second = server.takeRequest().body!!.utf8()
            assertEquals(first.substringAfter("redeemNonce").substringBefore(','), second.substringAfter("redeemNonce").substringBefore(','))
            assertTrue("\"Grace\"" in second)
        }
    }
}
