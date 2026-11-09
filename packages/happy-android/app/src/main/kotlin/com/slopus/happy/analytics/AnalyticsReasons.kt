package com.slopus.happy.analytics

import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.auth.InvalidSecretKeyException
import com.slopus.happy.connection.AgentConnectionException
import com.slopus.happy.connection.ServerAuthException
import com.slopus.happy.conversation.ConversationApiException
import com.slopus.happy.net.ConnectionStatus
import com.slopus.happy.net.HttpStatusException
import com.slopus.happy.sync.SendFailure
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.SerializationException
import java.io.IOException
import java.io.InterruptedIOException

/**
 * The app's typed reasons as the catalog's closed sets, in one place. Only
 * a reason's kind or an HTTP status is read here, never a message.
 */
object AnalyticsReasons {
    /** How the pairing code reached the phone, as `mobile_pairing_*`'s `start`. */
    fun start(start: com.slopus.happy.connection.PairingStart): PairingStart = when (start) {
        com.slopus.happy.connection.PairingStart.Scan -> PairingStart.Scan
        com.slopus.happy.connection.PairingStart.PasteLink -> PairingStart.PasteLink
        com.slopus.happy.connection.PairingStart.OpenedLink -> PairingStart.OpenedLink
    }

    fun pairing(reason: AgentConnectionException.Reason): PairingError = when (reason) {
        AgentConnectionException.Reason.InvalidCode -> PairingError.InvalidCode
        AgentConnectionException.Reason.UpdateRequired -> PairingError.UpdateRequired
        AgentConnectionException.Reason.Expired -> PairingError.Expired
        AgentConnectionException.Reason.Rejected -> PairingError.Rejected
        AgentConnectionException.Reason.InvalidProof -> PairingError.InvalidProof
        AgentConnectionException.Reason.InvalidResponse -> PairingError.InvalidResponse
        AgentConnectionException.Reason.Unavailable -> PairingError.Unavailable
        AgentConnectionException.Reason.Revoked -> PairingError.Revoked
        AgentConnectionException.Reason.Disabled -> PairingError.Disabled
        AgentConnectionException.Reason.ProfileRequired -> PairingError.ProfileRequired
        AgentConnectionException.Reason.SignInRequired -> PairingError.SignInRequired
    }

    fun signIn(reason: ServerAuthException.Reason): SignInError = when (reason) {
        ServerAuthException.Reason.InvalidAddress -> SignInError.InvalidAddress
        ServerAuthException.Reason.NoSignIn -> SignInError.NoSignIn
        ServerAuthException.Reason.EdgeBlocked -> SignInError.EdgeBlocked
        ServerAuthException.Reason.Unreachable -> SignInError.Unreachable
        ServerAuthException.Reason.Denied -> SignInError.Denied
        ServerAuthException.Reason.Expired, ServerAuthException.Reason.SignInRequired -> SignInError.Expired
        ServerAuthException.Reason.InvalidToken -> SignInError.InvalidToken
        ServerAuthException.Reason.Rejected -> SignInError.Rejected
        ServerAuthException.Reason.WrongServer, ServerAuthException.Reason.CrossOrigin, ServerAuthException.Reason.WrongAudience -> SignInError.WrongServer
    }

    /** A Happy (relay) sign-in's failure: a key that isn't one, the server's refusal, no network, or anything else. */
    fun relaySignIn(error: Throwable): SignInError = when {
        error is InvalidSecretKeyException -> SignInError.InvalidToken
        error is HttpStatusException && (error.status == 401 || error.status == 403) -> SignInError.Rejected
        error is HttpStatusException -> SignInError.Unknown
        error is IOException -> SignInError.Unreachable
        else -> SignInError.Unknown
    }

    /** An agent connection's link: null while it talks to the agent. */
    fun link(status: AgentLinkStatus): ConnectionCode? = when (status) {
        AgentLinkStatus.Connected -> null
        AgentLinkStatus.Connecting -> ConnectionCode.Unreachable
        AgentLinkStatus.Revoked -> ConnectionCode.Revoked
        AgentLinkStatus.UpdateRequired -> ConnectionCode.VersionMismatch
        AgentLinkStatus.SignInRequired -> ConnectionCode.AuthExpired
    }

    /** A Happy account's updates socket: null while connected. Its error is any failed connection, so the server is unreachable too. */
    fun link(status: ConnectionStatus): ConnectionCode? = when (status) {
        ConnectionStatus.CONNECTED -> null
        ConnectionStatus.DISCONNECTED, ConnectionStatus.CONNECTING, ConnectionStatus.ERROR -> ConnectionCode.Unreachable
    }

    /**
     * A Happy CLI send's failed row in front of the person: `error_shown`
     * with why it failed, the first time that row is seen ([Analytics.errorSeen]).
     * A row failed for a reason the catalog doesn't tell tells nothing.
     */
    fun sendFailureSeen(localId: String, failure: SendFailure?) {
        val code = when (failure) {
            SendFailure.TimedOut -> ErrorCode.Timeout
            is SendFailure.Refused -> ErrorCode.ofStatus(failure.status)
            null -> return
        }
        Analytics.errorSeen("send:$localId", ErrorArea.MessageSend, code)
    }

    /** What failed a request, as `error_shown`'s code. */
    fun error(error: Throwable): ErrorCode = when (error) {
        is ConversationApiException -> ErrorCode.ofStatus(error.status)
        is AgentApiException -> ErrorCode.ofStatus(error.status)
        is HttpStatusException -> ErrorCode.ofStatus(error.status)
        is AgentConnectionException -> when (error.reason) {
            AgentConnectionException.Reason.Unavailable -> ErrorCode.Offline
            AgentConnectionException.Reason.Revoked, AgentConnectionException.Reason.SignInRequired -> ErrorCode.Unauthorized
            AgentConnectionException.Reason.UpdateRequired -> ErrorCode.VersionMismatch
            AgentConnectionException.Reason.InvalidResponse -> ErrorCode.InvalidResponse
            AgentConnectionException.Reason.Disabled -> ErrorCode.Unsupported
            AgentConnectionException.Reason.ProfileRequired -> ErrorCode.Forbidden
            else -> ErrorCode.Unknown
        }
        is InterruptedIOException -> ErrorCode.Timeout
        is IOException -> ErrorCode.Offline
        is SerializationException -> ErrorCode.InvalidResponse
        else -> ErrorCode.Unknown
    }

    /** Runs a Happy (relay) sign-in [block]: `sign_in_failed` when it failed; nothing when it worked or was left. */
    suspend fun <T> signingIn(method: SignInMethod, block: suspend () -> T): T = try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        Analytics.record(AnalyticsEvent.SignInFailed(method, relaySignIn(e)))
        throw e
    }

    /** A failed create's reason, as desktop's: the agent said no, wasn't reached, or anything else. */
    fun create(error: Throwable): CreateError = when {
        error is ConversationApiException || error is AgentApiException || error is HttpStatusException -> CreateError.Refused
        error is AgentConnectionException && error.reason == AgentConnectionException.Reason.Unavailable -> CreateError.Offline
        error is IOException -> CreateError.Offline
        else -> CreateError.Unknown
    }
}
