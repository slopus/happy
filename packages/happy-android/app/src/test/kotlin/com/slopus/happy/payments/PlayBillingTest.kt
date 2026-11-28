package com.slopus.happy.payments

import android.app.Activity
import com.android.billingclient.api.AcknowledgePurchaseParams
import com.android.billingclient.api.AcknowledgePurchaseResponseListener
import com.android.billingclient.api.AlternativeBillingOnlyAvailabilityListener
import com.android.billingclient.api.AlternativeBillingOnlyInformationDialogListener
import com.android.billingclient.api.AlternativeBillingOnlyReportingDetailsListener
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingConfigResponseListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingProgramAvailabilityListener
import com.android.billingclient.api.BillingProgramReportingDetailsListener
import com.android.billingclient.api.BillingProgramReportingDetailsParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.ConsumeParams
import com.android.billingclient.api.ConsumeResponseListener
import com.android.billingclient.api.ExternalOfferAvailabilityListener
import com.android.billingclient.api.ExternalOfferInformationDialogListener
import com.android.billingclient.api.ExternalOfferReportingDetailsListener
import com.android.billingclient.api.GetBillingConfigParams
import com.android.billingclient.api.InAppMessageParams
import com.android.billingclient.api.InAppMessageResponseListener
import com.android.billingclient.api.LaunchExternalLinkParams
import com.android.billingclient.api.LaunchExternalLinkResponseListener
import com.android.billingclient.api.ProductDetailsResponseListener
import com.android.billingclient.api.PurchasesResponseListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryProductDetailsResult
import com.android.billingclient.api.QueryPurchasesParams
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import kotlin.concurrent.thread

/**
 * [PlayBilling] against a Play that answers each request twice, as Play
 * Billing does when its own timeout (on the main thread) races the request
 * it cancels (on its worker): only the first answer counts, and the second
 * doesn't throw. No Play, no Android.
 */
class PlayBillingTest {
    @Test fun keepsPlaysFirstOffer() = runTest {
        val play = TwiceAnsweringPlay(racing = false)
        assertNull(PlayBilling { play }.monthly("happy", "monthly"))
        play.settle()
    }

    @Test fun keepsPlaysFirstPurchases() = runTest {
        val play = TwiceAnsweringPlay(racing = false)
        assertNull(PlayBilling { play }.owned())
        play.settle()
    }

    @Test fun keepsPlaysFirstAcknowledgement() = runTest {
        val play = TwiceAnsweringPlay(racing = false)
        assertFalse(PlayBilling { play }.acknowledge("token"))
        play.settle()
    }

    @Test fun keepsOneOfTwoAnswersFromTwoThreads() = runTest {
        val play = TwiceAnsweringPlay(racing = true)
        val billing = PlayBilling { play }

        repeat(50) {
            assertNull(billing.monthly("happy", "monthly"))
            assertNull(billing.owned())
            assertFalse(billing.acknowledge("token"))
            play.settle()
        }
    }

    /**
     * Connected, and answering every request twice. Not [racing]: on the
     * asking thread, first that Play couldn't be reached, then that it could
     * (an empty answer, or acknowledged). [racing]: both that Play couldn't be
     * reached, from two threads let go together, like Play's timeout and its
     * worker.
     */
    private class TwiceAnsweringPlay(private val racing: Boolean) : BillingClient() {
        private val threads = ConcurrentLinkedQueue<Thread>()
        private val failures = ConcurrentLinkedQueue<Throwable>()

        /** Waits out every answer still on its way, and throws what any of them threw. */
        fun settle() {
            while (true) (threads.poll() ?: break).join()
            failures.poll()?.let { throw it }
        }

        private fun answerTwice(answer: (ok: Boolean) -> Unit) {
            if (!racing) {
                answer(false)
                answer(true)
                return
            }
            val go = CountDownLatch(1)
            repeat(2) {
                threads += thread {
                    go.await()
                    runCatching { answer(false) }.onFailure { failures += it }
                }
            }
            go.countDown()
        }

        private fun result(ok: Boolean) = BillingResult.newBuilder()
            .setResponseCode(if (ok) BillingClient.BillingResponseCode.OK else BillingClient.BillingResponseCode.SERVICE_UNAVAILABLE)
            .build()

        override fun isReady() = true

        override fun queryProductDetailsAsync(params: QueryProductDetailsParams, listener: ProductDetailsResponseListener) =
            answerTwice { listener.onProductDetailsResponse(result(it), QueryProductDetailsResult.create(emptyList(), emptyList())) }

        override fun queryPurchasesAsync(params: QueryPurchasesParams, listener: PurchasesResponseListener) =
            answerTwice { listener.onQueryPurchasesResponse(result(it), emptyList()) }

        override fun acknowledgePurchase(params: AcknowledgePurchaseParams, listener: AcknowledgePurchaseResponseListener) =
            answerTwice { listener.onAcknowledgePurchaseResponse(result(it)) }

        override fun startConnection(listener: BillingClientStateListener) = error("connected")
        override fun getConnectionState() = BillingClient.ConnectionState.CONNECTED
        override fun endConnection() = Unit
        override fun isFeatureSupported(feature: String): BillingResult = error("not asked")
        override fun launchBillingFlow(activity: Activity, params: BillingFlowParams): BillingResult = error("not asked")
        override fun showAlternativeBillingOnlyInformationDialog(activity: Activity, listener: AlternativeBillingOnlyInformationDialogListener): BillingResult = error("not asked")
        override fun showExternalOfferInformationDialog(activity: Activity, listener: ExternalOfferInformationDialogListener): BillingResult = error("not asked")
        override fun showInAppMessages(activity: Activity, params: InAppMessageParams, listener: InAppMessageResponseListener): BillingResult = error("not asked")
        override fun consumeAsync(params: ConsumeParams, listener: ConsumeResponseListener) = error("not asked")
        override fun createAlternativeBillingOnlyReportingDetailsAsync(listener: AlternativeBillingOnlyReportingDetailsListener) = error("not asked")
        override fun createBillingProgramReportingDetailsAsync(params: BillingProgramReportingDetailsParams, listener: BillingProgramReportingDetailsListener) = error("not asked")
        override fun createExternalOfferReportingDetailsAsync(listener: ExternalOfferReportingDetailsListener) = error("not asked")
        override fun getBillingConfigAsync(params: GetBillingConfigParams, listener: BillingConfigResponseListener) = error("not asked")
        override fun isAlternativeBillingOnlyAvailableAsync(listener: AlternativeBillingOnlyAvailabilityListener) = error("not asked")
        override fun isBillingProgramAvailableAsync(program: Int, listener: BillingProgramAvailabilityListener) = error("not asked")
        override fun isExternalOfferAvailableAsync(listener: ExternalOfferAvailabilityListener) = error("not asked")
        override fun launchExternalLink(activity: Activity, params: LaunchExternalLinkParams, listener: LaunchExternalLinkResponseListener) = error("not asked")
    }
}
