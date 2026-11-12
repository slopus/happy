package com.slopus.happy.connection

import androidx.credentials.PasswordCredential
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/** What Credential Manager hands back, read for the ID token. */
@RunWith(AndroidJUnit4::class)
class GoogleSignInTest {
    @Test
    fun readsTheIdTokenOfAGoogleCredential() {
        // Google's builder reads the token's claims, so it is a JWT.
        val token = jwt("902947412706-web.apps.googleusercontent.com", tag = "g1")
        val credential = GoogleIdTokenCredential.Builder().setId("person@example.com").setIdToken(token).build()
        assertEquals(GoogleCredential.Token(token), GoogleSignIn.read(credential))
    }

    @Test
    fun anythingElseIsAFailure() {
        assertEquals(GoogleCredential.Failed, GoogleSignIn.read(PasswordCredential("person", "secret")))
    }
}
