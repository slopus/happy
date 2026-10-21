package com.slopus.happy.crypto

/**
 * The human-readable form of the account secret: base32 (RFC 4648 alphabet,
 * no padding) in dash-separated groups of five. Mirrors
 * packages/happy-app/sources/auth/secretKeyBackup.ts, including its error
 * messages and its tolerance for common transcription mistakes.
 */
object SecretKeyBackup {
    private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

    private fun bytesToBase32(bytes: ByteArray): String {
        val result = StringBuilder()
        var buffer = 0
        var bufferLength = 0
        for (byte in bytes) {
            buffer = (buffer shl 8) or (byte.toInt() and 0xff)
            bufferLength += 8
            while (bufferLength >= 5) {
                bufferLength -= 5
                result.append(ALPHABET[(buffer shr bufferLength) and 0x1f])
            }
        }
        if (bufferLength > 0) {
            result.append(ALPHABET[(buffer shl (5 - bufferLength)) and 0x1f])
        }
        return result.toString()
    }

    private fun base32ToBytes(base32: String): ByteArray {
        // Uppercase, map the usual look-alikes, then drop everything outside the alphabet.
        val normalized = base32.uppercase()
            .replace('0', 'O')
            .replace('1', 'I')
            .replace('8', 'B')
            .replace('9', 'G')
        val cleaned = normalized.filter { it in 'A'..'Z' || it in '2'..'7' }
        if (cleaned.isEmpty()) {
            throw IllegalArgumentException("No valid characters found")
        }
        val bytes = ArrayList<Byte>(cleaned.length * 5 / 8)
        var buffer = 0
        var bufferLength = 0
        for (char in cleaned) {
            buffer = (buffer shl 5) or ALPHABET.indexOf(char)
            bufferLength += 5
            if (bufferLength >= 8) {
                bufferLength -= 8
                bytes.add(((buffer shr bufferLength) and 0xff).toByte())
            }
        }
        return bytes.toByteArray()
    }

    /** base64url secret -> "XXXXX-XXXXX-...". */
    fun format(secretKeyBase64Url: String): String {
        val bytes = try {
            decodeBase64(secretKeyBase64Url, Base64Variant.Url)
        } catch (_: IllegalArgumentException) {
            throw IllegalArgumentException("Invalid secret key format")
        }
        return bytesToBase32(bytes).chunked(5).joinToString("-")
    }

    /** "XXXXX-XXXXX-..." (forgivingly) -> base64url secret. */
    fun parse(formattedKey: String): String {
        val bytes = base32ToBytes(formattedKey)
        if (bytes.size != 32) {
            throw IllegalArgumentException("Invalid key length: expected 32 bytes, got ${bytes.size}")
        }
        return encodeBase64(bytes, Base64Variant.Url)
    }

    fun isValid(key: String): Boolean = try {
        if (key.contains('-')) {
            decodeBase64(parse(key), Base64Variant.Url).size == 32
        } else {
            decodeBase64(key, Base64Variant.Url).size == 32
        }
    } catch (_: IllegalArgumentException) {
        false
    }

    /**
     * Accepts either form and returns the base64url secret. Same decision order
     * as the TS: anything with a dash or whitespace, or longer than 50
     * characters, is read as the formatted key.
     */
    fun normalize(key: String): String {
        val trimmed = key.trim()
        if (trimmed.any { it == '-' || it.isWhitespace() } || trimmed.length > 50) {
            return parse(trimmed)
        }
        return try {
            val bytes = decodeBase64(trimmed, Base64Variant.Url)
            if (bytes.size != 32) throw IllegalArgumentException("Invalid secret key")
            trimmed
        } catch (_: IllegalArgumentException) {
            parse(trimmed)
        }
    }
}
