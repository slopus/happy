package com.slopus.happy.payments

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/** One presentation, scoped to the account generation that requested it. */
class PaywallRequest internal constructor(val flow: String?) {
    internal data class Result(val outcome: PaywallOutcome, val purchases: Purchases?)
    internal val result = CompletableDeferred<Result>()

    fun complete(outcome: PaywallOutcome, purchases: Purchases? = null) {
        result.complete(Result(outcome, purchases))
    }
}

/**
 * sync.ts's optional purchases lifecycle. SDK identity changes and refreshes
 * serialize with presentations. Account changes immediately dismiss the UI,
 * clear local entitlements, and invalidate every old callback (including A→B→A).
 * Public presentation methods may be called from any coroutine dispatcher.
 */
class PurchasesRepository(
    private val scope: CoroutineScope,
    private val client: PurchasesClient,
    private val cache: PurchasesCache? = null,
    private val currentAccount: (() -> PurchaseAccount?)? = null,
) : Paywall {
    private class Session(val account: PurchaseAccount)
    private val guard = Any()
    private val operations = Mutex()
    private val presentations = Mutex()
    private var session: Session? = null
    private var firstAccount = true
    private var hosts = 0
    private val mutablePurchases = MutableStateFlow(Purchases())
    val purchases: StateFlow<Purchases> = mutablePurchases.asStateFlow()
    private val mutableRequest = MutableStateFlow<PaywallRequest?>(null)
    val request: StateFlow<PaywallRequest?> = mutableRequest.asStateFlow()

    override fun hasPro(): Boolean {
        reconcileAccount()
        return purchases.value.entitlements["pro"] == true
    }

    /** Called on sign-in, sign-out, token subject changes, and server changes. */
    fun setAccount(account: PurchaseAccount?) {
        val next = synchronized(guard) {
            if (!firstAccount && session?.account == account) return
            mutableRequest.value?.complete(Cancelled)
            mutableRequest.value = null
            val initial = firstAccount
            firstAccount = false
            if (!initial || account == null) cache?.clear()
            session = account?.takeIf { it.appUserId.isNotBlank() }?.let(::Session)
            mutablePurchases.value = if (initial && account != null && client.enabled) cache?.load(account) ?: Purchases() else Purchases()
            session
        }
        if (next != null) refresh()
        else scope.launch {
            operations.withLock {
                if (synchronized(guard) { session == null }) optional { client.logout() }
            }
        }
    }

    /** Startup and foreground refresh, as syncPurchases in sync.ts. Failures keep the last known state. */
    fun refresh() {
        val owner = synchronized(guard) { session } ?: return
        if (!client.enabled) return
        scope.launch {
            operations.withLock {
                if (!isCurrent(owner)) return@withLock
                optional {
                    client.identify(owner.account.appUserId)
                    if (isCurrent(owner)) apply(owner, client.refresh())
                }
            }
        }
    }

    /** The app-level host can render from any screen, including voice's coroutine. */
    fun attachHost(): () -> Unit {
        synchronized(guard) { hosts++ }
        return {
            synchronized(guard) {
                hosts--
                if (hosts == 0) {
                    mutableRequest.value?.complete(Cancelled)
                    mutableRequest.value = null
                }
            }
        }
    }

    suspend fun presentPaywall(flow: String? = null): PaywallOutcome = present(flow)

    override suspend fun present(flow: String?): PaywallOutcome {
        reconcileAccount()
        val owner = synchronized(guard) { session }
        if (owner == null || !client.enabled) return PaywallOutcome(false, error = "RevenueCat not initialized")
        if (!presentations.tryLock()) return PaywallOutcome(false, error = "Paywall already presented")
        try {
            return operations.withLock {
                if (!isCurrent(owner)) return@withLock Cancelled
                try {
                    // Don't release the SDK lock while an uncancellable native login is in flight.
                    withContext(NonCancellable) { client.identify(owner.account.appUserId) }
                    if (!isCurrent(owner)) return@withLock Cancelled
                    if (!withContext(NonCancellable) { client.canPresent() }) {
                        return@withLock PaywallOutcome(false, error = "Failed to present paywall")
                    }
                    val pending = synchronized(guard) {
                        if (!isCurrent(owner)) return@withLock Cancelled
                        if (hosts == 0) return@withLock PaywallOutcome(false, error = "Paywall not available on this platform")
                        PaywallRequest(flow).also { mutableRequest.value = it }
                    }
                    try {
                        val result = pending.result.await()
                        if (!isCurrent(owner)) return@withLock Cancelled
                        result.purchases?.let { apply(owner, it) }
                        if (result.outcome.purchased) optional { apply(owner, client.refresh()) }
                        if (isCurrent(owner)) result.outcome else Cancelled
                    } finally {
                        synchronized(guard) { if (mutableRequest.value === pending) mutableRequest.value = null }
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    PaywallOutcome(false, error = e.message ?: "Failed to present paywall")
                }
            }
        } finally {
            presentations.unlock()
        }
    }

    private fun reconcileAccount() {
        currentAccount?.let { setAccount(it()) }
    }

    private fun isCurrent(owner: Session): Boolean = synchronized(guard) {
        session === owner && (currentAccount == null || currentAccount.invoke() == owner.account)
    }

    private fun apply(owner: Session, values: Purchases) = synchronized(guard) {
        if (isCurrent(owner)) {
            mutablePurchases.value = values
            cache?.save(owner.account, values)
        }
    }

    private suspend fun optional(block: suspend () -> Unit) {
        try {
            // SDK suspend calls don't cancel their underlying login/sync operations.
            // Await their completion before allowing another identity to use the SDK.
            withContext(NonCancellable) { block() }
        } catch (_: Exception) {
            // Purchases are optional; offline/billing failures must not break account sync.
        }
    }

    companion object {
        val Cancelled = PaywallOutcome(success = true)
    }
}