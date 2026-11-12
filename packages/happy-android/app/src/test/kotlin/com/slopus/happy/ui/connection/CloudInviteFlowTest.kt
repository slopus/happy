package com.slopus.happy.ui.connection

import com.slopus.happy.connection.CloudAccountState
import com.slopus.happy.connection.CloudException
import com.slopus.happy.connection.CloudInvite
import com.slopus.happy.connection.CloudInviteException
import com.slopus.happy.connection.CloudInvitePreview
import com.slopus.happy.connection.CloudInviteRefusal
import com.slopus.happy.connection.CloudInviteService
import com.slopus.happy.connection.CloudServer
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

/** An invite's Join screen: its preview, Join signed in or out, and each reason an invite can't be used. */
@OptIn(ExperimentalCoroutinesApi::class)
class CloudInviteFlowTest {
    private val invite = CloudInvite("AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde")
    private val acme = CloudServer(id = "s1", name = "acme", url = "https://acme.happy-clusters.com", displayName = "Acme")
    private val preview = CloudInvitePreview(acme.copy(id = "", url = ""), roleName = "Viewer")

    private class Service(signedIn: Boolean) : CloudInviteService {
        override val state = MutableStateFlow<CloudAccountState>(if (signedIn) CloudAccountState.SignedIn else CloudAccountState.SignedOut())
        var previewAnswer: () -> CloudInvitePreview = { error("unset") }
        var acceptAnswer: () -> CloudServer = { error("unset") }
        val calls = mutableListOf<String>()

        override suspend fun previewInvite(invite: CloudInvite): CloudInvitePreview {
            calls += "preview ${invite.token.take(4)}"
            return previewAnswer()
        }

        override suspend fun acceptInvite(invite: CloudInvite): CloudServer {
            calls += "accept ${invite.token.take(4)}"
            return acceptAnswer()
        }
    }

    private fun TestScope.flow(service: Service) = CloudInviteFlow(invite, service, backgroundScope)

    @Test
    fun signedInJoinAcceptsAndLandsOnTheServer() = runTest(UnconfinedTestDispatcher()) {
        val service = Service(signedIn = true).apply { previewAnswer = { preview }; acceptAnswer = { acme } }
        val flow = flow(service)
        assertEquals(CloudInviteStep.Ready(preview), flow.step)
        var signIns = 0
        flow.join { signIns++ }
        assertEquals(CloudInviteStep.Joined(acme), flow.step)
        assertEquals(0, signIns)
        assertEquals(listOf("preview AbCd", "accept AbCd"), service.calls)
    }

    @Test
    fun signedOutJoinSignsInFirstThenAcceptsTheSameInvite() = runTest(UnconfinedTestDispatcher()) {
        val service = Service(signedIn = false).apply { previewAnswer = { preview }; acceptAnswer = { acme } }
        val flow = flow(service)
        var signIns = 0
        flow.join { signIns++ }
        assertEquals(1, signIns)
        assertEquals(CloudInviteStep.Ready(preview), flow.step)
        assertEquals(listOf("preview AbCd"), service.calls)
        service.state.value = CloudAccountState.SignedIn
        assertEquals(CloudInviteStep.Joined(acme), flow.step)
        assertEquals(listOf("preview AbCd", "accept AbCd"), service.calls)
    }

    @Test
    fun aSignInWithoutJoinAcceptsNothing() = runTest(UnconfinedTestDispatcher()) {
        val service = Service(signedIn = false).apply { previewAnswer = { preview }; acceptAnswer = { acme } }
        val flow = flow(service)
        service.state.value = CloudAccountState.SignedIn
        assertEquals(CloudInviteStep.Ready(preview), flow.step)
        assertEquals(listOf("preview AbCd"), service.calls)
    }

    @Test
    fun eachRefusalOfThePreviewSaysWhy() = runTest(UnconfinedTestDispatcher()) {
        for (refusal in listOf(CloudInviteRefusal.Expired, CloudInviteRefusal.Revoked, CloudInviteRefusal.UsedUp, CloudInviteRefusal.Unknown)) {
            val service = Service(signedIn = true).apply { previewAnswer = { throw CloudInviteException(refusal) } }
            assertEquals(CloudInviteStep.Refused(refusal), flow(service).step)
        }
    }

    @Test
    fun anotherAddressCanSignInAgainAndJoin() = runTest(UnconfinedTestDispatcher()) {
        val mismatch = CloudInviteRefusal.EmailMismatch("s…@…")
        val service = Service(signedIn = true).apply { previewAnswer = { preview }; acceptAnswer = { throw CloudInviteException(mismatch) } }
        val flow = flow(service)
        flow.join {}
        assertEquals(CloudInviteStep.Refused(mismatch, preview), flow.step)
        // The screen signs the account out, then asks for the sign-in.
        service.state.value = CloudAccountState.SignedOut()
        var signIns = 0
        flow.signInAgain { signIns++ }
        assertEquals(1, signIns)
        assertEquals(CloudInviteStep.Ready(preview), flow.step)
        service.acceptAnswer = { acme }
        service.state.value = CloudAccountState.SignedIn
        assertEquals(CloudInviteStep.Joined(acme), flow.step)
    }

    @Test
    fun anUnreachableServiceOffersTryAgain() = runTest(UnconfinedTestDispatcher()) {
        val service = Service(signedIn = true).apply { previewAnswer = { throw CloudException(CloudException.Reason.Unreachable) } }
        val flow = flow(service)
        assertEquals(CloudInviteStep.Unloaded(CloudException.Reason.Unreachable), flow.step)
        service.previewAnswer = { preview }
        flow.load()
        assertEquals(CloudInviteStep.Ready(preview), flow.step)
    }

    @Test
    fun aPassThatRanOutOnTheWayJoinsAfterSigningInAgain() = runTest(UnconfinedTestDispatcher()) {
        val service = Service(signedIn = true).apply {
            previewAnswer = { preview }
            acceptAnswer = { state.value = CloudAccountState.SignedOut(expired = true); throw CloudException(CloudException.Reason.SignInRequired) }
        }
        val flow = flow(service)
        flow.join {}
        assertEquals(CloudInviteStep.Ready(preview, failure = CloudException.Reason.SignInRequired), flow.step)
        service.acceptAnswer = { acme }
        service.state.value = CloudAccountState.SignedIn
        assertEquals(CloudInviteStep.Joined(acme), flow.step)
    }
}
