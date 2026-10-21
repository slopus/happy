package com.slopus.happy.payments

import android.content.Context
import android.content.SharedPreferences
import com.revenuecat.purchases.CustomerInfo
import com.revenuecat.purchases.LogLevel
import com.revenuecat.purchases.Purchases as NativePurchases
import com.revenuecat.purchases.PurchasesConfiguration
import com.revenuecat.purchases.awaitCustomerInfo
import com.revenuecat.purchases.awaitLogIn
import com.revenuecat.purchases.awaitLogOut
import com.revenuecat.purchases.awaitOfferings
import com.revenuecat.purchases.awaitSyncPurchases
import com.slopus.happy.net.HappyJson
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

/** The actual native product ids, and all entitlement active flags (purchases.ts). */
fun CustomerInfo.toPurchases() = Purchases(
    activeSubscriptions = activeSubscriptions.toList(),
    entitlements = entitlements.all.mapValues { (_, entitlement) -> entitlement.isActive },
)

class RevenueCatPurchases(
    private val context: Context,
    private val apiKey: String,
    private val debug: Boolean,
) : PurchasesClient {
    override val enabled: Boolean get() = apiKey.isNotBlank()

    override suspend fun identify(appUserId: String) {
        check(enabled) { "RevenueCat not initialized" }
        require(appUserId.isNotBlank())
        if (!NativePurchases.isConfigured) {
            if (debug) NativePurchases.logLevel = LogLevel.DEBUG
            NativePurchases.configure(PurchasesConfiguration.Builder(context, apiKey).appUserID(appUserId).build())
        } else if (NativePurchases.sharedInstance.appUserID != appUserId) {
            NativePurchases.sharedInstance.awaitLogIn(appUserId)
        }
    }

    override suspend fun refresh(): Purchases {
        val sdk = NativePurchases.sharedInstance
        sdk.awaitSyncPurchases()
        return sdk.awaitCustomerInfo().toPurchases()
    }

    override suspend fun canPresent(): Boolean = NativePurchases.sharedInstance.awaitOfferings().current != null

    override suspend fun logout() {
        if (enabled && NativePurchases.isConfigured && !NativePurchases.sharedInstance.isAnonymous) {
            NativePurchases.sharedInstance.awaitLogOut()
        }
    }
}

/** One account's cached state, scoped by server as well as subject and wiped on logout. */
class PreferencesPurchasesCache(private val prefs: SharedPreferences) : PurchasesCache {
    @Serializable private data class Entry(val account: PurchaseAccountRecord, val purchases: Purchases)
    @Serializable private data class PurchaseAccountRecord(val serverUrl: String, val appUserId: String)

    override fun load(account: PurchaseAccount): Purchases = runCatching {
        val entry = HappyJson.decodeFromString<Entry>(prefs.getString("purchases", null) ?: return Purchases())
        if (entry.account == account.record()) entry.purchases else Purchases()
    }.getOrDefault(Purchases())

    override fun save(account: PurchaseAccount, purchases: Purchases) {
        prefs.edit().putString("purchases", HappyJson.encodeToString(Entry(account.record(), purchases))).apply()
    }

    override fun clear() { prefs.edit().clear().apply() }
    private fun PurchaseAccount.record() = PurchaseAccountRecord(serverUrl, appUserId)

    companion object { const val PREFS_NAME = "purchases" }
}