package com.slopus.happy.connection

import com.slopus.happy.analytics.Analytics
import com.slopus.happy.analytics.AnalyticsEvent
import com.slopus.happy.analytics.AnalyticsReasons
import com.slopus.happy.analytics.SignInError
import com.slopus.happy.analytics.SignInMethod
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** Where one team server sign-in stands, as its screen draws it. */
sealed interface ServerSignInState {
    data class Checking(val server: String) : ServerSignInState

    /** The server's sign-in, shown with the authorization server's host before the browser opens. */
    data class Ready(val server: String, val method: OAuthMethod) : ServerSignInState

    /** The browser is open; the app waits for it to come back. */
    data class InBrowser(val server: String, val method: OAuthMethod) : ServerSignInState

    data class Finishing(val server: String) : ServerSignInState

    /** A new team member: the server needs a name before it lets them in. */
    data class NeedsName(val server: String, val saving: Boolean = false, val failed: Boolean = false) : ServerSignInState

    data class Done(val account: AgentConnection) : ServerSignInState

    data class Failed(val server: String?, val reason: ServerAuthException.Reason) : ServerSignInState
}

/**
 * Signing in to a team server behind an SSO load balancer (edge SSO
 * contract): from a server QR code desktop shows ([ServerInvite]), the
 * only way a phone adds one, `GET /v0/authentication`, the authorization
 * code flow with PKCE in the system browser (a Custom Tab, never a
 * WebView), back through [REDIRECT_URI], the code exchanged, the token
 * checked with the server, a name if the person is new there, health's
 * `instanceId` checked against [expectedInstance], and the server kept as
 * an agent connection. [replacing] signs an existing one in again. The
 * verifier and state live only in this object: a sign-in the app was
 * killed during starts over. Closing records how it ended
 * (`team_server_signed_in` or `sign_in_failed`; nothing when it was left),
 * whatever retries came before.
 */
class ServerSignInFlow(
    private val scope: CoroutineScope,
    private val connections: AgentConnections,
    private val auth: ServerAuthClient,
    val replacing: String? = null,
    /** The installation the server must be: the code's, or the one signing in again was. Null: not checked (an older daemon has none). */
    private val expectedInstance: String? = null,
    /** Another member signed in again on [replacing]: the id of the connection of their own that took its place. */
    private val onReplaced: (String) -> Unit = {},
    private val record: (AnalyticsEvent) -> Unit = Analytics::record,
) {
    private val mutableState = MutableStateFlow<ServerSignInState>(ServerSignInState.Checking(""))
    val state: StateFlow<ServerSignInState> = mutableState.asStateFlow()

    private var origin: AgentOrigin? = null
    private var method: OAuthMethod? = null
    private var pending: PendingOAuth? = null
    private var grant: Pair<OAuthGrant, OAuthCredential>? = null

    /** This grant's health named [expectedInstance] ([verify]). */
    private var verified = false

    /** Who this grant signed in, once the server says (a new member: after their name is saved). */
    private var member: String? = null
    private var job: Job? = null
    private var reported = false

    /**
     * [replacing] is signed in but has no profile on its server yet (the
     * profile gate): asks for the name with the token it has, no browser.
     */
    fun onboard(address: String) {
        origin = try {
            ServerAuthClient.parseAddress(address)
        } catch (e: ServerAuthException) {
            mutableState.value = ServerSignInState.Failed(null, e.reason)
            return
        }
        mutableState.value = ServerSignInState.NeedsName(address)
    }

    /** Starts signing in to [address]: a scanned code's origin, or a server signing in again. */
    fun start(address: String) {
        val parsed = try {
            ServerAuthClient.parseAddress(address)
        } catch (e: ServerAuthException) {
            mutableState.value = ServerSignInState.Failed(null, e.reason)
            return
        }
        origin = parsed
        mutableState.value = ServerSignInState.Checking(parsed.value)
        run(parsed.value) {
            // Display order: the first sign-in this app knows is the server's own choice.
            val first = auth.discover(parsed).first()
            // Refused before the browser: its token endpoint would be another site's.
            if (!first.oneSite) throw ServerAuthException(ServerAuthException.Reason.CrossOrigin)
            method = first
            mutableState.value = ServerSignInState.Ready(parsed.value, first)
        }
    }

    /** The page the browser opens, starting a fresh sign-in each time; null when nothing is ready to sign in to. */
    fun browserUrl(): String? {
        val origin = origin ?: return null
        val method = method ?: return null
        val next = try {
            auth.begin(origin, method, REDIRECT_URI)
        } catch (e: ServerAuthException) {
            mutableState.value = ServerSignInState.Failed(origin.value, e.reason)
            return null
        }
        pending = next
        mutableState.value = ServerSignInState.InBrowser(origin.value, method)
        return next.authorizeUrl
    }

    /** The browser came back to the redirect URI with [uri]. One that isn't this sign-in's is ignored. */
    fun callback(uri: String) {
        val pending = pending ?: return
        // A page left open from an earlier try comes back with another state: not this sign-in's.
        // A malformed one (any app can send it) is not this sign-in's either.
        if (!pending.isCallback(uri) || ServerAuthClient.query(uri)?.get("state") != pending.state || mutableState.value !is ServerSignInState.InBrowser) return
        this.pending = null
        val server = pending.origin.value
        mutableState.value = ServerSignInState.Finishing(server)
        run(server) {
            val signedIn = auth.complete(pending, uri)
            grant = signedIn
            verified = false
            val (authenticated, userId) = auth.check(pending.origin, signedIn.first.access.value)
            if (!authenticated) throw ServerAuthException(ServerAuthException.Reason.Rejected)
            member = userId
            if (userId != null) return@run finish()
            // A new member: checked before the name, so none is saved on another server, unless health is behind the profile gate too.
            verify(pending.origin, signedIn.first.access.value, beforeProfile = true)
            mutableState.value = ServerSignInState.NeedsName(server)
        }
    }

    /** A new member's name, saved before the server is kept. */
    fun submitName(name: String) {
        val origin = origin ?: return
        val granted = grant?.first?.access
        if (granted == null && replacing == null) return
        val trimmed = name.trim().takeIf { it.isNotEmpty() } ?: return
        mutableState.value = ServerSignInState.NeedsName(origin.value, saving = true)
        job = scope.launch {
            try {
                val token = granted?.value ?: replacing?.let { id ->
                    connections.bearer(id, connections.credentials(id) ?: throw ServerAuthException(ServerAuthException.Reason.SignInRequired))
                }!!
                try {
                    auth.saveName(origin, token, trimmed)
                } catch (e: ServerAuthException) {
                    // The access token expired while the person typed: refreshed once, and sent again.
                    if (e.reason != ServerAuthException.Reason.SignInRequired) throw e
                    auth.saveName(origin, renewed(token) ?: throw e, trimmed)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                mutableState.value = ServerSignInState.NeedsName(origin.value, failed = true)
                return@launch
            }
            try {
                finish()
            } catch (e: CancellationException) {
                throw e
            } catch (e: ServerAuthException) {
                mutableState.value = ServerSignInState.Failed(origin.value, e.reason)
            } catch (_: Exception) {
                mutableState.value = ServerSignInState.Failed(origin.value, ServerAuthException.Reason.Unreachable)
            }
        }
    }

    /** A newer token than [stale]: the fresh grant's refreshed (and kept, as it rotates), or the connection's. */
    private suspend fun renewed(stale: String): String? {
        val (_, credential) = grant ?: return replacing?.let { connections.renew(it, stale) }
        if (!credential.canRefresh) return null
        val (access, next) = auth.refresh(credential, origin ?: return null)
        grant = OAuthGrant(access, next.refreshToken) to next
        return access.value
    }

    /** After a failure: the server's sign-in if it was found, else the server asked again. Without an address there is nothing to retry. */
    fun retry() {
        val origin = origin ?: return
        val method = method
        if (method != null) mutableState.value = ServerSignInState.Ready(origin.value, method) else start(origin.value)
    }

    fun close() {
        job?.cancel()
        pending = null
        grant = null
        if (reported) return
        reported = true
        // Left without signing in sends nothing.
        val event = when (val state = mutableState.value) {
            is ServerSignInState.Done -> AnalyticsEvent.TeamServerSignedIn
            is ServerSignInState.Failed -> AnalyticsEvent.SignInFailed(SignInMethod.TeamServer, AnalyticsReasons.signIn(state.reason))
            is ServerSignInState.NeedsName -> if (state.failed) AnalyticsEvent.SignInFailed(SignInMethod.TeamServer, SignInError.ProfileRequired) else null
            else -> null
        }
        event?.let(record)
    }

    private suspend fun finish() {
        val origin = origin ?: return
        val onboarded = replacing.takeIf { grant == null }
        if (onboarded != null) {
            // Onboarded with the token it had: the connection goes on as it was.
            connections.update(onboarded) { it.copy(signInRequired = false, profileRequired = false) }
            connections.accounts.value.firstOrNull { it.id == onboarded }?.let { mutableState.value = ServerSignInState.Done(it) }
            return
        }
        val (granted, credential) = grant ?: return
        if (!verified) verify(origin, granted.access.value)
        // Kept as this member's: another's connection on this server is never reused.
        val userId = member ?: auth.check(origin, granted.access.value).let { (authenticated, userId) -> userId.takeIf { authenticated } }
            ?: throw ServerAuthException(ServerAuthException.Reason.Rejected)
        val account = connections.addServer(origin, credential.copy(userId = userId), granted.access, fallbackName = origin.host, replacing = replacing)
        grant = null
        mutableState.value = ServerSignInState.Done(account)
        if (replacing != null && account.id != replacing) onReplaced(account.id)
    }

    /**
     * Keeps the sign-in only if health at [origin] names [expectedInstance]
     * (contract §8): the code's installation, or the one signing in again
     * was. Otherwise the credential is dropped and it is WrongServer, as it
     * is for a health that names none. [beforeProfile]: a new member's
     * health may be behind the profile gate, and is then checked after the
     * name instead.
     */
    private suspend fun verify(origin: AgentOrigin, token: String, beforeProfile: Boolean = false) {
        if (expectedInstance == null) {
            verified = true
            return
        }
        val instanceId = try {
            auth.instanceId(origin, token)
        } catch (e: ServerAuthException) {
            if (beforeProfile && e.reason == ServerAuthException.Reason.SignInRequired) return
            throw e
        }
        if (instanceId != expectedInstance) {
            grant = null
            throw ServerAuthException(ServerAuthException.Reason.WrongServer)
        }
        verified = true
    }

    private fun run(server: String, block: suspend () -> Unit) {
        job?.cancel()
        job = scope.launch {
            try {
                block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: ServerAuthException) {
                mutableState.value = ServerSignInState.Failed(server, e.reason)
            } catch (_: Exception) {
                mutableState.value = ServerSignInState.Failed(server, ServerAuthException.Reason.Unreachable)
            }
        }
    }

    companion object {
        /**
         * The redirect URI, the same on every platform and flavor (edge SSO
         * contract §2): what admins allow-list. `happy` is the app's own
         * scheme; MainActivity takes this host and path before Happy links.
         */
        const val REDIRECT_URI = "happy://oauth/callback"

        fun isRedirect(uri: String): Boolean = uri.substringBefore('?').substringBefore('#') == REDIRECT_URI
    }
}
