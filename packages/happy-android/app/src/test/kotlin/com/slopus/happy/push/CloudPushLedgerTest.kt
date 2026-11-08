package com.slopus.happy.push

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.testing.SoftwareKeys
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CloudPushLedgerTest {
    @Test fun ledgerUsesKeystoreEnvelopeAndReadsAbsentAfterKeyLoss() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val prefs = context.getSharedPreferences("push-ledger-test", Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        val keys = SoftwareKeys()
        val secure = ExpoSecureStore(prefs, keys, keychainService = "cloud-push")
        val ledger = CloudPushLedger(secure)
        val account = CloudPushAccount("connection", "https://one.example", "private-member")
        val state = CloudPushLedgerState(bindings = listOf(CloudPushBinding(account, "registration-id")))
        ledger.update { state }
        assertEquals(state, CloudPushLedger(secure).snapshot())
        val stored = prefs.all.values.joinToString()
        assertFalse(stored.contains("private-member"))
        assertFalse(stored.contains("registration-id"))
        assertFalse(stored.contains("one.example"))
        val keyless = ExpoSecureStore(prefs, SoftwareKeys(), keychainService = "cloud-push")
        assertEquals(CloudPushLedgerState(), CloudPushLedger(keyless).snapshot())
    }
}