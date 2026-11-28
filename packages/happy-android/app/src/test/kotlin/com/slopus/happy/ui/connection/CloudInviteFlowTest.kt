package com.slopus.happy.ui.connection

import com.slopus.happy.connection.CloudAccountState
import com.slopus.happy.connection.CloudException
import com.slopus.happy.connection.CloudInvite
import com.slopus.happy.connection.CloudInviteException
import com.slopus.happy.connection.CloudInviteLink
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

/**
 * One invite against the state machine every Happy client shares: the
 * preview before any sign-in, Join signed in or out, a sign-in given up,
 * the session gone on the accept, each reason an invite can't be used, and
 * Try again asking the step that failed. Nothing is accepted without a
 * press.
 */
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

    /** A link at the invite's address with no usable token: "Invalid invitation", and the API is asked nothing, then or on any press. */
    @Test
    fun aMalformedLinkIsRefusedWithoutAsking() = runTest(UnconfinedTestDispatcher()) {
        val service = Service(signedIn = true)
        val flow = CloudInviteFlow(CloudInviteLink.Malformed, service, backgroundScope)
        assertEquals(CloudInviteStep.Refused(CloudInviteRefusal.Unknown), flow.step)
        flow.load()
        flow.join { error("no sign-in") }
        service.state.value = CloudAccountState.SignedOut()
        service.state.value = CloudAccountState.SignedIn
        assertEquals(CloudInviteStep.Refused(CloudInviteRefusal.Unknown), flow.step)
        assertEquals(emptyList<String>(), service.calls)
    }

    /** The offer is read with no session, and opening the link joins nothing, signed in or out. */
    @Test
    fun openingALinkOnlyPreviews() = runTest(UnconfinedTestDispatcher()) {
        for (signedIn in listOf(true, false)) {
            val service = Service(signedIn).apply { previewAnswer = { preview }; acceptAnswer = { acme } }
            assertEquals(CloudInviteStep.Ready(preview), flow(service).step)
            assertEquals(listOf("preview AbCd"), service.calls)
        }
    }

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

    /** "Sign in to join" was the consent; coming back from the sign-in without one spends it, and the offer stands. */
    @Test
    fun aSignInGivenUpLeavesTheOfferAndALaterSignInAcceptsNothing() = runTest(UnconfinedTestDispatcher()) {
        val service = Service(signedIn = false).apply { previewAnswer = { preview }; acceptAnswer = { acme } }
        val flow = flow(service)
        var signIns = 0
        flow.join { signIns++ }
        flow.signInGivenUp()
        assertEquals(CloudInviteStep.Ready(preview), flow.step)
        service.state.value = CloudAccountState.SignedIn
        assertEquals(CloudInviteStep.Ready(preview), flow.step)
        assertEquals(listOf("preview AbCd"), service.calls)
        // Signed in now, Join is the press that accepts.
        flow.join { signIns++ }
        assertEquals(1, signIns)
        assertEquals(CloudInviteStep.Joined(acme), flow.step)
    }

    /** Back on the invite once signed in is no giving up: the accept that the sign-in started stands. */
    @Test
    fun comingBackSignedInGivesNothingUp() = runTest(UnconfinedTestDispatcher()) {
        val service = Service(signedIn = false).apply { previewAnswer = { preview }; acceptAnswer = { throw CloudException(CloudException.Reason.Unreachable) } }
        val flow = flow(service)
        flow.join {}
        service.state.value = CloudAccountState.SignedIn
        flow.signInGivenUp()
        assertEquals(CloudInviteStep.Ready(preview, failure = CloudException.Reason.Unreachable), flow.step)
        assertEquals(listOf("preview AbCd", "accept AbCd"), service.calls)
    }

    @Test
    fun eachRefusalOfThePreviewSaysWhy() = runTest(UnconfinedTestDispatcher()) {
        for (refusal in listOf(CloudInviteRefusal.Expired, CloudInviteRefusal.Revoked, CloudInviteRefusal.UsedUp, CloudInviteRefusal.Accepted, CloudInviteRefusal.Unknown)) {
            val service = Service(signedIn = true).apply { previewAnswer = { throw CloudInviteException(refusal) } }
            val flow = flow(service)
            assertEquals(CloudInviteStep.Refused(refusal), flow.step)
            // Closed: no Join.
            flow.join { error("no sign-in") }
            assertEquals(listOf("preview AbCd"), service.calls)
        }
    }

    @Test
    fun eachRefusalOfTheAcceptSaysWhyOverTheOffer() = runTest(UnconfinedTestDispatcher()) {
        for (refusal in listOf(CloudInviteRefusal.Expired, CloudInviteRefusal.Revoked, CloudInviteRefusal.UsedUp, CloudInviteRefusal.Accepted, CloudInviteRefusal.Unknown)) {
            val service = Service(signedIn = true).apply { previewAnswer = { preview }; acceptAnswer = { throw CloudInviteException(refusal) } }
            val flow = flow(service)
            flow.join {}
            assertEquals(CloudInviteStep.Refused(refusal, preview), flow.step)
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

    /** "Sign in with another email", then back out of the sign-in: the offer, signed out, and nothing accepted later without a press. */
    @Test
    fun anotherAddressThenTheSignInGivenUpIsTheOfferAgain() = runTest(UnconfinedTestDispatcher()) {
        val mismatch = CloudInviteRefusal.EmailMismatch("s…@…")
        val service = Service(signedIn = true).apply { previewAnswer = { preview }; acceptAnswer = { throw CloudInviteException(mismatch) } }
        val flow = flow(service)
        flow.join {}
        service.state.value = CloudAccountState.SignedOut()
        flow.signInAgain {}
        flow.signInGivenUp()
        assertEquals(CloudInviteStep.Ready(preview), flow.step)
        service.acceptAnswer = { acme }
        service.state.value = CloudAccountState.SignedIn
        assertEquals(CloudInviteStep.Ready(preview), flow.step)
        assertEquals(listOf("preview AbCd", "accept AbCd"), service.calls)
    }

    /** An accept that couldn't be asked keeps the offer with its failure; Try again is the same press, and asks the accept, not the preview. */
    @Test
    fun anAcceptThatCouldntBeAskedTriesTheAcceptAgain() = runTest(UnconfinedTestDispatcher()) {
        val service = Service(signedIn = true).apply { previewAnswer = { preview }; acceptAnswer = { throw CloudException(CloudException.Reason.Unreachable) } }
        val flow = flow(service)
        flow.join {}
        assertEquals(CloudInviteStep.Ready(preview, failure = CloudException.Reason.Unreachable), flow.step)
        service.acceptAnswer = { acme }
        flow.join { error("no sign-in") }
        assertEquals(CloudInviteStep.Joined(acme), flow.step)
        assertEquals(listOf("preview AbCd", "accept AbCd", "accept AbCd"), service.calls)
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

    /** A 401 on the accept: the offer again, signed out. Signing in by itself accepts nothing; "Sign in to join" does. */
    @Test
    fun aSessionGoneOnTheAcceptIsTheOfferSignedOut() = runTest(UnconfinedTestDispatcher()) {
        val service = Service(signedIn = true).apply {
            previewAnswer = { preview }
            acceptAnswer = { state.value = CloudAccountState.SignedOut(expired = true); throw CloudException(CloudException.Reason.SignInRequired) }
        }
        val flow = flow(service)
        flow.join {}
        assertEquals(CloudInviteStep.Ready(preview, failure = CloudException.Reason.SignInRequired), flow.step)
        service.acceptAnswer = { acme }
        service.state.value = CloudAccountState.SignedIn
        assertEquals("no press, no accept", CloudInviteStep.Ready(preview, failure = CloudException.Reason.SignInRequired), flow.step)
        assertEquals(listOf("preview AbCd", "accept AbCd"), service.calls)

        service.state.value = CloudAccountState.SignedOut(expired = true)
        var signIns = 0
        flow.join { signIns++ }
        assertEquals(1, signIns)
        service.state.value = CloudAccountState.SignedIn
        assertEquals(CloudInviteStep.Joined(acme), flow.step)
        assertEquals(listOf("preview AbCd", "accept AbCd", "accept AbCd"), service.calls)
    }
}
