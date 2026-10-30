package com.slopus.happy.crypto

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** happy-agent API.md, "Mobile connector": the test vectors, the emoji table and its function. */
class PairingCryptoTest {
    private fun hex(text: String) = decodeHex(text)
    private fun ByteArray.lowerHex() = encodeHex(this).lowercase()

    @Test
    fun theTableIsApiMdsExactly() {
        val table = PairingCrypto.emojiTable
        assertEquals(333, table.size)
        assertEquals("😉", table.first())
        assertEquals("🔷", table.last())
        assertEquals(
            "c22c3a00d5a68df075fecc8cb8b730a45817a246a5ca70fa3b75d248ac5b54e9",
            sha256(table.joinToString("\n").toByteArray(Charsets.UTF_8)).lowerHex(),
        )
    }

    @Test
    fun emojiForApiMdsInputs() {
        val counting = ByteArray(32) { it.toByte() }
        assertEquals(listOf("😉", "😉", "😉", "😉"), PairingCrypto.emoji(ByteArray(32)))
        assertEquals(listOf("💍", "☔️", "📅", "🍞"), PairingCrypto.emoji(counting))
        assertEquals(listOf("🙉", "🇷🇺", "☔️", "✈️"), PairingCrypto.emoji(sha256(counting)))
        assertEquals(emptyList<String>(), PairingCrypto.emoji(ByteArray(31)))
    }

    @Test
    fun theFixedVectors() {
        val phone = PairingCrypto(privateKey = ByteArray(32) { 1 }, nonce = ByteArray(32) { 4 })
        val daemonKey = Sodium.scalarMultBase(ByteArray(32) { 2 })
        assertEquals("a4e09292b651c278b9772c569f5fa9bb13d906b46ab68c9df9dc2b4409f8a209", phone.publicKey.lowerHex())
        assertEquals("ce8d3ad1ccb633ec7b70c17814a5c76ecd029685050d344745ba05870e587d59", daemonKey.lowerHex())
        assertEquals("ae75325169fe3b8d8571df1c5fd015ef9989051a0363e780322a09ebf2430caf", phone.commitment.lowerHex())
        val secrets = phone.derive(daemonKey, ByteArray(32) { 5 }, ByteArray(32) { 3 }, "tcFixedVectorAddress", 24781)!!
        assertEquals("919140a78d542ec0999e8b045e9b368c94a5cc2d90d6c92e7f14e8d6d302eb08", secrets.transcriptHash.lowerHex())
        assertEquals("fa42488ee1ceadb6998e8d35792cdda1a1210a63153069fe67f1f1ce57404369", secrets.emojiKey.lowerHex())
        assertEquals("152eb695974a86f350d777dd1a7e63abb327eb6af37ee465addbb46ea53cde3f", secrets.confirmKey.lowerHex())
        assertEquals("05bf38156a0b81046b4e15f584760e0e8996efe81239e5efe4560fef29c20aeb", secrets.deviceToken.lowerHex())
        assertEquals("56562cd319819213d10c33fd9e508fffb19343d84b14882ecfc550c058181d85", secrets.mac("mobile").lowerHex())
        assertEquals("81fa0f2f506f539f4ca3f22eeeac675850f3cd902719f14799fc6519266893c9", secrets.mac("daemon").lowerHex())
        assertEquals("dd652c0915a809fbbdbedc963a8ddf0c940cff4bda204d9b9d886b3e661f67b1", sha256(secrets.deviceToken).lowerHex())
        assertEquals(listOf("🌀", "👗", "⏳", "👟"), secrets.emoji)
        assertTrue(secrets.verifyDaemon(hex("81fa0f2f506f539f4ca3f22eeeac675850f3cd902719f14799fc6519266893c9")))
        assertFalse(secrets.verifyDaemon(secrets.mac("mobile")))
    }

    @Test
    fun aLowOrderOrMisshapenDaemonKeyIsRefused() {
        val phone = PairingCrypto(privateKey = ByteArray(32) { 1 }, nonce = ByteArray(32) { 4 })
        assertNull(phone.derive(ByteArray(32), ByteArray(32), ByteArray(32), "tc", 1))
        assertNull(phone.derive(ByteArray(31), ByteArray(32), ByteArray(32), "tc", 1))
        assertNull(phone.derive(Sodium.scalarMultBase(ByteArray(32) { 2 }), ByteArray(32), ByteArray(32), "tc", 0))
    }

    @Test
    fun onlyCanonicalBase64UrlDecodes() {
        val bytes = ByteArray(32) { 3 }
        val text = CanonicalBase64Url.encode(bytes)
        assertEquals(43, text.length)
        assertArrayEquals(bytes, CanonicalBase64Url.decode(text))
        assertNull(CanonicalBase64Url.decode("$text="))
        assertNull(CanonicalBase64Url.decode(text.replace('A', '+')))
        assertNull(CanonicalBase64Url.decode(""))
        // A last character with stray low bits is another spelling of the same bytes.
        assertNull(CanonicalBase64Url.decode(text.dropLast(1) + "B"))
    }
}
