package com.slopus.happy.auth

import com.slopus.happy.crypto.AccountEncryption
import com.slopus.happy.crypto.AccountLink
import com.slopus.happy.crypto.Base64Variant
import com.slopus.happy.crypto.Sodium
import com.slopus.happy.crypto.decodeBase64
import com.slopus.happy.crypto.decryptBox
import com.slopus.happy.crypto.encodeBase64
import com.slopus.happy.net.HappyHttp
import com.slopus.happy.net.HttpStatusException
import com.slopus.happy.testing.FakeHappyServer
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import kotlin.time.Duration.Companion.milliseconds

/**
 * Account link (restore/index.tsx with authQRStart/authQRWait, and
 * useConnectAccount's approval) and terminal approval (authApprove.ts)
 * against the in-memory server's authRoutes.ts contract.
 */
class AccountLinkingTest {
    private lateinit var server: FakeHappyServer
    private lateinit var api: AuthApi

    @Before
    fun setUp() {
        server = FakeHappyServer().start()
        api = AuthApi(HappyHttp(OkHttpClient(), serverUrl = { server.url }, clientId = "android/test"))
    }

    @After
    fun tearDown() = server.close()

    private val credentials get() = AuthCredentials(token = server.token, secret = encodeBase64(server.secret, Base64Variant.Url))

    @Test
    fun aNewPhoneGetsTheSecretTheOtherPhoneApproves() = runBlocking {
        val newPhone = AccountLinkRequest(api)
        assertTrue(newPhone.url.startsWith("happy:///account?"))
        newPhone.start()
        val publicKey = encodeBase64(newPhone.keyPair.publicKey)
        assertTrue(publicKey in server.accountRequests)

        val waiting = async { newPhone.awaitApproval(pollInterval = 20.milliseconds) }
        // The phone that has the account scans the code.
        approveAccountLink(api, credentials, newPhone.url)

        val linked = withTimeout(5_000) { waiting.await() }!!
        assertEquals(server.token, linked.token)
        assertArrayEquals(server.secret, linked.secret)

        val approval = server.requestsTo("/v1/auth/account/response").single()
        assertEquals("Bearer ${server.token}", approval.headers["Authorization"])
        assertEquals("android/test", approval.headers["X-Happy-Client"])
        // Every poll carries the client header too, and the same key.
        server.requestsTo("/v1/auth/account/request").forEach {
            assertEquals("android/test", it.headers["X-Happy-Client"])
            assertEquals("""{"publicKey":"$publicKey"}""", it.body!!.utf8())
        }
    }

    @Test
    fun anApprovalSealedToAnotherKeyIsNull() = runBlocking {
        val newPhone = AccountLinkRequest(api)
        newPhone.start()
        val stranger = AccountLink.generateKeyPair()
        server.approveAccountRequest(newPhone.keyPair.publicKey, AccountLink.sealSecret(server.secret, stranger.publicKey))
        assertNull(newPhone.awaitApproval(pollInterval = 10.milliseconds))
    }

    @Test
    fun aFailedPollEndsTheWait() = runBlocking {
        val newPhone = AccountLinkRequest(api)
        server.close()
        try {
            newPhone.awaitApproval(pollInterval = 10.milliseconds)
            fail("expected the poll to fail")
        } catch (_: java.io.IOException) {
        }
    }

    @Test
    fun approvingAnythingButAnAccountLinkIsRefused() = runBlocking {
        for (url in listOf("happy://terminal?abc", "https://happy.engineering", "")) {
            try {
                approveAccountLink(api, credentials, url)
                fail("accepted $url")
            } catch (_: InvalidLinkException) {
            }
        }
        assertTrue(server.requestsTo("/v1/auth/account/response").isEmpty())
    }

    @Test
    fun approvingAnUnknownRequestFails() = runBlocking {
        val url = AccountLink.linkUrl(AccountLink.generateKeyPair().publicKey)
        try {
            approveAccountLink(api, credentials, url)
            fail("expected 404")
        } catch (e: HttpStatusException) {
            assertEquals(404, e.status)
        }
    }

    private fun terminal(supportsV2: Boolean): Pair<Sodium.KeyPair, String> {
        val keyPair = Sodium.boxKeypair()
        server.addTerminalRequest(keyPair.publicKey, supportsV2)
        return keyPair to TERMINAL_URL_PREFIX + encodeBase64(keyPair.publicKey, Base64Variant.Url)
    }

    private fun answerFor(keyPair: Sodium.KeyPair): ByteArray? =
        server.terminalRequests.getValue(encodeBase64(keyPair.publicKey)).response?.let { decryptBox(decodeBase64(it), keyPair.secretKey) }

    @Test
    fun aV2TerminalGetsTheContentKeyNotTheSecret() = runBlocking {
        val (keyPair, url) = terminal(supportsV2 = true)
        approveTerminal(api, credentials, server.encryption, url)
        val answer = answerFor(keyPair)!!
        assertEquals(33, answer.size)
        assertEquals(0, answer[0].toInt())
        assertArrayEquals(AccountEncryption.create(server.secret).contentPublicKey, answer.copyOfRange(1, 33))

        val status = server.requestsTo("/v1/auth/request/status").single()
        assertEquals(encodeBase64(keyPair.publicKey), status.url.queryParameter("publicKey"))
        val post = server.requestsTo("/v1/auth/response").single()
        assertEquals("Bearer ${server.token}", post.headers["Authorization"])
    }

    @Test
    fun aV1TerminalGetsTheSecret() = runBlocking {
        val (keyPair, url) = terminal(supportsV2 = false)
        approveTerminal(api, credentials, server.encryption, url)
        assertArrayEquals(server.secret, answerFor(keyPair))
    }

    @Test
    fun anAnsweredOrUnknownTerminalNeedsNothing() = runBlocking {
        val (keyPair, url) = terminal(supportsV2 = true)
        approveTerminal(api, credentials, server.encryption, url)
        val first = server.terminalRequests.getValue(encodeBase64(keyPair.publicKey)).response
        approveTerminal(api, credentials, server.encryption, url)
        assertEquals(first, server.terminalRequests.getValue(encodeBase64(keyPair.publicKey)).response)

        val unknown = TERMINAL_URL_PREFIX + encodeBase64(Sodium.boxKeypair().publicKey, Base64Variant.Url)
        approveTerminal(api, credentials, server.encryption, unknown)
        assertEquals(1, server.requestsTo("/v1/auth/response").size)
    }

    @Test
    fun aTerminalLinkMustHaveTheTerminalPrefix() = runBlocking {
        val (keyPair, _) = terminal(supportsV2 = true)
        try {
            approveTerminal(api, credentials, server.encryption, AccountLink.linkUrl(keyPair.publicKey))
            fail("accepted an account link")
        } catch (_: InvalidLinkException) {
        }
        assertTrue(server.requestsTo("/v1/auth/request/status").isEmpty())
    }
}
