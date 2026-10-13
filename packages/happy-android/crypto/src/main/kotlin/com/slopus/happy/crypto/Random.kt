package com.slopus.happy.crypto

import java.security.SecureRandom

/**
 * Source of nonces, ephemeral keys and new account secrets. Production code
 * uses [SecureRandomSource]; tests pass a scripted source so encryption output
 * can be compared byte for byte with vectors produced by the TypeScript code.
 */
fun interface RandomSource {
    fun nextBytes(size: Int): ByteArray
}

object SecureRandomSource : RandomSource {
    private val random = SecureRandom()

    override fun nextBytes(size: Int): ByteArray = ByteArray(size).also { random.nextBytes(it) }
}
