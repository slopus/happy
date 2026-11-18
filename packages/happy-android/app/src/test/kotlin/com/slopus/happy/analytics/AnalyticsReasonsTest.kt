package com.slopus.happy.analytics

import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.auth.CredentialStorageException
import com.slopus.happy.auth.InvalidSecretKeyException
import com.slopus.happy.auth.UnreadableApprovalException
import com.slopus.happy.connection.AgentConnectionException
import com.slopus.happy.connection.ServerAuthException
import com.slopus.happy.conversation.ConversationApiException
import com.slopus.happy.net.ConnectionStatus
import com.slopus.happy.net.HttpStatusException
import kotlinx.serialization.SerializationException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.IOException
import java.net.SocketTimeoutException
import java.security.GeneralSecurityException

/** The app's typed reasons as the catalog's sets (`AnalyticsReasons`), never a message. */
class AnalyticsReasonsTest {
    @Test
    fun reasonsAreTheCatalogsKindsNeverTheirWords() {
        assertEquals(SignInError.InvalidToken, AnalyticsReasons.relaySignIn(InvalidSecretKeyException()))
        assertEquals(SignInError.Rejected, AnalyticsReasons.relaySignIn(HttpStatusException(401, "no")))
        assertEquals(SignInError.Unreachable, AnalyticsReasons.relaySignIn(IOException("down")))
        assertEquals(ConnectionCode.Unreachable, AnalyticsReasons.link(ConnectionStatus.ERROR))
        assertNull(AnalyticsReasons.link(ConnectionStatus.CONNECTED))
        assertEquals(ConnectionCode.Revoked, AnalyticsReasons.link(AgentLinkStatus.Revoked))
        assertEquals(PairingError.Unavailable, AnalyticsReasons.pairing(AgentConnectionException.Reason.Unavailable))
        assertEquals(PairingError.SignInRequired, AnalyticsReasons.pairing(AgentConnectionException.Reason.SignInRequired))
        assertEquals(SignInError.WrongServer, AnalyticsReasons.signIn(ServerAuthException.Reason.CrossOrigin))
        assertEquals(ErrorCode.RateLimited, AnalyticsReasons.error(HttpStatusException(429, "")))
        assertEquals(ErrorCode.Timeout, AnalyticsReasons.error(SocketTimeoutException()))
        assertEquals(ErrorCode.Offline, AnalyticsReasons.error(IOException()))
        assertEquals(ErrorCode.Unknown, AnalyticsReasons.error(IllegalStateException()))
    }

    /** `sign_in_failed` for a Happy account says which step of the restore failed, never `unknown` for one it knows. */
    @Test
    fun aRelaySignInSaysWhichStepFailed() {
        assertEquals(SignInError.InvalidToken, AnalyticsReasons.relaySignIn(InvalidSecretKeyException()))
        assertEquals(SignInError.Rejected, AnalyticsReasons.relaySignIn(HttpStatusException(403, "")))
        assertEquals(SignInError.Rejected, AnalyticsReasons.relaySignIn(HttpStatusException(400, "")))
        assertEquals(SignInError.RateLimited, AnalyticsReasons.relaySignIn(HttpStatusException(429, "")))
        assertEquals(SignInError.ServerError, AnalyticsReasons.relaySignIn(HttpStatusException(500, "")))
        assertEquals(SignInError.ServerError, AnalyticsReasons.relaySignIn(HttpStatusException(502, "<html>")))
        assertEquals(SignInError.Unreachable, AnalyticsReasons.relaySignIn(SocketTimeoutException()))
        assertEquals(SignInError.InvalidResponse, AnalyticsReasons.relaySignIn(SerializationException("not JSON")))
        assertEquals(SignInError.InvalidResponse, AnalyticsReasons.relaySignIn(UnreadableApprovalException()))
        assertEquals(SignInError.StorageFailed, AnalyticsReasons.relaySignIn(CredentialStorageException(GeneralSecurityException())))
        assertEquals(SignInError.Unknown, AnalyticsReasons.relaySignIn(IllegalStateException()))
    }

    @Test
    fun aFailedCreateIsRefusedOfflineOrUnknown() {
        assertEquals(CreateError.Refused, AnalyticsReasons.create(ConversationApiException(400, "bad", "no")))
        assertEquals(CreateError.Offline, AnalyticsReasons.create(AgentConnectionException(AgentConnectionException.Reason.Unavailable)))
        assertEquals(CreateError.Offline, AnalyticsReasons.create(IOException()))
        assertEquals(CreateError.Unknown, AnalyticsReasons.create(IllegalStateException()))
    }
}
