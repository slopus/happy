package com.slopus.happy.payments

import kotlinx.serialization.Serializable

/** purchases.ts: the flat purchase state, including inactive entitlements. */
@Serializable
data class Purchases(
    val activeSubscriptions: List<String> = emptyList(),
    val entitlements: Map<String, Boolean> = emptyMap(),
)

/** sync.ts presentPaywall: cancellation succeeds without a purchase; restore counts as purchased. */
data class PaywallOutcome(val success: Boolean, val purchased: Boolean = false, val error: String? = null)

interface Paywall {
    suspend fun present(flow: String?): PaywallOutcome
    fun hasPro(): Boolean
}

/** Server URL scopes local state; RevenueCat's appUserID is the server-issued JWT subject only. */
data class PurchaseAccount(val serverUrl: String, val appUserId: String)

/** Native SDK boundary, kept separate so account isolation can be tested without Play Billing. */
interface PurchasesClient {
    val enabled: Boolean
    suspend fun identify(appUserId: String)
    suspend fun canPresent(): Boolean
    suspend fun refresh(): Purchases
    suspend fun logout()
}

interface PurchasesCache {
    fun load(account: PurchaseAccount): Purchases
    fun save(account: PurchaseAccount, purchases: Purchases)
    fun clear()
}