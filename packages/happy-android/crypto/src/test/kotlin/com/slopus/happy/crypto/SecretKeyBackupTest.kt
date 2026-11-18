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

    /**
     * Secrets made as happy-app made them (32 random bytes, kept as base64url)
     * and the backup key its Settings showed for each
     * (`formatSecretKeyForBackup`), by happy-app's own secretKeyBackup.ts.
     * The first three secrets have a `-` in their base64url, as about half do.
     */
    private val happyAppKeys = listOf(
        "UKafdB9JvekcxVki-bZXEm-mzL60jx_GB3YdQ-4YUlU" to "KCTJ6-5A7JG-66SHG-FLERP-TNSXC-JX2NT-F6WSH-R7RQH-OYOUH-3QYKJ-KQ",
        "kIZRh3714qUKx-_hoV4bDVodqcQ1wZGxM_9guqhRuec" to "SCDFD-B366X-RKKCW-H57Q2-CXQ3B-VNB3K-OEGXA-ZDMJT-75QLV-KCRXH-TQ",
        "ufo59AIjFMsxakcpv8Trs0RE1sisCRQDfAy-xk_W2lU" to "XH5DT-5ACEM-KMWML-KI4U3-7RHLW-NCEJV-WIVQE-RIA34-BS7MM-T6W3J-KQ",
        "7IcgpzokVUKUweiGV_sBU_fKVq5n9PHBHnUVTYrpqjo" to "5SDSB-JZ2ER-KUFFG-B5CDF-P6YBK-P34UV-VOM72-PDQI6-OUKU3-CXJVI-5A",
        "gLO90ktWebdQYEkEyxepVgYraAiwEac7ljQrr1D2KaY" to "QCZ33-USLKZ-43OUD-AJECM-WF5JK-YDCW2-AIWAI-2OO4W-GQV26-UHWFG-TA",
        "lyYq5qVWTLdmPRTWvIgIHmCbOTzlO9oclcgmXQp5quQ" to "S4TCV-ZVFKZ-GLOZR-5CTLL-ZCAID-ZQJWO-J44U5-5UHEV-ZATF2-CTZVL-SA",
    )

    @Test
    fun readsHappyAppsBackupKeysAndTheirRawSecrets() {
        for ((secret, backup) in happyAppKeys) {
            assertEquals(backup, SecretKeyBackup.format(secret))
            // As shown, as typed (lower case, spaces), and as pasted from a note.
            for (input in listOf(backup, backup.lowercase(), backup.replace('-', ' '), "\n$backup\n")) {
                assertEquals(input, secret, SecretKeyBackup.normalize(input))
            }
            // The raw secret, `-` or not, as iOS reads it; and in the standard
            // alphabet with padding, which happy-app's decoder also took.
            assertEquals(secret, SecretKeyBackup.normalize(secret))
            assertEquals(secret, SecretKeyBackup.normalize(" $secret "))
            assertEquals(secret, SecretKeyBackup.normalize(secret.replace('-', '+').replace('_', '/') + "="))
        }
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
