package com.slopus.happy.testing

import com.slopus.happy.auth.SecureStoreKeys
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.PrivateKey
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/** [SecureStoreKeys] with software keys: Robolectric has no AndroidKeyStore. */
class SoftwareKeys : SecureStoreKeys {
    val secretKeys = mutableMapOf<String, SecretKey>()
    val keyPairs = mutableMapOf<String, KeyPair>()

    override fun secretKey(alias: String): SecretKey? = secretKeys[alias]

    override fun createSecretKey(alias: String): SecretKey =
        KeyGenerator.getInstance("AES").apply { init(256) }.generateKey().also { secretKeys[alias] = it }

    override fun privateKey(alias: String): PrivateKey? = keyPairs[alias]?.private

    override fun delete(alias: String) {
        secretKeys.remove(alias)
        keyPairs.remove(alias)
    }

    fun createKeyPair(alias: String): KeyPair =
        KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair().also { keyPairs[alias] = it }
}
