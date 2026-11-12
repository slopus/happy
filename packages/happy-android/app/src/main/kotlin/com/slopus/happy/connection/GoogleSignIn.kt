package com.slopus.happy.connection

import android.content.Context
import android.util.Log
import androidx.credentials.Credential
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.GetCredentialProviderConfigurationException
import androidx.credentials.exceptions.GetCredentialUnsupportedException
import androidx.credentials.exceptions.NoCredentialException
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.android.libraries.identity.googleid.GoogleIdTokenParsingException
import com.slopus.happy.BuildConfig

/** What the phone's Google sign-in gave ([GoogleSignIn.credential]). */
sealed interface GoogleCredential {
    /** Google's ID token, its `aud` the web client, its `nonce` the one asked with. */
    data class Token(val idToken: String) : GoogleCredential

    /** The person closed the sheet. */
    data object Cancelled : GoogleCredential

    /** Nothing here to sign in with: no Google account, or no Google Play services. The browser's sign-in can still go. */
    data object Unavailable : GoogleCredential

    /** Google refused or broke (a package and SHA-1 it doesn't know is one); logged, never the token. */
    data object Failed : GoogleCredential
}

/**
 * Sign in with Google on the phone, through Credential Manager: the explicit
 * button's sheet ([GetSignInWithGoogleOption]), for an ID token whose
 * audience is the accounts service's web client ([serverClientId], one for
 * every variant) and whose `nonce` is the one given. Google knows the app by
 * its package and signing SHA-1, registered in project happy-coder-9fe36.
 */
class GoogleSignIn(private val serverClientId: String = BuildConfig.GOOGLE_SERVER_CLIENT_ID) {
    /** Opens Google's sheet over [context], which must be the activity. */
    suspend fun credential(context: Context, nonce: String): GoogleCredential {
        val option = GetSignInWithGoogleOption.Builder(serverClientId).setNonce(nonce).build()
        val request = GetCredentialRequest.Builder().addCredentialOption(option).build()
        return try {
            read(CredentialManager.create(context).getCredential(context, request).credential)
        } catch (_: GetCredentialCancellationException) {
            GoogleCredential.Cancelled
        } catch (e: GetCredentialException) {
            when (e) {
                is NoCredentialException, is GetCredentialProviderConfigurationException, is GetCredentialUnsupportedException -> {
                    Log.i(TAG, "No Google sign-in on this phone (${e.type}): ${e.errorMessage}")
                    GoogleCredential.Unavailable
                }
                else -> {
                    Log.w(TAG, "Google sign-in failed (${e.type}): ${e.errorMessage}")
                    GoogleCredential.Failed
                }
            }
        }
    }

    companion object {
        private const val TAG = "GoogleSignIn"

        /** The ID token in what Credential Manager returned; anything else is a failure. */
        internal fun read(credential: Credential): GoogleCredential {
            if (credential !is CustomCredential || credential.type != GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) return GoogleCredential.Failed
            return try {
                GoogleCredential.Token(GoogleIdTokenCredential.createFrom(credential.data).idToken)
            } catch (_: GoogleIdTokenParsingException) {
                GoogleCredential.Failed
            }
        }
    }
}
