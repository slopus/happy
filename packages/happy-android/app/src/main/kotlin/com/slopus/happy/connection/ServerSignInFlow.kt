package com.slopus.happy.connection

import com.slopus.happy.config.ManagedPolicy
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** Where one team server sign-in stands, as its screen draws it. */
sealed interface ServerSignInState {
    /** Asks for the server's address; [locked] when management names the only one allowed. */
    data class Enter(val address: String = "", val locked: Boolean = false) : ServerSignInState

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
 * contract): the address, `GET /v0/authentication`, the authorization
 * code flow with PKCE in the system browser (a Custom Tab, never a
 * WebView), back through [REDIRECT_URI], the code exchanged, the token
 * checked with the server, a name if the person is new there, and the
 * server kept as an agent connection. [replacing] signs an existing one in
 * again. The verifier and state live only in this object: a sign-in the
 * app was killed during starts over.
 */
class ServerSignInFlow(
    private val scope: CoroutineScope,
    private val connections: AgentConnections,
    private val auth: ServerAuthClient,
    private val policy: () -> ManagedPolicy,
    val replacing: String? = null,
) {
    private val mutableState = MutableStateFlow<ServerSignInState>(ServerSignInState.Enter())
    val state: StateFlow<ServerSignInState> = mutableState.asStateFlow()

    private var origin: AgentOrigin? = null
    private var method: OAuthMethod? = null
    private var pending: PendingOAuth? = null
    private var grant: Pair<OAuthGrant, OAuthCredential>? = null
    private var job: Job? = null

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

    /** Starts at [address] when it is known (management's server, or one signing in again), else asks for it. */
    fun start(address: String?) {
        val managed = policy()
        val locked = managed.allowAdditionalServers == false && managed.serverUrl != null
        val initial = address ?: managed.serverUrl.takeIf { locked }
        if (initial == null) {
            mutableState.value = ServerSignInState.Enter(managed.serverUrl.orEmpty(), locked)
        } else {
            submit(initial)
        }
    }

    /** The address the person typed. */
    fun submit(address: String) {
        val parsed = try {
            ServerAuthClient.parseAddress(address)
        } catch (e: ServerAuthException) {
            mutableState.value = ServerSignInState.Failed(null, e.reason)
            return
        }
        if (!policy().allowsServer(parsed.value)) {
            mutableState.value = ServerSignInState.Failed(parsed.value, ServerAuthException.Reason.NotAllowed)
            return
        }
        origin = parsed
        mutableState.value = ServerSignInState.Checking(parsed.value)
        run(parsed.value) {
            // Display order: the first sign-in this app knows is the server's own choice.
            val first = auth.discover(parsed).first()
            method = first
            mutableState.value = ServerSignInState.Ready(parsed.value, first)
        }
    }

    /** The page the browser opens, starting a fresh sign-in each time; null when nothing is ready to sign in to. */
    fun browserUrl(): String? {
        val origin = origin ?: return null
        val method = method ?: return null
        val next = auth.begin(origin, method, REDIRECT_URI)
        pending = next
        mutableState.value = ServerSignInState.InBrowser(origin.value, method)
        return next.authorizeUrl
    }

    /** The browser came back to the redirect URI with [uri]. One that isn't this sign-in's is ignored. */
    fun callback(uri: String) {
        val pending = pending ?: return
        // A page left open from an earlier try comes back with another state: not this sign-in's.
        if (!pending.isCallback(uri) || ServerAuthClient.query(uri)["state"] != pending.state || mutableState.value !is ServerSignInState.InBrowser) return
        this.pending = null
        val server = pending.origin.value
        mutableState.value = ServerSignInState.Finishing(server)
        run(server) {
            val signedIn = auth.complete(pending, uri)
            grant = signedIn
            val (authenticated, userId) = auth.check(pending.origin, signedIn.first.access.value)
            if (!authenticated) throw ServerAuthException(ServerAuthException.Reason.Rejected)
            if (userId == null) mutableState.value = ServerSignInState.NeedsName(server) else finish()
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
                finish()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                mutableState.value = ServerSignInState.NeedsName(origin.value, failed = true)
            }
        }
    }

    /** A newer token than [stale]: the fresh grant's refreshed (and kept, as it rotates), or the connection's. */
    private suspend fun renewed(stale: String): String? {
        val (_, credential) = grant ?: return replacing?.let { connections.renew(it, stale) }
        if (!credential.canRefresh) return null
        val (access, next) = auth.refresh(credential)
        grant = OAuthGrant(access, next.refreshToken) to next
        return access.value
    }

    /** After a failure: the address again, or the server's sign-in if it was found. */
    fun retry() {
        val origin = origin
        val method = method
        mutableState.value = when {
            origin != null && method != null -> ServerSignInState.Ready(origin.value, method)
            else -> ServerSignInState.Enter(origin?.value ?: policy().serverUrl.orEmpty(), policy().let { it.allowAdditionalServers == false && it.serverUrl != null })
        }
    }

    fun close() {
        job?.cancel()
        pending = null
        grant = null
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
        val account = connections.addServer(origin, credential, granted.access, fallbackName = origin.host, replacing = replacing)
        grant = null
        mutableState.value = ServerSignInState.Done(account)
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
