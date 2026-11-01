package com.slopus.happy.connection

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** Exact canonical HTTPS origin, bound into the v2 pairing transcript. */
class AgentOrigin private constructor(val value: String, val host: String, val port: Int) {
    val authority: String get() = value.removePrefix("https://")

    companion object {
        fun parse(value: String): AgentOrigin {
            fun invalid(): Nothing = throw AgentConnectionException(AgentConnectionException.Reason.InvalidCode)
            if (value.length > 8192 || value.any { it.code <= 32 || it.code >= 127 }) invalid()
            val url = value.toHttpUrlOrNull() ?: invalid()
            val host = if (url.host.contains(':')) "[${url.host}]" else url.host
            val canonical = "https://$host" + if (url.port == 443) "" else ":${url.port}"
            if (url.scheme != "https" || value != canonical) invalid()
            if (!url.host.contains(':')) {
                val fields = url.host.split('.')
                val last = fields.lastOrNull { it.isNotEmpty() }.orEmpty()
                if ((last.isNotEmpty() && last.all { it in '0'..'9' }) || last.startsWith("0x")) {
                    if (fields.size != 4 || fields.any { field -> field.toIntOrNull()?.takeIf { it in 0..255 }?.toString() != field }) invalid()
                }
            }
            return AgentOrigin(value, url.host, url.port)
        }
    }
}