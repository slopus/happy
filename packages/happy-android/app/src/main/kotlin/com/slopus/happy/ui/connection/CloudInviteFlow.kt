package com.slopus.happy.ui.connection

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.slopus.happy.connection.CloudAccountState
import com.slopus.happy.connection.CloudException
import com.slopus.happy.connection.CloudInvite
import com.slopus.happy.connection.CloudInviteException
import com.slopus.happy.connection.CloudInviteLink
import com.slopus.happy.connection.CloudInvitePreview
import com.slopus.happy.connection.CloudInviteRefusal
import com.slopus.happy.connection.CloudInviteService
import com.slopus.happy.connection.CloudServer
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/** Where an invite's Join screen stands. */
sealed interface CloudInviteStep {
    data object Loading : CloudInviteStep

    /** The preview couldn't be had (offline, the service down): Try again. */
    data class Unloaded(val reason: CloudException.Reason) : CloudInviteStep

    /** The offer: the server, who invited and the role. [joining] while the accept runs, [failure] when the last one failed for no reason the invite gives. */
    data class Ready(val preview: CloudInvitePreview, val joining: Boolean = false, val failure: CloudException.Reason? = null) : CloudInviteStep

    /** The invite can't be used, and says why; [preview] when it was read before the accept refused it. */
    data class Refused(val refusal: CloudInviteRefusal, val preview: CloudInvitePreview? = null) : CloudInviteStep

    /** Accepted: the account is on [server] now. */
    data class Joined(val server: CloudServer) : CloudInviteStep
}

/**
 * One invite link, from its preview to its accept, by the state machine
 * every Happy client shares:
 *
 * - a link with no usable token ([CloudInviteLink.Malformed]) is
 *   [CloudInviteStep.Refused] as unknown at once, and nothing is asked;
 * - [CloudInviteStep.Loading] previews it with no session: refused,
 *   [CloudInviteStep.Refused]; out of reach, [CloudInviteStep.Unloaded],
 *   whose Try again is [load];
 * - [CloudInviteStep.Ready] offers it, before any sign-in. [join] accepts
 *   when the account is signed in; signed out it asks for the sign-in, and
 *   that press is the consent: the accept follows the sign-in by itself. A
 *   sign-in given up ([signInGivenUp]) leaves the offer, and a later
 *   sign-in accepts nothing;
 * - the accept: joined, [CloudInviteStep.Joined]; refused,
 *   [CloudInviteStep.Refused] (another address's can [signInAgain]); the
 *   session gone (401), the offer again, signed out, to be pressed again;
 *   out of reach, the offer with its failure, whose Try again is [join].
 *
 * Nothing is accepted without a press on [join] or [signInAgain]. The
 * token is held here only.
 */
class CloudInviteFlow(private val link: CloudInviteLink, private val service: CloudInviteService, private val scope: CoroutineScope) {
    private val invite = link as? CloudInvite

    var step by mutableStateOf<CloudInviteStep>(if (invite == null) CloudInviteStep.Refused(CloudInviteRefusal.Unknown) else CloudInviteStep.Loading)
        private set

    /** Join was pressed signed out: accept once the account signs in. */
    private var joinAfterSignIn = false
    private var work: Job? = null

    init {
        load()
        scope.launch {
            service.state.collect { state ->
                if (state == CloudAccountState.SignedIn && joinAfterSignIn) {
                    joinAfterSignIn = false
                    (step as? CloudInviteStep.Ready)?.let { accept(it.preview) }
                }
            }
        }
    }

    fun load() {
        val invite = invite ?: return
        work?.cancel()
        step = CloudInviteStep.Loading
        work = scope.launch {
            step = try {
                CloudInviteStep.Ready(service.previewInvite(invite))
            } catch (e: CancellationException) {
                throw e
            } catch (e: CloudInviteException) {
                CloudInviteStep.Refused(e.refusal)
            } catch (e: CloudException) {
                CloudInviteStep.Unloaded(e.reason)
            }
        }
    }

    /** Join, and Try again after an accept that couldn't be asked: accepts now when signed in; otherwise [onSignIn], and the accept follows the sign-in. */
    fun join(onSignIn: () -> Unit) {
        val ready = step as? CloudInviteStep.Ready ?: return
        if (ready.joining) return
        if (service.state.value != CloudAccountState.SignedIn) {
            joinAfterSignIn = true
            onSignIn()
            return
        }
        accept(ready.preview)
    }

    /** The invite was another address's: sign in again ([onSignIn], after the caller signs the account out), then accept. */
    fun signInAgain(onSignIn: () -> Unit) {
        val preview = (step as? CloudInviteStep.Refused)?.preview
        if (preview != null) step = CloudInviteStep.Ready(preview) else load()
        joinAfterSignIn = true
        onSignIn()
    }

    /**
     * The sign-in [join] or [signInAgain] asked for ended without one (the
     * person came back from it): the offer stands, signed out, and the
     * press that asked is spent, so a sign-in made later accepts nothing.
     */
    fun signInGivenUp() {
        if (service.state.value != CloudAccountState.SignedIn) joinAfterSignIn = false
    }

    private fun accept(preview: CloudInvitePreview) {
        val invite = invite ?: return
        work?.cancel()
        step = CloudInviteStep.Ready(preview, joining = true)
        work = scope.launch {
            step = try {
                CloudInviteStep.Joined(service.acceptInvite(invite))
            } catch (e: CancellationException) {
                throw e
            } catch (e: CloudInviteException) {
                CloudInviteStep.Refused(e.refusal, preview)
            } catch (e: CloudException) {
                // The session gone on the way (a 401) is the offer again, signed out: Sign in to join is pressed anew.
                CloudInviteStep.Ready(preview, failure = e.reason)
            }
        }
    }
}

/**
 * The invite link that came in, waiting for its screen to take it: in
 * memory only, never in a route or saved state, so it never outlives the
 * process.
 */
object CloudInvites {
    private val inbox = MutableStateFlow<CloudInviteLink?>(null)
    val pending: StateFlow<CloudInviteLink?> get() = inbox

    fun offer(invite: CloudInviteLink) {
        inbox.value = invite
    }

    fun take(): CloudInviteLink? = inbox.value.also { inbox.value = null }
}
