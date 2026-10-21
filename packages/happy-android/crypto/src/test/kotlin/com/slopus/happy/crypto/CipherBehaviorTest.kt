package com.slopus.happy.crypto

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Failure handling the sync code relies on: bad input is null, never an exception. */
class CipherBehaviorTest {
    private val key = ByteArray(32) { it.toByte() }
    private val payload = buildJsonObject {
        put("text", "Hello, 世界")
        put("n", 42)
    }

    @Test
    fun dataKeyCipherRoundTripsAndUsesFreshIvs() {
        val cipher = DataKeyCipher(key)
        val a = cipher.encrypt(payload)
        val b = cipher.encrypt(payload)
        assertNotEquals(a.toHex(), b.toHex())
        assertEquals(0, a[0].toInt())
        assertEquals(1 + 12 + payload.toString().encodeToByteArray().size + 16, a.size)
        assertEquals(payload, cipher.decrypt(a))
        assertEquals(payload, cipher.decrypt(b))
    }

    @Test
    fun dataKeyCipherRejectsBadInput() {
        val cipher = DataKeyCipher(key)
        val sealed = cipher.encrypt(payload)
        assertNull(DataKeyCipher(ByteArray(32) { 9 }).decrypt(sealed))
        assertNull(cipher.decrypt(sealed.copyOf().also { it[0] = 1 }))
        assertNull(cipher.decrypt(sealed.copyOf().also { it[it.size - 1] = (it[it.size - 1] + 1).toByte() }))
        assertNull(cipher.decrypt(sealed.copyOf(10)))
        assertNull(cipher.decrypt(ByteArray(0)))
        assertNull(cipher.decryptFromBase64("not base64 !"))
    }

    @Test
    fun dataKeyCipherRejectsNonJsonPlaintext() {
        val sealed = byteArrayOf(0) + Aes256Gcm.encrypt("{not json".encodeToByteArray(), key)
        assertNull(DataKeyCipher(key).decrypt(sealed))
    }

    @Test
    fun secretBoxCipherRejectsBadInput() {
        val cipher = SecretBoxCipher(key)
        val sealed = cipher.encrypt(JsonPrimitive("settings"))
        assertEquals(JsonPrimitive("settings"), cipher.decrypt(sealed))
        assertNull(SecretBoxCipher(ByteArray(32)).decrypt(sealed))
        assertNull(cipher.decrypt(sealed.copyOf(39)))
        assertNull(cipher.decrypt(sealed.copyOf().also { it[30] = (it[30] + 1).toByte() }))
    }

    @Test
    fun boxBundlesOpenOnlyWithTheRecipientKey() {
        val recipient = Sodium.boxSeedKeypair(ByteArray(32) { 3 })
        val bundle = encryptBox("secret".encodeToByteArray(), recipient.publicKey)
        assertEquals(32 + 24 + 16 + 6, bundle.size)
        assertEquals("secret", decryptBox(bundle, recipient.secretKey)?.decodeToString())
        assertNull(decryptBox(bundle, Sodium.boxSeedKeypair(ByteArray(32) { 4 }).secretKey))
        assertNull(decryptBox(bundle.copyOf(50), recipient.secretKey))
    }

    @Test
    fun scalarMultRejectsLowOrderPoints() {
        assertNull(Sodium.scalarMult(ByteArray(32) { 1 }, ByteArray(32)))
        assertNull(Sodium.boxEasy(ByteArray(1), ByteArray(24), ByteArray(32), ByteArray(32) { 1 }))
    }

    @Test
    fun blobRejectsTruncatedAndTampered() {
        val bundle = encryptBlob(byteArrayOf(1, 2, 3), key)
        assertEquals(24 + 16 + 3, bundle.size)
        assertArrayEquals(byteArrayOf(1, 2, 3), decryptBlob(bundle, key))
        assertNull(decryptBlob(bundle.copyOf(5), key))
        assertNull(decryptBlob(bundle.copyOf().also { it[it.size - 1] = (it[it.size - 1].toInt() xor 0xff).toByte() }, key))
    }

    @Test
    fun signaturesVerifyOnlyForTheSignedMessage() {
        val keyPair = Sodium.signSeedKeypair(ByteArray(32) { 5 })
        val signature = Sodium.signDetached("challenge".encodeToByteArray(), keyPair.secretKey)
        assertTrue(Sodium.signVerifyDetached(signature, "challenge".encodeToByteArray(), keyPair.publicKey))
        assertFalse(Sodium.signVerifyDetached(signature, "challengf".encodeToByteArray(), keyPair.publicKey))
    }

    @Test
    fun accountDataKeysRoundTripAndRejectForeignKeys() {
        val account = AccountEncryption.create(ByteArray(32) { 7 })
        val dataKey = AccountEncryption.generateDataKey()
        val wrapped = encodeBase64(account.encryptDataEncryptionKey(dataKey))
        assertArrayEquals(dataKey, account.decryptDataEncryptionKey(wrapped))
        assertNull(AccountEncryption.create(ByteArray(32) { 8 }).decryptDataEncryptionKey(wrapped))
        assertNull(account.decryptDataEncryptionKey(encodeBase64(byteArrayOf(1) + decodeBase64(wrapped).copyOfRange(1, 89))))
        assertNull(account.decryptDataEncryptionKey("%%%"))
        assertNull(account.decryptDataEncryptionKey(""))
    }

    @Test
    fun accountLinkRoundTrip() {
        val existingPhoneSecret = ByteArray(32) { 11 }
        val newPhone = AccountLink.generateKeyPair()
        val scanned = requireNotNull(AccountLink.parseLinkUrl(AccountLink.linkUrl(newPhone.publicKey)))
        val response = AccountLink.sealSecret(existingPhoneSecret, scanned)
        assertArrayEquals(existingPhoneSecret, AccountLink.openSecret(response, newPhone))
        assertNull(AccountLink.parseLinkUrl("happy://terminal?abc"))
        assertNull(AccountLink.parseLinkUrl(AccountLink.URL_PREFIX + "AAAA"))
    }
}
