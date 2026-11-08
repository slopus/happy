package com.slopus.happy.push

import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import androidx.core.app.NotificationManagerCompat
import com.slopus.happy.agent.HappyUrls
import com.slopus.happy.connection.AgentConnection
import com.slopus.happy.connection.AgentConnections
import com.slopus.happy.connection.HappyCloud
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Navigation identifiers only; title/body are intentionally authored notification copy, kept outside. */
data class CloudPushNotification(val instanceId: String, val userId: String, val agentId: String, val notificationId: String) {
    fun json(): String = buildJsonObject {
        put("kind", KIND)
        put("instanceId", instanceId)
        put("userId", userId)
        put("agentId", agentId)
        put("notificationId", notificationId)
    }.toString()

    /** No delimiter ambiguities between members' opaque identifiers. */
    val key: String get() = Json.encodeToString(listOf(instanceId, userId, notificationId))

    companion object {
        const val KIND = "happy.cloud.push.v1"
        private val fields = setOf("kind", "instanceId", "userId", "agentId", "notificationId")
        private val agent = Regex("[A-Za-z0-9_-]{1,128}")
        private fun objectFrom(body: String?): JsonObject? = if (body == null || body.length > 4096) null else try {
            Json.parseToJsonElement(body) as? JsonObject
        } catch (_: Exception) { null }
        private fun JsonObject.text(key: String) = (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content
        private fun opaque(value: String) = value.isNotBlank() && value.length <= 256 && value.none { it.isISOControl() }

        /** An unsupported or malformed Cloud payload must never fall through to legacy session routing. */
        fun owns(body: String?): Boolean = objectFrom(body)?.let {
            it.text("kind")?.startsWith("happy.cloud.push.") == true || it.keys.containsAll(setOf("instanceId", "userId", "agentId"))
        } == true

        fun parse(body: String?): CloudPushNotification? {
            val value = objectFrom(body) ?: return null
            if (value.keys != fields || value.text("kind") != KIND) return null
            val instanceId = value.text("instanceId")?.takeIf(HappyUrls::isInstanceId) ?: return null
            val userId = value.text("userId")?.takeIf(::opaque) ?: return null
            val agentId = value.text("agentId")?.takeIf(agent::matches) ?: return null
            val notificationId = value.text("notificationId")?.takeIf(::opaque) ?: return null
            return CloudPushNotification(instanceId, userId, agentId, notificationId)
        }
    }
}

/** A push never chooses another login merely because it shares the server or is currently open. */
fun cloudPushConnection(accounts: List<AgentConnection>, instanceId: String, userId: String, open: String? = null): AgentConnection? {
    val matching = accounts.filter {
        HappyCloud.isServer(it.server) && !it.revoked && !it.signInRequired && !it.profileRequired &&
            it.instanceId == instanceId && it.userId == userId
    }
    return matching.firstOrNull { it.id == open } ?: matching.firstOrNull()
}

const val EXTRA_PUSH_CLOUD = "com.slopus.happy.push.cloud"

internal fun cloudPushTapIntent(context: Context, notice: CloudPushNotification): Intent = pushTapIntent(context, null)
    .putExtra(EXTRA_PUSH_CLOUD, notice.json())
    // PendingIntent equality ignores extras. A distinct data URI prevents hash collisions retargeting another alert.
    .setData(Uri.Builder().scheme("happy-push").authority(notice.instanceId).appendPath(notice.userId).appendPath(notice.notificationId).build())

/** Bounded, process-restart-safe deduplication. No push capability or displayed message content is stored. */
class CloudPushSeen(private val prefs: SharedPreferences) {
    fun take(key: String): Boolean = synchronized(lock) {
        val previous = try { prefs.getString(KEY, null)?.let { Json.decodeFromString<List<String>>(it) }.orEmpty() } catch (_: Exception) { emptyList() }
        if (key in previous) return@synchronized false
        // Persist before posting: do not replay an alert after a process restart.
        prefs.edit().putString(KEY, Json.encodeToString((previous + key).takeLast(256))).commit()
    }
    companion object {
        private const val KEY = "seen"
        private val lock = Any()
    }
}

/** Data-only FCM lets Android discard a Cloud alert whose exact account is no longer signed in. No network calls. */
suspend fun presentCloudPush(context: Context, push: RemotePush, connections: AgentConnections) {
    if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
    val notice = CloudPushNotification.parse(push.body) ?: return
    val account = cloudPushConnection(connections.accounts.value, notice.instanceId, notice.userId) ?: return
    val credential = try {
        connections.credentials(account.id)?.oauth ?: return
    } catch (e: kotlinx.coroutines.CancellationException) {
        throw e
    } catch (_: Exception) { return }
    if (credential.userId != notice.userId) return
    // Credentials can disappear while read from Keystore; check the registry again before showing anything.
    if (cloudPushConnection(connections.accounts.value, notice.instanceId, notice.userId)?.id != account.id) return
    val seen = CloudPushSeen(context.getSharedPreferences("cloud-push-notifications", Context.MODE_PRIVATE))
    if (!seen.take(notice.key)) return
    presentNotification(context, push.copy(tag = "cloud:${notice.key}"), cloudPushTapIntent(context, notice))
}