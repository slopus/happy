package com.slopus.happy.crypto

import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

// Mirrors packages/happy-app/sources/encryption/hmac_sha512.ts and deriveKey.ts.

fun sha512(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-512").digest(data)

fun hmacSha512(key: ByteArray, data: ByteArray): ByteArray {
    val mac = Mac.getInstance("HmacSHA512")
    mac.init(SecretKeySpec(key, "HmacSHA512"))
    return mac.doFinal(data)
}

class KeyTreeState(val key: ByteArray, val chainCode: ByteArray)

fun deriveSecretKeyTreeRoot(seed: ByteArray, usage: String): KeyTreeState {
    val i = hmacSha512("$usage Master Seed".encodeToByteArray(), seed)
    return KeyTreeState(key = i.copyOfRange(0, 32), chainCode = i.copyOfRange(32, 64))
}

fun deriveSecretKeyTreeChild(chainCode: ByteArray, index: String): KeyTreeState {
    // 0x00 separator, then the UTF-8 index.
    val data = byteArrayOf(0) + index.encodeToByteArray()
    val i = hmacSha512(chainCode, data)
    return KeyTreeState(key = i.copyOfRange(0, 32), chainCode = i.copyOfRange(32, 64))
}

fun deriveKey(master: ByteArray, usage: String, path: List<String>): ByteArray {
    var state = deriveSecretKeyTreeRoot(master, usage)
    for (index in path) {
        state = deriveSecretKeyTreeChild(state.chainCode, index)
    }
    return state.key
}
