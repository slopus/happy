package com.slopus.happy.model.settings

import com.slopus.happy.net.HappyHttp
import com.slopus.happy.net.HappyJson
import kotlinx.serialization.Serializable
import java.net.URLEncoder
import java.text.DateFormat
import java.util.Date

/** pushRegistration.ts `PushPermissionStatus`. */
enum class PushPermissionStatus { Unsupported, Granted, Denied, Undetermined }

/** pushRegistration.ts `PushPermissionInfo`. */
data class PushPermission(val status: PushPermissionStatus, val granted: Boolean, val canAskAgain: Boolean) {
    companion object {
        /** What happy-app reports when the notifications module can't say: undetermined, can't ask. */
        val Undetermined = PushPermission(PushPermissionStatus.Undetermined, granted = false, canAskAgain = false)
    }
}

data class PushPermissionRequest(val granted: Boolean, val openedSettings: Boolean, val permission: PushPermission)

data class PushTokenSync(val registered: Boolean, val token: String?, val permission: PushPermission)

/**
 * This device's push registration (sync/pushRegistration.ts): permission,
 * the current Expo push token, and registering it with the server.
 * Implemented over FCM by `push/AppPushRegistration`.
 */
interface PushRegistration {
    suspend fun permission(): PushPermission
    suspend fun requestPermissionOrOpenSettings(): PushPermissionRequest
    suspend fun currentToken(): String?
    suspend fun syncCurrentToken(): PushTokenSync
    suspend fun removeToken(token: String)
}

/** apiPush.ts `PushTokenSchema`. */
@Serializable
data class PushToken(val id: String, val token: String, val createdAt: Long, val updatedAt: Long)

@Serializable private data class PushTokenList(val tokens: List<PushToken>)

/** apiPush.ts: the account's registered push tokens. */
class PushTokensApi(private val http: HappyHttp, private val token: () -> String?) {
    private fun bearer() = token() ?: throw ConnectException("Not signed in")

    suspend fun list(): List<PushToken> =
        HappyJson.decodeFromString(PushTokenList.serializer(), http.send("GET", "/v1/push-tokens", bearer())).tokens

    suspend fun unregister(pushToken: String) {
        // encodeURIComponent
        val encoded = URLEncoder.encode(pushToken, "UTF-8").replace("+", "%20")
        http.send("DELETE", "/v1/push-tokens/$encoded", bearer())
    }
}

/** account.tsx's formatting of push state. */
object PushText {
    /** formatPushTokenFingerprint: the Expo token's value, first and last 6 when longer than 12. */
    fun fingerprint(token: String): String {
        val raw = token.removePrefix("ExponentPushToken[").removeSuffix("]")
        return if (raw.length <= 12) raw else "${raw.take(6)}…${raw.takeLast(6)}"
    }

    /** formatPushPermissionLabel. */
    fun label(permission: PushPermission?): String = when {
        permission == null -> "Loading"
        permission.status == PushPermissionStatus.Unsupported -> "Unavailable"
        permission.granted -> "Allowed"
        permission.status == PushPermissionStatus.Denied -> "Denied"
        else -> "Not requested"
    }

    /** formatPushPermissionSubtitle. */
    fun subtitle(permission: PushPermission?): String = when {
        permission == null -> "Checking push notification permissions for this device."
        permission.status == PushPermissionStatus.Unsupported -> "Push notification permissions are only managed on mobile devices."
        permission.granted -> "This device can receive push notifications."
        permission.canAskAgain -> "The system prompt can still be shown again from the app."
        else -> "iOS has stopped prompting. Open system settings to enable notifications again."
    }

    /** The "Request Permission Again" row's subtitle. */
    fun requestSubtitle(permission: PushPermission?): String = when {
        permission?.status == PushPermissionStatus.Unsupported -> "Push notification permissions are only available on iPhone and Android."
        permission?.canAskAgain == true -> "Shows the system prompt again if iOS still allows it."
        else -> "Opens system settings when iOS will not prompt again."
    }

    /** buildPushTokenSubtitle, with `toLocaleString` as the default locale's medium date and time. */
    fun tokenSubtitle(token: PushToken, isCurrentDevice: Boolean, deviceLabel: String, appLabel: String?, format: DateFormat = defaultFormat()): String {
        val lines = mutableListOf<String>()
        if (isCurrentDevice) {
            lines += deviceLabel
            if (appLabel != null) lines += appLabel
        } else {
            lines += "Other device or stale registration"
        }
        lines += "Registered: ${format.format(Date(token.createdAt))}"
        lines += "Last seen: ${format.format(Date(token.updatedAt))}"
        lines += "Server ID: ${token.id}"
        lines += "Token: ${fingerprint(token.token)}"
        return lines.joinToString("\n")
    }

    private fun defaultFormat() = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.MEDIUM)

    /**
     * getCurrentPushDeviceMetadata: device name, model when it differs,
     * OS and version; app version, build, and "simulator" on an emulator.
     */
    fun deviceLabels(
        deviceName: String?,
        modelName: String?,
        osVersion: String?,
        appVersion: String?,
        buildVersion: String?,
        emulator: Boolean,
    ): Pair<String, String?> {
        val device = listOfNotNull(
            deviceName,
            modelName?.takeIf { it != deviceName },
            listOfNotNull("Android", osVersion).filter { it.isNotEmpty() }.joinToString(" "),
        ).filter { it.isNotBlank() }
        val app = listOfNotNull(
            appVersion?.takeIf { it.isNotEmpty() }?.let { "Happy $it" },
            buildVersion?.takeIf { it.isNotEmpty() }?.let { "build $it" },
            "simulator".takeIf { emulator },
        )
        return (device.joinToString(" • ").ifEmpty { "android device" }) to app.joinToString(" • ").ifEmpty { null }
    }
}
