package com.slopus.happy.payments

import android.app.Activity
import com.slopus.happy.net.HappyJson
import com.slopus.happy.payments.ProPassTest.Companion.pro
import com.slopus.happy.payments.ProPassTest.Companion.subscriber
import com.slopus.happy.payments.RevenueCat.Answer
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableSharedFlow
import java.io.IOException

/** The store as the subscription asks it: what it sells, holds and was asked to open. No Play. */
internal class FakeStore : SubscriptionStore {
    override val updates = MutableSharedFlow<List<StorePurchase>>(extraBufferCapacity = 8)
    var monthly: StoreOffer? = StoreOffer("happy", "monthly", "9,99 €")
    val owned = ArrayList<StorePurchase>()
    val acknowledged = ArrayList<String>()
    val opened = ArrayList<StoreOffer>()
    override suspend fun monthly(product: String, basePlan: String) = monthly?.takeIf { it.product == product && it.basePlan == basePlan }
    override suspend fun owned() = owned.toList()
    override suspend fun buy(activity: Activity, offer: StoreOffer) = opened.add(offer)
    override suspend fun acknowledge(token: String): Boolean {
        acknowledged += token
        owned.replaceAll { if (it.token == token) it.copy(acknowledged = true) else it }
        return true
    }
}

/** RevenueCat as far as the subscription asks it: `pro` for whoever a receipt was posted for. [hold] makes a call wait. */
internal class FakeRevenueCat : RevenueCat {
    val calls = ArrayList<String>()
    val pro = HashMap<String, String>()
    var refusePosts: Int? = null
    var unreachable = false
    var identifyFails = false
    val hold = HashMap<String, CompletableDeferred<Unit>>()
    private suspend fun gate(name: String) { hold[name]?.await() }
    override suspend fun offerings(customer: String): Answer {
        calls += "offerings $customer"
        gate("offerings")
        if (unreachable) return Answer.Unreached(IOException("offline"))
        return Answer.Ok(HappyJson.parseToJsonElement("""{"current_offering_id":"d","offerings":[{"identifier":"d","packages":[{"identifier":"${'$'}rc_monthly","platform_product_identifier":"happy","platform_product_plan_identifier":"monthly"}]}]}"""))
    }
    override suspend fun subscriber(customer: String): Answer {
        calls += "subscriber $customer"
        gate("subscriber")
        if (unreachable) return Answer.Unreached(IOException("offline"))
        return Answer.Ok(answer(customer))
    }
    override suspend fun post(receipt: RevenueCat.Receipt): Answer {
        calls += "post ${receipt.customer} ${receipt.token} ${receipt.products} restore=${receipt.restore}"
        gate("post")
        refusePosts?.let { return Answer.Refused(it, "invalid receipt") }
        pro[receipt.customer] = receipt.products.first()
        return Answer.Ok(answer(receipt.customer))
    }
    override suspend fun identify(from: String, to: String): Answer {
        calls += "identify $from $to"
        gate("identify")
        if (identifyFails) return Answer.Unreached(IOException("offline"))
        pro.remove(from)?.let { pro[to] = it }
        return Answer.Ok(answer(to))
    }
    private fun answer(customer: String) =
        subscriber("2026-11-04T10:00:00Z", pro[customer]?.let { pro("2026-10-20T08:00:00Z", "2026-11-20T08:00:00Z", product = it) })
}

