package com.slopus.happy.push

import android.content.Context
import android.util.Log
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.File
import java.io.IOException
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** app.config.js `extra.eas.projectId`, which happy-app passes to getExpoPushTokenAsync. */
const val EXPO_PROJECT_ID = "4558dd3d-cd5a-47cd-bad9-e591a241cc06"

/** The exchange failed or answered something other than `{ data: { expoPushToken } }`. */
class ExpoPushTokenException(message: String) : IOException(message)

/**
 * expo-notifications 55's getExpoPushTokenAsync on Android: POSTs the FCM
 * token to Expo, which answers with the `ExponentPushToken[…]` that
 * happy-server sends pushes to. The body is the one expo builds, in its key
 * order: `type` "fcm", the installation id lowercased, `development` false
 * (only iOS can be true), the application id, the FCM token, the EAS
 * project id. Only `content-type: application/json` is set; no Happy
 * headers go to Expo.
 *
 * Expo's endpoint also refreshes the FCM token it holds for this
 * installation, so calling it again after the FCM token rotates keeps the
 * Expo token working (expo's own auto-registration does the same through
 * `push/updateDeviceToken`).
 */
class ExpoPushTokenClient(
    private val client: OkHttpClient,
    private val url: String = PRODUCTION_URL,
) {
    @Serializable
    private data class Body(
        val type: String,
        val deviceId: String,
        val development: Boolean,
        val appId: String,
        val deviceToken: String,
        val projectId: String,
    )

    suspend fun exchange(fcmToken: String, installationId: String, applicationId: String, projectId: String = EXPO_PROJECT_ID): String {
        val body = Json.encodeToString(
            Body.serializer(),
            Body(
                type = "fcm",
                deviceId = installationId.lowercase(),
                development = false,
                appId = applicationId,
                deviceToken = fcmToken,
                projectId = projectId,
            ),
        )
        val request = Request.Builder()
            .url(url)
            .header("content-type", "application/json")
            // Bytes, as React Native's fetch sends a string body: OkHttp would
            // append "; charset=utf-8" to the content type of a String body.
            .post(body.toByteArray().toRequestBody(JSON))
            .build()
        val text = client.newCall(request).await().use { response ->
            val text = response.body.string()
            if (!response.isSuccessful) {
                throw ExpoPushTokenException("Error encountered while fetching Expo token, expected an OK response, received: ${response.code} (body: \"$text\").")
            }
            text
        }
        val token = try {
            ((Json.parseToJsonElement(text) as? JsonObject)?.get("data") as? JsonObject)?.get("expoPushToken") as? JsonPrimitive
        } catch (_: IllegalArgumentException) {
            null
        }
        return token?.takeIf { it.isString && it.content.isNotEmpty() }?.content
            ?: throw ExpoPushTokenException("Malformed response from server, expected \"{ data: { expoPushToken: string } }\", received: $text")
    }

    companion object {
        const val PRODUCTION_URL = "https://exp.host/--/api/v2/push/getExpoPushToken"
        private val JSON = "application/json".toMediaType()
    }
}

/**
 * expo-notifications' InstallationId: a UUID per installation in the
 * no-backup files directory, `expo_notifications_installation_uuid.txt`,
 * migrated from its two legacy places. Reading the same file means an
 * upgrade from the React Native build keeps its device id, and with it the
 * Expo push token happy-server already has.
 */
class InstallationId(private val context: Context) {
    private var cached: String? = null

    @Synchronized
    fun getOrCreate(): String {
        cached?.let { return it }
        val primary = File(context.noBackupFilesDir, UUID_FILE_NAME)
        val found = read(primary)
            ?: legacyPreference()
            ?: read(File(context.noBackupFilesDir, LEGACY_UUID_FILE_NAME))?.also { save(primary, it) }
        val uuid = found ?: UUID.randomUUID().toString().also { save(primary, it) }
        cached = uuid
        return uuid
    }

    private fun legacyPreference(): String? {
        val prefs = context.getSharedPreferences(LEGACY_PREFERENCES_FILE_NAME, Context.MODE_PRIVATE)
        val uuid = prefs.getString(LEGACY_PREFERENCES_UUID_KEY, null) ?: return null
        if (save(File(context.noBackupFilesDir, UUID_FILE_NAME), uuid)) prefs.edit().remove(LEGACY_PREFERENCES_UUID_KEY).apply()
        return uuid
    }

    private fun read(file: File): String? = try {
        UUID.fromString(file.bufferedReader().use { it.readLine() }).toString()
    } catch (_: IOException) {
        null
    } catch (_: IllegalArgumentException) {
        null
    } catch (_: NullPointerException) {
        null
    }

    private fun save(file: File, uuid: String): Boolean = try {
        file.writeText(uuid)
        true
    } catch (e: IOException) {
        Log.e("InstallationId", "Error while writing UUID", e)
        false
    }

    companion object {
        const val UUID_FILE_NAME = "expo_notifications_installation_uuid.txt"
        const val LEGACY_UUID_FILE_NAME = "expo_installation_uuid.txt"
        const val LEGACY_PREFERENCES_FILE_NAME = "host.exp.exponent.SharedPreferences"
        const val LEGACY_PREFERENCES_UUID_KEY = "uuid"
    }
}

private suspend fun Call.await(): Response = suspendCancellableCoroutine { continuation ->
    continuation.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onResponse(call: Call, response: Response) = continuation.resume(response) { _, _, _ -> response.close() }
        override fun onFailure(call: Call, e: IOException) = continuation.resumeWithException(e)
    })
}
