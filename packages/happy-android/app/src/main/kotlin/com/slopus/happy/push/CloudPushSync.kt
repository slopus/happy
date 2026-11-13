package com.slopus.happy.push

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Foreground/native-token/network triggers; never requests OS permission or runs a polling timer. */
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
) {
    private data class Trigger(val sequence: Long, val native: Boolean = false)
    private val revision = MutableStateFlow(Trigger(0))
    private var handledNative = -1L
    private var work: Job? = null
    private var nativeToken: String? = null
    private var wrapper: HappyPushToken? = null

    /** Call after cold start. Repeated calls keep one set of collectors. */
    @Synchronized fun start(scope: CoroutineScope) {
        if (work?.isActive == true) return
        work = scope.launch(dispatcher) {
            coroutineScope {
                launch {
                    networkReturns.collect {
                        for (account in accounts.value) client(account)?.let { client -> attempt { registrations.cleanup(account, client) } }
                        refresh()
                    }
                }
                launch {
                    accounts.collect { current ->
                        attempt {
                            for (gone in registrations.accounts().filterNot { it in current }) registrations.remove(gone, null)
                        }
                    }
                }
                combine(accounts, foreground, revision) { current, front, changed -> Triple(current, front, changed) }
                    .collectLatest { (current, front, trigger) ->
                        val nativeChange = trigger.native && trigger.sequence > handledNative
                        if ((!front && !nativeChange) || current.isEmpty()) return@collectLatest
                        if (nativeChange) handledNative = trigger.sequence
                        // Authenticated cleanup does not depend on OS notification permission.
                        for (account in current) client(account)?.let { client -> attempt { registrations.cleanup(account, client) } }
                        if (!notificationsAllowed()) {
                            for (account in current) client(account)?.let { client -> attempt { registrations.remove(account, client) } }
                            return@collectLatest
                        }
                        val token = try {
                            val native = deviceTokens.token() ?: return@collectLatest
                            if (native != nativeToken || wrapper == null) {
                                wrapper = exchange(native)
                                nativeToken = native
                            }
                            requireNotNull(wrapper)
                        } catch (e: CancellationException) {
                            throw e
                        } catch (_: Exception) {
                            return@collectLatest
                        }
                        for (account in current) client(account)?.let { client ->
                            attempt { if (registrations.register(account, client, token, appId, locale())) registered(account) }
                        }
                    }
            }
        }
    }

    /** Native token changed, permission was explicitly granted, or connectivity returned. */
    fun refresh(native: Boolean = false) { revision.update { Trigger(it.sequence + 1, native) } }

    private fun client(account: CloudPushAccount): CloudPushApi? = try { api(account) }
    catch (e: CancellationException) { throw e }
    catch (_: Exception) { null }

    private suspend fun attempt(action: suspend () -> Unit) {
        try { action() } catch (e: CancellationException) { throw e } catch (_: Exception) { /* Retry on the next authorized trigger, without credential-bearing logs. */ }
    }
}