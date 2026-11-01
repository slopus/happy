package com.slopus.happy.config

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.xmlpull.v1.XmlPullParser
import androidx.test.core.app.ApplicationProvider
import android.content.Context

/** Managed configurations: the contract's keys, typed, unset meaning the person's choice. */
@RunWith(AndroidJUnit4::class)
class ManagedPolicyTest {
    @Test
    fun keysAreReadTypedAndWrongTypesIgnored() {
        val policy = ManagedPolicy.from(
            mapOf(
                "serverUrl" to "https://happy.acme.example/",
                "allowAdditionalServers" to false,
                "analyticsEnabled" to false,
                "hostedRelayEnabled" to "false",
                "tailcatEnabled" to false,
                "phonePairingEnabled" to true,
                "unknown" to 1,
            ),
        )
        assertEquals(
            ManagedPolicy(
                serverUrl = "https://happy.acme.example",
                allowAdditionalServers = false,
                analyticsEnabled = false,
                hostedRelayEnabled = null,
                tailcatEnabled = false,
                phonePairingEnabled = true,
            ),
            policy,
        )
        assertTrue(policy.allowsServer("https://happy.acme.example"))
        assertFalse(policy.allowsServer("https://other.example"))
        assertTrue(ManagedPolicy().allowsServer("https://other.example"))
        assertFalse(ManagedPolicy().managed)
    }

    @Test
    fun managementCanOnlyTurnAnalyticsOff() {
        assertEquals(false, ManagedPolicy.from(mapOf("analyticsEnabled" to false)).analyticsEnabled)
        assertEquals(ManagedPolicy(managed = true), ManagedPolicy.from(mapOf("analyticsEnabled" to true)))
    }

    @Test
    fun pairingIsOptInOnlyUnderManagement() {
        // No managed configuration: pairing as before.
        assertTrue(ManagedPolicy.from(emptyMap()).pairingAllowed)
        assertTrue(ManagedPolicy.from(mapOf("unknown" to 1)).pairingAllowed)
        // Managed: off unless phonePairingEnabled is true, whatever else is set.
        assertFalse(ManagedPolicy.from(mapOf("serverUrl" to "https://happy.acme.example")).pairingAllowed)
        assertFalse(ManagedPolicy.from(mapOf("analyticsEnabled" to true)).pairingAllowed)
        assertFalse(ManagedPolicy.from(mapOf("phonePairingEnabled" to false)).pairingAllowed)
        assertFalse(ManagedPolicy.from(mapOf("phonePairingEnabled" to "true")).pairingAllowed)
        assertTrue(ManagedPolicy.from(mapOf("tailcatEnabled" to false, "phonePairingEnabled" to true)).pairingAllowed)
    }

    @Test
    fun theServerMustBeAnHttpsOrigin() {
        for (bad in listOf("http://happy.acme.example", "happy.acme.example", "https://happy.acme.example/path", 42)) {
            assertEquals(null, ManagedPolicy.from(mapOf("serverUrl" to bad)).serverUrl)
        }
    }

    /** The XML an EMM reads lists exactly the keys the code reads. */
    @Test
    fun restrictionsDeclareTheContractsKeys() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val parser = context.resources.getXml(com.slopus.happy.R.xml.app_restrictions)
        val keys = mutableListOf<String>()
        while (parser.next() != XmlPullParser.END_DOCUMENT) {
            if (parser.eventType == XmlPullParser.START_TAG && parser.name == "restriction") {
                val key = parser.getAttributeValue("http://schemas.android.com/apk/res/android", "key")
                keys += key
            }
        }
        assertEquals(
            listOf(
                ManagedPolicy.SERVER_URL,
                ManagedPolicy.ALLOW_ADDITIONAL_SERVERS,
                ManagedPolicy.ANALYTICS_ENABLED,
                ManagedPolicy.HOSTED_RELAY_ENABLED,
                ManagedPolicy.TAILCAT_ENABLED,
                ManagedPolicy.PHONE_PAIRING_ENABLED,
            ),
            keys,
        )
    }
}
