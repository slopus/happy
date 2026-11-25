package com.slopus.happy.push

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Foreground/native-token/network triggers; never requests OS permission.
 * The one timer is a farewell's: while a forgotten pairing's daemon has not
 * answered, it is asked again, further and further apart.
 */
class CloudPushSync(
    private val accounts: StateFlow<List<CloudPushAccount>>,
    private val foreground: StateFlow<Boolean>,
    private val networkReturns: Flow<Unit>,
    private val registrations: CloudPushRegistrations,
    private val api: (CloudPushAccount) -> CloudPushApi?,
    private val deviceTokens: DevicePushTokenSource,
    private val exchange: suspend (String) -> HappyPushToken,
    private val notificationsAllowed: () -> Boolean,
    private val appId: String,
    private val locale: () -> String,
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO,
    /** Each registration the server took: onboarding's mobileApp gate is done by it. */
    private val registered: (CloudPushAccount) -> Unit = {},
    /** A forgotten pairing's own way to its daemon, made for one farewell; none means farewells stay queued. */
    private val farewell: ((CloudPushFarewellRoute) -> CloudPushFarewellLink)? = null,
) {
    private data class Trigger(val sequence: Long, val native: Boolean = false)
    private val revision = MutableStateFlow(Trigger(0))
    private val farewells = MutableStateFlow(0L)
    private var handledNative = -1L
    private var work: Job? = null
    @Volatile private var nativeToken: String? = null
    @Volatile private var wrapper: HappyPushToken? = null
    @Volatile private var wrapped: String? = null

    /** What a registration is sent with now: the relay capability for this device's token, exchanged once per token. Null without one. */
    suspend fun renewal(): CloudPushRenewal? = try {
        deviceTokens.token()?.let { native ->
            if (native != nativeToken || wrapper == null) {
                val exchanged = exchange(native)
                wrapper = exchanged
                wrapped = exchanged.value
                nativeToken = native
            }
            wrapped?.let { CloudPushRenewal(it, appId, locale()) }
        }
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        null
    }

    /** Call after cold start. Repeated calls keep one set of collectors. */
    @Synchronized fun start(scope: CoroutineScope) {
        if (work?.isActive == true) return
        work = scope.launch(dispatcher) {
            coroutineScope {
                launch {
                    networkReturns.collect {
                        for (account in accounts.value) client(account)?.let { client -> attempt { registrations.cleanup(account, client, ::renewal) } }
                        retire()
                        refresh()
                    }
                }
                launch {
                    // What a forgotten pairing still owes its daemon: asked at the start, when the app or the network
                    // comes back and when a connection is forgotten, then after 2, 4, 8 … seconds, at most five minutes.
                    combine(farewells, foreground) { _, _ -> }.collectLatest {
                        var wait = FAREWELL_FIRST_WAIT
                        while (owed()) {
                            delay(wait)
                            wait = (wait * 2).coerceAtMost(FAREWELL_LONGEST_WAIT)
                        }
                    }
                }
                launch {
                    accounts.collect { current ->
                        attempt {
                            for (gone in registrations.accounts().filterNot { it in current }) registrations.remove(gone, null, ::renewal)
                        }
                        // A connection forgotten while its registration was in flight is only queued here.
                        retire()
                    }
                }
                combine(accounts, foreground, revision) { current, front, changed -> Triple(current, front, changed) }
                    .collectLatest { (current, front, trigger) ->
                        val nativeChange = trigger.native && trigger.sequence > handledNative
                        if ((!front && !nativeChange) || current.isEmpty()) return@collectLatest
                        if (nativeChange) handledNative = trigger.sequence
                        // Authenticated cleanup does not depend on OS notification permission.
                        for (account in current) client(account)?.let { client -> attempt { registrations.cleanup(account, client, ::renewal) } }
                        if (!notificationsAllowed()) {
                            for (account in current) client(account)?.let { client -> attempt { registrations.remove(account, client, ::renewal) } }
                            return@collectLatest
                        }
                        renewal() ?: return@collectLatest
                        val token = wrapper ?: return@collectLatest
                        for (account in current) client(account)?.let { client ->
                            // Not taken may be "its connection went meanwhile": that registration is then a farewell owed.
                            attempt { if (registrations.register(account, client, token, appId, locale())) registered(account) else retire() }
                        }
                    }
            }
        }
    }

    /** A connection was just forgotten: its farewell is asked now. */
    fun retire() { farewells.update { it + 1 } }

    private suspend fun owed(): Boolean = try { farewell?.let { registrations.retire(it) } ?: false }
    catch (e: CancellationException) { throw e }
    catch (_: Exception) { false }

    /** Native token changed, permission was explicitly granted, or connectivity returned. */
    fun refresh(native: Boolean = false) { revision.update { Trigger(it.sequence + 1, native) } }

    private fun client(account: CloudPushAccount): CloudPushApi? = try { api(account) }
    catch (e: CancellationException) { throw e }
    catch (_: Exception) { null }

    private companion object {
        const val FAREWELL_FIRST_WAIT = 2_000L
        const val FAREWELL_LONGEST_WAIT = 300_000L
    }

    private suspend fun attempt(action: suspend () -> Unit) {
        try { action() } catch (e: CancellationException) { throw e } catch (_: Exception) { /* Retry on the next authorized trigger, without credential-bearing logs. */ }
    }
}