package com.slopus.happy.connection

import java.util.Base64

/** An unsigned JWT for [aud] (a string, or several), distinct by [tag]: what the app reads of an access token. */
internal fun jwt(vararg aud: String, tag: String = "t"): String {
    fun part(json: String) = Base64.getUrlEncoder().withoutPadding().encodeToString(json.toByteArray())
    val audience = if (aud.size == 1) "\"${aud[0]}\"" else aud.joinToString(",", "[", "]") { "\"$it\"" }
    return part("""{"alg":"RS256","typ":"JWT"}""") + "." + part("""{"aud":$audience,"sub":"$tag"}""") + ".sig-$tag"
}
