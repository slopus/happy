package com.slopus.happy.crypto

import java.util.Base64

// Mirrors packages/happy-app/sources/encryption/base64.ts and hex.ts.

enum class Base64Variant {
    /** RFC 4648 alphabet with `=` padding. Used for every wire field. */
    Standard,

    /** URL-safe alphabet without padding. Used for the stored account secret and QR payloads. */
    Url,
}

fun encodeBase64(bytes: ByteArray, variant: Base64Variant = Base64Variant.Standard): String = when (variant) {
    Base64Variant.Standard -> Base64.getEncoder().encodeToString(bytes)
    Base64Variant.Url -> Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
}

/** Throws [IllegalArgumentException] on characters outside the variant's alphabet. Padding is optional. */
fun decodeBase64(text: String, variant: Base64Variant = Base64Variant.Standard): ByteArray = when (variant) {
    Base64Variant.Standard -> Base64.getDecoder().decode(text)
    Base64Variant.Url -> Base64.getUrlDecoder().decode(text)
}

private val HEX_UPPER = "0123456789ABCDEF".toCharArray()

/** Uppercase, like @stablelib/hex. */
fun encodeHex(bytes: ByteArray): String {
    val out = CharArray(bytes.size * 2)
    for (i in bytes.indices) {
        val v = bytes[i].toInt() and 0xff
        out[i * 2] = HEX_UPPER[v ushr 4]
        out[i * 2 + 1] = HEX_UPPER[v and 0x0f]
    }
    return String(out)
}

fun decodeHex(hex: String): ByteArray {
    require(hex.length % 2 == 0) { "Hex string must have an even length" }
    return ByteArray(hex.length / 2) { i ->
        val hi = Character.digit(hex[i * 2], 16)
        val lo = Character.digit(hex[i * 2 + 1], 16)
        require(hi >= 0 && lo >= 0) { "Invalid hex character" }
        ((hi shl 4) or lo).toByte()
    }
}
