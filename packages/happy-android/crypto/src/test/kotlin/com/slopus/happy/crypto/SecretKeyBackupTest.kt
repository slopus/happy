package com.slopus.happy.crypto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** The cases of happy-app's secretKeyBackup.spec.ts that pin behaviour rather than restate it. */
class SecretKeyBackupTest {
    private val secret = encodeBase64(ByteArray(32) { it.toByte() }, Base64Variant.Url)
    private val formatted = SecretKeyBackup.format(secret)

    @Test
    fun formatsAsGroupsOfFive() {
        assertTrue(formatted.matches(Regex("^[A-Z2-7]{5}(-[A-Z2-7]{1,5})*$")))
        assertEquals(11, formatted.split('-').size)
        assertThrows("Invalid secret key format", IllegalArgumentException::class.java) {
            SecretKeyBackup.format("invalid-base64!")
        }
    }

    @Test
    fun parsesForgivingInput() {
        val inputs = listOf(
            formatted.lowercase(),
            formatted.replace("-", " - "),
            formatted.toCharArray().joinToString(" "),
            formatted.replace("-", "\n"),
            formatted.replace('O', '0').replace('I', '1').replace('B', '8'),
            "\"$formatted\"",
            "```$formatted```",
            formatted.replace('-', '.'),
            formatted.replace("-", ""),
            "😀$formatted🎉",
            "[$formatted]",
        )
        for (input in inputs) {
            assertEquals(input, secret, SecretKeyBackup.parse(input))
        }
    }

    @Test
    fun reportsLengthAndEmptyErrors() {
        val empty = assertThrows(IllegalArgumentException::class.java) { SecretKeyBackup.parse("!!!") }
        assertEquals("No valid characters found", empty.message)
        val short = assertThrows(IllegalArgumentException::class.java) { SecretKeyBackup.parse("AAAAA-BBBBB") }
        assertTrue(short.message!!.startsWith("Invalid key length"))
        // HTML entities and URL escapes carry base32 letters, so they change the length.
        assertThrows(IllegalArgumentException::class.java) { SecretKeyBackup.parse(formatted.replace("-", "&mdash;")) }
        assertThrows(IllegalArgumentException::class.java) { SecretKeyBackup.parse(formatted.replace("-", "%2D")) }
    }

    @Test
    fun validatesBothForms() {
        assertTrue(SecretKeyBackup.isValid(secret))
        assertTrue(SecretKeyBackup.isValid(formatted))
        assertFalse(SecretKeyBackup.isValid("invalid!"))
        assertFalse(SecretKeyBackup.isValid(""))
        assertFalse(SecretKeyBackup.isValid(encodeBase64(ByteArray(16), Base64Variant.Url)))
        assertFalse(SecretKeyBackup.isValid("AAAAA-BBBBB"))
    }

    @Test
    fun normalizesBothForms() {
        assertEquals(secret, SecretKeyBackup.normalize(secret))
        assertEquals(secret, SecretKeyBackup.normalize("  \n\t$formatted\t\n "))
        assertEquals(secret, SecretKeyBackup.normalize(formatted.replace("-", "").chunked(4).joinToString(" ")))
        assertThrows(IllegalArgumentException::class.java) { SecretKeyBackup.normalize("invalid") }
        assertThrows(IllegalArgumentException::class.java) { SecretKeyBackup.normalize("") }
        assertThrows(IllegalArgumentException::class.java) { SecretKeyBackup.normalize("A".repeat(1000)) }
    }
}
