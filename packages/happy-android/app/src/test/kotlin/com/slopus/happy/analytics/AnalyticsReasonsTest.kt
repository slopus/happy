package com.slopus.happy.analytics

import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.auth.InvalidSecretKeyException
import com.slopus.happy.connection.AgentConnectionException
import com.slopus.happy.connection.ServerAuthException
import com.slopus.happy.conversation.ConversationApiException
import com.slopus.happy.net.ConnectionStatus
import com.slopus.happy.net.HttpStatusException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.IOException
import java.net.SocketTimeoutException

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

    @Test
    fun aFailedCreateIsRefusedOfflineOrUnknown() {
        assertEquals(CreateError.Refused, AnalyticsReasons.create(ConversationApiException(400, "bad", "no")))
        assertEquals(CreateError.Offline, AnalyticsReasons.create(AgentConnectionException(AgentConnectionException.Reason.Unavailable)))
        assertEquals(CreateError.Offline, AnalyticsReasons.create(IOException()))
        assertEquals(CreateError.Unknown, AnalyticsReasons.create(IllegalStateException()))
    }
}
