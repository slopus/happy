package com.slopus.happy.payments

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.revenuecat.purchases.CustomerInfo
import com.revenuecat.purchases.models.StoreTransaction
import com.revenuecat.purchases.ui.revenuecatui.CustomVariableValue
import com.revenuecat.purchases.ui.revenuecatui.PaywallDialog
import com.revenuecat.purchases.ui.revenuecatui.PaywallDialogOptions
import com.revenuecat.purchases.ui.revenuecatui.PaywallListener

/**
 * RevenueCat's native full-screen paywall on phones, dialog on tablets.
 * The vendor owns its layout; the host forwards RN's current offering and
 * custom `flow` variable. Removing the request dismisses it on logout/server
 * changes. Recreation cancels the pending presentation like other app dialogs.
 */
@Composable
fun PaywallHost(repository: PurchasesRepository) {
    DisposableEffect(repository) {
        val detach = repository.attachHost()
        onDispose { detach() }
    }
    val request by repository.request.collectAsStateWithLifecycle()
    request?.let { pending ->
        key(pending) {
            val options = remember(pending) {
                PaywallDialogOptions.Builder()
                    .setDismissRequest { pending.complete(PurchasesRepository.Cancelled) }
                    .setCustomVariables(pending.flow?.let { mapOf("flow" to CustomVariableValue.String(it)) } ?: emptyMap())
                    .setListener(object : PaywallListener {
                        override fun onPurchaseCompleted(customerInfo: CustomerInfo, storeTransaction: StoreTransaction) {
                            pending.complete(PaywallOutcome(success = true, purchased = true), customerInfo.toPurchases())
                        }

                        override fun onRestoreCompleted(customerInfo: CustomerInfo) {
                            pending.complete(PaywallOutcome(success = true, purchased = true), customerInfo.toPurchases())
                        }
                    })
                    .build()
            }
            PaywallDialog(options)
        }
    }
}