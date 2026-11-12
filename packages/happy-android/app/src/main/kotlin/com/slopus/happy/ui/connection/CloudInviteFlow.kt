package com.slopus.happy.ui.connection

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.slopus.happy.connection.CloudAccountState
import com.slopus.happy.connection.CloudException
import com.slopus.happy.connection.CloudInvite
import com.slopus.happy.connection.CloudInviteException
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

    /** The server and role; [joining] while the accept runs, [failure] when the last one failed for no reason the invite gives. */
    data class Ready(val preview: CloudInvitePreview, val joining: Boolean = false, val failure: CloudException.Reason? = null) : CloudInviteStep

    /** The invite can't be used, and says why; [preview] when it was read before the accept refused it. */
    data class Refused(val refusal: CloudInviteRefusal, val preview: CloudInvitePreview? = null) : CloudInviteStep

    /** Accepted: the account is on [server] now. */
    data class Joined(val server: CloudServer) : CloudInviteStep
}

/**
 * One invite, from its preview to its accept. Join while the account is
 * signed out asks for the sign-in ([onSignIn]) and accepts once it is in,
 * with the same token, which only this object holds.
 */
class CloudInviteFlow(private val invite: CloudInvite, private val service: CloudInviteService, private val scope: CoroutineScope) {
    var step by mutableStateOf<CloudInviteStep>(CloudInviteStep.Loading)
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

    /** Join: accepts now when signed in; otherwise [onSignIn], and the accept follows the sign-in. */
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

    private fun accept(preview: CloudInvitePreview) {
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
                // The pass ran out on the way: sign in again, then the same accept.
                if (e.reason == CloudException.Reason.SignInRequired) joinAfterSignIn = true
                CloudInviteStep.Ready(preview, failure = e.reason)
            }
        }
    }
}

/**
 * The invite a link brought, waiting for its Join screen to take it: in
 * memory only, never in a route or saved state, so it never outlives the
 * process.
 */
object CloudInvites {
    private val inbox = MutableStateFlow<CloudInvite?>(null)
    val pending: StateFlow<CloudInvite?> get() = inbox

    fun offer(invite: CloudInvite) {
        inbox.value = invite
    }

    fun take(): CloudInvite? = inbox.value.also { inbox.value = null }
}
