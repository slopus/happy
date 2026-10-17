package com.slopus.happy.payments

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.revenuecat.purchases.CustomerInfo
import com.revenuecat.purchases.EntitlementInfo
import com.revenuecat.purchases.EntitlementInfos
import com.revenuecat.purchases.OwnershipType
import com.revenuecat.purchases.PeriodType
import com.revenuecat.purchases.Store
import com.revenuecat.purchases.VerificationResult
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.Date

@RunWith(RobolectricTestRunner::class)
class PurchasesMappingTest {
    @Test fun customerInfoUsesProductIdsAndKeepsInactiveEntitlements() {
        val now = Date()
        fun entitlement(id: String, active: Boolean) = EntitlementInfo(
            identifier = id, isActive = active, willRenew = active, periodType = PeriodType.NORMAL,
            latestPurchaseDate = now, originalPurchaseDate = now, expirationDate = null,
            store = Store.PLAY_STORE, productIdentifier = "happy", productPlanIdentifier = "monthly",
            isSandbox = true, unsubscribeDetectedAt = null, billingIssueDetectedAt = null,
            ownershipType = OwnershipType.PURCHASED, jsonObject = JSONObject(),
            verification = VerificationResult.NOT_REQUESTED,
        )
        val customerInfo = CustomerInfo(
            entitlements = EntitlementInfos(mapOf("pro" to entitlement("pro", true), "expired" to entitlement("expired", false)), VerificationResult.NOT_REQUESTED),
            allExpirationDatesByProduct = mapOf("happy:monthly" to Date(now.time + 60_000), "old:yearly" to Date(now.time - 60_000)),
            allPurchaseDatesByProduct = mapOf("happy:monthly" to now, "old:yearly" to now),
            requestDate = now, schemaVersion = 3, firstSeen = now, originalAppUserId = "account",
            managementURL = null, originalPurchaseDate = now, jsonObject = JSONObject().put("subscriber", JSONObject()),
        )
        assertEquals(Purchases(listOf("happy:monthly"), mapOf("pro" to true, "expired" to false)), customerInfo.toPurchases())
    }

    @Test fun persistedStateIsScopedToServerAndAccountAndWipedOnLogout() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val prefs = context.getSharedPreferences("purchase-cache-test", Context.MODE_PRIVATE)
        val account = PurchaseAccount("https://one", "user")
        val info = Purchases(listOf("happy:monthly"), mapOf("pro" to true))
        val cache = PreferencesPurchasesCache(prefs)
        cache.clear()
        cache.save(account, info)
        assertEquals(info, PreferencesPurchasesCache(prefs).load(account))
        assertEquals(Purchases(), cache.load(account.copy(appUserId = "other")))
        assertEquals(Purchases(), cache.load(account.copy(serverUrl = "https://two")))
        cache.clear()
        assertEquals(Purchases(), cache.load(account))
    }

    @Test fun invalidCacheDoesNotBlockSignIn() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val prefs = context.getSharedPreferences("invalid-purchase-cache-test", Context.MODE_PRIVATE)
        prefs.edit().putString("purchases", "{invalid").commit()
        assertEquals(Purchases(), PreferencesPurchasesCache(prefs).load(PurchaseAccount("https://one", "user")))
    }
}