package com.slopus.happy.payments

import com.slopus.happy.chat.arr
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import com.slopus.happy.net.HappyJson
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.net.URLEncoder
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import com.slopus.happy.payments.RevenueCat.Answer
import com.slopus.happy.payments.RevenueCat.Receipt

/** What voice asks of RevenueCat: apart, so voice's purchases can be tested without it. */
interface RevenueCat {
    sealed interface Answer {
        data class Ok(val body: JsonElement) : Answer

        /** RevenueCat said no: [status] 4xx is the request or the key, 5xx is RevenueCat; 0 an answer that isn't JSON. */
        data class Refused(val status: Int, val message: String?) : Answer

        /** No answer: offline, timed out. */
        data class Unreached(val error: IOException) : Answer
    }

    /** A Play subscription as `POST /v1/receipts` takes it: its own products, and its base plan where known. */
    data class Receipt(val customer: String, val token: String, val products: List<String>, val basePlan: String?, val restore: Boolean)

    suspend fun offerings(customer: String): Answer
    suspend fun subscriber(customer: String): Answer
    suspend fun post(receipt: Receipt): Answer

    /** `logIn`'s call: [from] (anonymous) merged into or switched to [to]. */
    suspend fun identify(from: String, to: String): Answer

    companion object {
        /**
         * The current offering's monthly package (`$rc_monthly`) as Play
         * knows it: its product and base plan (`platform_product_identifier`,
         * `platform_product_plan_identifier`, as `GoogleOfferingParser`
         * reads them). Null without one.
         */
        fun monthly(offerings: JsonElement): Pair<String, String>? {
            val current = offerings.obj?.get("current_offering_id").str ?: return null
            val offering = offerings.obj?.get("offerings").arr?.firstOrNull { it.obj?.get("identifier").str == current } ?: return null
            val pack = offering.obj?.get("packages").arr?.firstOrNull { it.obj?.get("identifier").str == "\$rc_monthly" }?.obj ?: return null
            val product = pack["platform_product_identifier"].str?.takeIf { it.isNotBlank() } ?: return null
            val plan = pack["platform_product_plan_identifier"].str?.takeIf { it.isNotBlank() } ?: return null
            return product to plan
        }
    }
}

/**
 * RevenueCat's REST API v1 with the app's public SDK key, the calls its SDK
 * makes (`purchases-android` `Backend`), for voice's purchases without the
 * SDK. Never a secret key; a token in a receipt is never logged.
 */
class RevenueCatApi(
    private val http: OkHttpClient,
    private val key: String,
    private val base: String = "https://api.revenuecat.com",
) : RevenueCat {
    override suspend fun offerings(customer: String): Answer = send(request("/v1/subscribers/${path(customer)}/offerings").get())

    override suspend fun subscriber(customer: String): Answer = send(request("/v1/subscribers/${path(customer)}").get())

    override suspend fun post(receipt: Receipt): Answer = send(
        request("/v1/receipts").post(
            buildJsonObject {
                put("app_user_id", receipt.customer)
                put("fetch_token", receipt.token)
                put("product_ids", buildJsonArray { receipt.products.forEach { add(it) } })
                put("platform_product_ids", buildJsonArray {
                    receipt.products.forEach { product ->
                        add(buildJsonObject { put("product_id", product); receipt.basePlan?.let { put("base_plan_id", it) } })
                    }
                })
                put("is_restore", receipt.restore)
                put("observer_mode", false)
            }.toString().toRequestBody(JSON),
        ),
    )

    override suspend fun identify(from: String, to: String): Answer = send(
        request("/v1/subscribers/identify").post(
            buildJsonObject { put("app_user_id", from); put("new_app_user_id", to) }.toString().toRequestBody(JSON),
        ),
    )

    private fun request(path: String) = Request.Builder()
        .url(base + path)
        .header("Authorization", "Bearer $key")
        .header("X-Platform", "android")

    private suspend fun send(builder: Request.Builder): Answer = try {
        http.newCall(builder.build()).await().use { response ->
            val text = response.body.string()
            if (response.isSuccessful) {
                Answer.Ok(HappyJson.parseToJsonElement(text))
            } else {
                Answer.Refused(response.code, runCatching { HappyJson.parseToJsonElement(text).obj?.get("message").str }.getOrNull())
            }
        }
    } catch (error: IOException) {
        Answer.Unreached(error)
    } catch (error: kotlinx.serialization.SerializationException) {
        Answer.Refused(0, "unreadable answer")
    }

    companion object {
        private val JSON = "application/json".toMediaType()

        private fun path(customer: String) = URLEncoder.encode(customer, "UTF-8").replace("+", "%20")
    }
}

private suspend fun Call.await(): Response = suspendCancellableCoroutine { continuation ->
    enqueue(object : Callback {
        override fun onResponse(call: Call, response: Response) = continuation.resume(response) { _, _, _ -> response.close() }
        override fun onFailure(call: Call, e: IOException) = continuation.resumeWithException(e)
    })
    continuation.invokeOnCancellation { cancel() }
}
