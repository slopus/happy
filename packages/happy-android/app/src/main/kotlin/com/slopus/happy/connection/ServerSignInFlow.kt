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

    /**
     * A new team member: the server needs a name before it lets them in.
     * [suggested] is the server's (on Happy Cloud, the account's) to start
     * from; [photo] the picture chosen, a prepared JPEG sent after the name
     * (compared by reference). [saving] lasts through both.
     */
    data class NeedsName(
        val server: String,
        val saving: Boolean = false,
        val failed: Boolean = false,
        val suggested: String? = null,
        val photo: ByteArray? = null,
    ) : ServerSignInState

    /** Kept; [photoFailed]: the name was saved and the picture chosen with it wasn't. */
    data class Done(val account: AgentConnection, val photoFailed: Boolean = false) : ServerSignInState

    data class Failed(val server: String?, val reason: ServerAuthException.Reason) : ServerSignInState
}

/** The server this sign-in is for; null once done, or when it failed before it had one. */
val ServerSignInState.server: String? get() = when (this) {
    is ServerSignInState.Checking -> server.takeIf { it.isNotEmpty() }
    is ServerSignInState.Ready -> server
    is ServerSignInState.InBrowser -> server
    is ServerSignInState.Finishing -> server
    is ServerSignInState.NeedsName -> server
    is ServerSignInState.Done -> null
    is ServerSignInState.Failed -> server
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

    /** A new member's profile as the server suggests it: the name shown, the email saved with theirs. */
    private var suggestion: ProfileSuggestion? = null
    private var job: Job? = null
    private var reported = false

    /** Where [startWith] gets its token, kept for [retry]. */
    private var tokenSource: (suspend (AgentOrigin) -> Pair<OAuthGrant, OAuthCredential>)? = null

    /**
     * [replacing] is signed in but has no profile on its server yet (the
     * profile gate): asks for the name with the token it has, no browser,
     * from the server's suggestion when it can be read.
     */
    fun onboard(address: String) {
        val parsed = try {
            ServerAuthClient.parseAddress(address)
        } catch (e: ServerAuthException) {
            mutableState.value = ServerSignInState.Failed(null, e.reason)
            return
        }
        origin = parsed
        mutableState.value = ServerSignInState.Finishing(address)
        job?.cancel()
        job = scope.launch {
            suggestion = try {
                replacing?.let { id -> connections.credentials(id)?.let { connections.bearer(id, it) } }?.let { auth.suggestedProfile(parsed, it) }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                null
            }
            mutableState.value = ServerSignInState.NeedsName(address, suggested = suggestion?.name)
        }
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
        run(server) { signedIn(pending.origin, auth.complete(pending, uri)) }
    }

    /**
     * Signs in to [address] with a token got without a browser: a Happy
     * Cloud server's, from the account ([CloudAccount.serverToken]). Then as
     * after the browser: checked with the server, a name if new, kept.
     */
    fun startWith(address: String, token: suspend (AgentOrigin) -> Pair<OAuthGrant, OAuthCredential>) {
        tokenSource = token
        val parsed = try {
            ServerAuthClient.parseAddress(address)
        } catch (e: ServerAuthException) {
            mutableState.value = ServerSignInState.Failed(null, e.reason)
            return
        }
        origin = parsed
        mutableState.value = ServerSignInState.Finishing(parsed.value)
        run(parsed.value) { signedIn(parsed, token(parsed)) }
    }

    /** A grant for [origin] in hand: checked with the server, then kept, or a new member asked for a name first. */
    private suspend fun signedIn(origin: AgentOrigin, signedIn: Pair<OAuthGrant, OAuthCredential>) {
        grant = signedIn
        verified = false
        val (authenticated, userId) = auth.check(origin, signedIn.first.access.value)
        if (!authenticated) throw ServerAuthException(ServerAuthException.Reason.Rejected)
        member = userId
        if (userId != null) return finish()
        // A new member: checked before the name, so none is saved on another server, unless health is behind the profile gate too.
        verify(origin, signedIn.first.access.value, beforeProfile = true)
        suggestion = auth.suggestedProfile(origin, signedIn.first.access.value)
        mutableState.value = ServerSignInState.NeedsName(origin.value, suggested = suggestion?.name)
    }

    /** [jpeg], a prepared picture, as the new member's: sent once their name is. */
    fun choosePhoto(jpeg: ByteArray) {
        val asking = mutableState.value as? ServerSignInState.NeedsName ?: return
        if (!asking.saving) mutableState.value = asking.copy(photo = jpeg)
    }

    /**
     * A new member's name, with the email the server suggested, saved
     * before the server is kept; then the picture they chose, if any, as
     * the daemon takes nothing else before the name. A picture that doesn't
     * go up doesn't keep them out ([ServerSignInState.Done.photoFailed]).
     */
    fun submitName(name: String) {
        val origin = origin ?: return
        val asking = mutableState.value as? ServerSignInState.NeedsName ?: return
        if (asking.saving) return
        val granted = grant?.first?.access
        if (granted == null && replacing == null) return
        val trimmed = name.trim().takeIf { it.isNotEmpty() } ?: return
        val email = suggestion?.email
        mutableState.value = asking.copy(saving = true, failed = false)
        job = scope.launch {
            var token = ""
            // The access token expired while the person typed: refreshed once, and sent again.
            suspend fun send(request: suspend (String) -> Unit) {
                try {
                    request(token)
                } catch (e: ServerAuthException) {
                    if (e.reason != ServerAuthException.Reason.SignInRequired) throw e
                    token = renewed(token) ?: throw e
                    request(token)
                }
            }
            try {
                token = granted?.value ?: replacing?.let { id ->
                    connections.bearer(id, connections.credentials(id) ?: throw ServerAuthException(ServerAuthException.Reason.SignInRequired))
                }!!
                send { auth.saveName(origin, it, trimmed, email) }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                mutableState.value = asking.copy(saving = false, failed = true)
                return@launch
            }
            val photoFailed = asking.photo?.let { jpeg ->
                try {
                    send { auth.savePhoto(origin, it, jpeg) }
                    false
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    true
                }
            } ?: false
            try {
                finish(photoFailed)
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
        tokenSource?.let { return startWith(origin.value, it) }
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

    private suspend fun finish(photoFailed: Boolean = false) {
        val origin = origin ?: return
        val onboarded = replacing.takeIf { grant == null }
        if (onboarded != null) {
            // Onboarded with the token it had: the connection goes on as it was.
            connections.update(onboarded) { it.copy(signInRequired = false, profileRequired = false) }
            connections.accounts.value.firstOrNull { it.id == onboarded }?.let { mutableState.value = ServerSignInState.Done(it, photoFailed) }
            return
        }
        val (granted, credential) = grant ?: return
        if (!verified) verify(origin, granted.access.value)
        // Kept as this member's: another's connection on this server is never reused.
        val userId = member ?: auth.check(origin, granted.access.value).let { (authenticated, userId) -> userId.takeIf { authenticated } }
            ?: throw ServerAuthException(ServerAuthException.Reason.Rejected)
        val account = connections.addServer(origin, credential.copy(userId = userId), granted.access, fallbackName = HappyCloud.handle(origin.value) ?: origin.host, replacing = replacing)
        grant = null
        mutableState.value = ServerSignInState.Done(account, photoFailed)
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
        /** [REDIRECT_URI]'s scheme, which an Auth Tab hands back to the app. */
        const val REDIRECT_SCHEME = "happy"

        fun isRedirect(uri: String): Boolean = uri.substringBefore('?').substringBefore('#') == REDIRECT_URI
    }
}
