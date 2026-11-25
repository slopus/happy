package com.slopus.happy.agent

import androidx.compose.runtime.Immutable
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** What Settings › Provider accounts shows. */
@Immutable
sealed interface ProviderAccountsState {
    data object Loading : ProviderAccountsState
    data class Loaded(val accounts: List<ProviderAccount>) : ProviderAccountsState
    /** The first read failed; a later one that works replaces it. */
    data object Failed : ProviderAccountsState
}

/**
 * One connection's provider accounts and their sign-ins, shared by the
 * accounts page and a sign-in page. The accounts are read while a page
 * follows them ([follow]): at once, on `config.updated` and on every
 * reconnect, each account's sign-in object with them. Every
 * `provider_sign_in.updated` and every answer replaces an account's object
 * only with a greater version. A `403 forbidden` is remembered
 * ([ownerOnly]): the agent has no other way to say the person isn't the
 * team owner.
 */
class ProviderAccounts(
    private val backend: ProviderSignInBackend,
    events: SharedFlow<AgentEvent>,
    private val scope: CoroutineScope,
) {
    private val accountsState = MutableStateFlow<ProviderAccountsState>(ProviderAccountsState.Loading)
    val accounts: StateFlow<ProviderAccountsState> = accountsState.asStateFlow()

    private val objects = MutableStateFlow<Map<String, ProviderSignIn>>(emptyMap())
    /** Each account's sign-in object, by account id. */
    val signIns: StateFlow<Map<String, ProviderSignIn>> = objects.asStateFlow()

    private val ownerOnlyState = MutableStateFlow(false)
    /** The agent refused a change as the team owner's alone; changes stay off for as long as the session lives. */
    val ownerOnly: StateFlow<Boolean> = ownerOnlyState.asStateFlow()

    private val lock = Any()
    private var followers = 0
    /** At most one read waits while another runs. */
    private val asked = Channel<Unit>(Channel.CONFLATED)

    init {
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            events.collect { event ->
                ProviderSignIns.updated(event)?.let(::keep)
                if (ProviderSignIns.changes(event) && following()) refresh()
            }
        }
        scope.launch { for (ask in asked) load() }
    }

    /** Reads now and on every change until the returned handle is closed. */
    fun follow(): AutoCloseable {
        synchronized(lock) { followers += 1 }
        refresh()
        var closed = false
        return AutoCloseable {
            synchronized(lock) {
                if (!closed) followers -= 1
                closed = true
            }
        }
    }

    fun refresh() {
        asked.trySend(Unit)
    }

    private fun following() = synchronized(lock) { followers > 0 }

    /** Keeps [signIn] where it is newer than the account's object. */
    fun keep(signIn: ProviderSignIn) {
        objects.update { held -> if (signIn.newerThan(held[signIn.providerId])) held + (signIn.providerId to signIn) else held }
    }

    private suspend fun load() {
        val accounts = try {
            backend.accounts()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            if (accountsState.value !is ProviderAccountsState.Loaded) accountsState.value = ProviderAccountsState.Failed
            return
        }
        accountsState.value = ProviderAccountsState.Loaded(accounts)
        // Each object asks the vendor's program which account is in (up to ten seconds): side by side, each kept as it comes.
        coroutineScope {
            accounts.map { account ->
                async {
                    try {
                        keep(backend.read(account.id))
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {
                    }
                }
            }.awaitAll()
        }
    }

    /** One account's object, read again (a page back from the browser). */
    suspend fun reread(providerId: String) {
        try {
            keep(backend.read(providerId))
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
        }
    }

    suspend fun start(providerId: String, method: String?): ProviderSignIn = write { backend.start(providerId, method) }

    suspend fun sendCode(providerId: String, code: String): ProviderSignIn = write { backend.sendCode(providerId, code) }

    suspend fun cancel(providerId: String): ProviderSignIn = write { backend.cancel(providerId) }

    suspend fun saveToken(providerId: String, token: String): ProviderSignIn = write { backend.saveToken(providerId, token) }

    private suspend fun write(action: suspend () -> ProviderSignIn): ProviderSignIn = try {
        action().also(::keep)
    } catch (e: ProviderSignInException) {
        if (e.refusal == ProviderSignInRefusal.Forbidden) ownerOnlyState.value = true
        e.current?.let(::keep)
        throw e
    }
}

/** Where one sign-in stands, as its page shows it. */
@Immutable
sealed interface SignInStep {
    /** Asked for, before the vendor's page is known. */
    data object Starting : SignInStep

    /** A device code to enter at [url]. */
    data class Device(val url: String, val userCode: String?) : SignInStep

    /** Claude's page, whose code is pasted back; [checking] once it went. */
    data class PasteCode(val url: String, val checking: Boolean) : SignInStep

    /** A Codex or Grok browser sign-in someone started elsewhere: it finishes only on the agent's computer. */
    data class OnComputer(val url: String) : SignInStep

    data class Done(val email: String?, val plan: String?) : SignInStep

    data class Failed(val failure: SignInFailure, val said: String?) : SignInStep

    data object Cancelled : SignInStep

    val unfinished: Boolean get() = this is Starting || this is Device || this is PasteCode || this is OnComputer

    companion object {
        /**
         * [signIn]'s step for the operation this page started ([operationId]);
         * an older operation's result, still on the object, is not this
         * sign-in's: it starts. [codeSent]: a pasted code went, so a running
         * operation is checking it.
         */
        fun of(signIn: ProviderSignIn?, operationId: String?, codeSent: Boolean): SignInStep {
            val operation = signIn?.operation?.takeIf { operationId != null && it.id == operationId } ?: return Starting
            val authorization = operation.authorization
            return when (operation.status) {
                SignInOperation.Status.Succeeded -> Done(signIn.email, signIn.plan)
                SignInOperation.Status.Cancelled -> Cancelled
                SignInOperation.Status.Failed -> Failed(SignInFailure.of(operation.errorCode), operation.errorMessage)
                SignInOperation.Status.Running, SignInOperation.Status.Waiting -> when {
                    authorization == null -> Starting
                    authorization.acceptsCode -> PasteCode(authorization.url, checking = codeSent || operation.status == SignInOperation.Status.Running)
                    authorization.method == ProviderSignIns.BROWSER -> OnComputer(authorization.url)
                    else -> Device(authorization.url, authorization.userCode)
                }
            }
        }
    }
}

/** Why a sign-in didn't go, as its title says it. */
enum class SignInFailure {
    Failed,
    Expired,

    /** The vendor signed in, but the agent couldn't save it: the account keeps its earlier login. */
    SaveFailed,
    NotInstalled,
    OwnerOnly;

    companion object {
        fun of(code: String?): SignInFailure = when (code) {
            "expired" -> Expired
            "save_failed" -> SaveFailed
            else -> Failed
        }

        fun of(refusal: ProviderSignInRefusal): SignInFailure = when (refusal) {
            ProviderSignInRefusal.Forbidden -> OwnerOnly
            ProviderSignInRefusal.NotInstalled -> NotInstalled
            else -> Failed
        }
    }
}

/**
 * One sign-in from its start to its end: started (or joined) with the
 * phone's method, then followed through the account's object. Closed while
 * unfinished, it is cancelled on the agent.
 */
class ProviderSignInRun(
    private val accounts: ProviderAccounts,
    val providerId: String,
    private val scope: CoroutineScope,
    /** Where closing's cancel is sent from: it outlives [scope], which goes with the page. */
    private val leaving: CoroutineScope = LEAVING,
) {
    private val operationState = MutableStateFlow<String?>(null)
    private val codeSentState = MutableStateFlow(false)
    private val refusedState = MutableStateFlow<SignInStep.Failed?>(null)

    /** Where it stands: a refusal of this page's own, else what the account's object says of its operation. */
    val step: StateFlow<SignInStep> = combine(accounts.signIns, operationState, codeSentState, refusedState) { objects, operation, sent, refused ->
        refused ?: SignInStep.of(objects[providerId], operation, sent)
    }.stateIn(scope, SharingStarted.Eagerly, SignInStep.Starting)

    private var method: String? = null

    /** Starts it with [method] (the phone's for the account), or joins the one running. */
    fun start(method: String?) {
        this.method = method
        refusedState.value = null
        codeSentState.value = false
        operationState.value = null
        scope.launch {
            try {
                operationState.value = accounts.start(providerId, method).operation?.id
            } catch (e: CancellationException) {
                throw e
            } catch (e: ProviderSignInException) {
                refusedState.value = SignInStep.Failed(SignInFailure.of(e.refusal), e.said)
            } catch (_: Exception) {
                refusedState.value = SignInStep.Failed(SignInFailure.Failed, null)
            }
        }
    }

    /** Starts again after it ended, the same way. */
    fun restart() = start(method)

    /** Claude's pasted code; what comes of it arrives on the object. */
    fun sendCode(code: String) {
        if (code.isBlank() || codeSentState.value) return
        codeSentState.value = true
        scope.launch {
            try {
                accounts.sendCode(providerId, code)
            } catch (e: CancellationException) {
                throw e
            } catch (e: ProviderSignInException) {
                // Not waiting for a code any more: what the object says next shows.
                if (e.refusal != ProviderSignInRefusal.Conflict) refusedState.value = SignInStep.Failed(SignInFailure.of(e.refusal), e.said)
                codeSentState.value = false
            } catch (_: Exception) {
                codeSentState.value = false
            }
        }
    }

    /** Cancels it on the agent; the page leaves once the object says so. */
    fun cancel() {
        scope.launch {
            try {
                accounts.cancel(providerId)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
            }
        }
    }

    /** Leaves it: one not yet finished is cancelled on the agent. */
    fun close() {
        if (operationState.value == null || !step.value.unfinished) return
        leaving.launch {
            try {
                accounts.cancel(providerId)
            } catch (e: Exception) {
                android.util.Log.w("ProviderSignIn", "Couldn't cancel a sign-in: ${e.javaClass.simpleName}")
            }
        }
    }

    private companion object {
        val LEAVING = CoroutineScope(kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.IO)
    }
}
