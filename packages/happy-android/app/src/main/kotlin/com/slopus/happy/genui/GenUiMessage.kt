package com.slopus.happy.genui

import java.net.URI
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.contentOrNull

/** Direct results have no artifact authority or file namespace. */
object GenUiMessage {
    fun document(value: JsonElement?): RenderDocument {
        val obj = value as? JsonObject
        val version = (obj?.get("genuiRender") as? JsonPrimitive)?.intOrNull
        val fallback = (obj?.get("fallback") as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() } ?: "Gen UI"
        val elements = obj?.get("elements") as? JsonObject
        val images = elements?.values?.any { ((it as? JsonObject)?.get("type") as? JsonPrimitive)?.contentOrNull == "image" } == true
        if (obj == null || version != 1 || (elements?.size ?: 0) > 4000 || images) {
            return RenderDocument(fallback, null, emptyMap(), emptyMap())
        }
        if (obj.toString().toByteArray(Charsets.UTF_8).size > 4 * 1024 * 1024) return RenderDocument(fallback, null, emptyMap(), emptyMap())
        return GenUi.document(obj).copy(fallback = fallback)
    }

    fun enables(action: Action): Boolean = when (action) {
        is Action.Message, is Action.Copy -> true
        is Action.Open -> runCatching {
            val url = action.url
            val parsed = URI(url)
            url.startsWith("https://", ignoreCase = true) && url.none { it.isWhitespace() || it.isISOControl() || it == '\\' } &&
                parsed.scheme.equals("https", ignoreCase = true) && !parsed.host.isNullOrEmpty() && parsed.rawUserInfo == null
        }.getOrDefault(false)
        else -> false
    }
}