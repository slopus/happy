package com.slopus.happy.auth

import com.slopus.happy.guest.KeystoreGuestStorage
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.R
import com.slopus.happy.accounts.AccountStore
import com.slopus.happy.connection.AgentConnections
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.xmlpull.v1.XmlPullParser

/**
 * Credentials stay on this phone and in this app: sealed by a Keystore key
 * that needs no biometry, in StrongBox when there is one; in app-private
 * preferences that neither a cloud backup nor a transfer to a new phone
 * carries.
 */
@RunWith(AndroidJUnit4::class)
class CredentialStorageTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()

    /** The preference files that hold credentials, by the names the stores use. */
    private val secretFiles = listOf(
        ExpoSecureStore.PREFS_NAME, AccountStore.CREDENTIALS_PREFS_NAME, AgentConnections.SECRETS_PREFS, KeystoreGuestStorage.PREFS_NAME,
    ).map { "$it.xml" }

    @Test
    fun theKeyIsAES256GCMWithoutUserAuthentication() {
        val spec = AndroidKeyStoreKeys.spec("alias", strongBox = false)
        assertEquals(256, spec.keySize)
        assertEquals(KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT, spec.purposes)
        assertEquals(listOf(KeyProperties.BLOCK_MODE_GCM), spec.blockModes.toList())
        assertEquals(listOf(KeyProperties.ENCRYPTION_PADDING_NONE), spec.encryptionPaddings.toList())
        assertTrue(spec.isRandomizedEncryptionRequired)
        assertFalse(spec.isUserAuthenticationRequired)
        assertFalse(spec.isStrongBoxBacked)
        assertTrue(AndroidKeyStoreKeys.spec("alias", strongBox = true).isStrongBoxBacked)
    }

    @Test
    fun aKeyIsMadeInStrongBoxElseInTheTEE() {
        val made = mutableListOf<KeyGenParameterSpec>()
        AndroidKeyStoreKeys(strongBox = true, generate = { made += it }).makeKey("a")
        assertEquals(listOf(true), made.map { it.isStrongBoxBacked })

        made.clear()
        AndroidKeyStoreKeys(strongBox = true, generate = {
            made += it
            if (it.isStrongBoxBacked) throw StrongBoxUnavailableException()
        }).makeKey("b")
        assertEquals(listOf(true, false), made.map { it.isStrongBoxBacked })
        assertTrue(made.none { it.isUserAuthenticationRequired })

        made.clear()
        AndroidKeyStoreKeys(strongBox = false, generate = { made += it }).makeKey("c")
        assertEquals(listOf(false), made.map { it.isStrongBoxBacked })
    }

    @Test
    fun credentialsArePrivateToTheApp() {
        val prefs = context.getSharedPreferences(AgentConnections.SECRETS_PREFS, Context.MODE_PRIVATE)
        prefs.edit().putString("x", "y").commit()
        val file = File(context.dataDir, "shared_prefs/${AgentConnections.SECRETS_PREFS}.xml")
        assertTrue(file.path, file.isFile)
        assertTrue(file.canonicalPath.startsWith(context.dataDir.canonicalPath))
    }

    @Test
    fun noBackupOrTransferCarriesCredentials() {
        val manifest = File("src/main/AndroidManifest.xml").readText()
        assertTrue(manifest.contains("android:allowBackup=\"false\""))
        assertTrue(manifest.contains("android:dataExtractionRules=\"@xml/data_extraction_rules\""))
        assertTrue(manifest.contains("android:fullBackupContent=\"@xml/backup_rules\""))

        val extraction = excludes(R.xml.data_extraction_rules)
        assertEquals(secretFiles.toSet(), extraction["cloud-backup"])
        assertEquals(secretFiles.toSet(), extraction["device-transfer"])
        assertEquals(secretFiles.toSet(), excludes(R.xml.backup_rules)["full-backup-content"])
    }

    /** The sharedpref files each section of [xml] excludes, by section. */
    private fun excludes(xml: Int): Map<String, Set<String>> {
        val parser = context.resources.getXml(xml)
        val found = mutableMapOf<String, MutableSet<String>>()
        var section = ""
        while (parser.next() != XmlPullParser.END_DOCUMENT) {
            if (parser.eventType != XmlPullParser.START_TAG) continue
            when (parser.name) {
                "exclude" -> {
                    assertEquals("sharedpref", parser.getAttributeValue(null, "domain"))
                    found.getOrPut(section) { mutableSetOf() } += parser.getAttributeValue(null, "path")
                }
                "include" -> error("an include in ${parser.name} would back up only that")
                else -> section = parser.name
            }
        }
        return found
    }
}
