package com.slopus.happy.push

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.BuildConfig
import com.slopus.happy.agent.HappyLink
import com.slopus.happy.agent.HappyReferenceKind
import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.connection.AgentConnection
import com.slopus.happy.connection.AgentConnectionCredentials
import com.slopus.happy.connection.AgentConnections
import com.slopus.happy.connection.OAuthCredential
import com.slopus.happy.testing.SoftwareKeys
import com.slopus.happy.ui.connect.DeepLink
import com.slopus.happy.ui.connect.DeepLinks
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf

@RunWith(AndroidJUnit4::class)
class CloudPushNotificationsTest {
    private val context get() = ApplicationProvider.getApplicationContext<Context>()
    private val manager get() = context.getSystemService(NotificationManager::class.java)
    private val notice = CloudPushNotification("ipkr89pp9j4f4edhsw7rpz98", "member-one", "agent-one", "notification-one")
    private val account = AgentConnection("connection-one", "Team", addedAt = 1, server = "https://qa.${BuildConfig.HAPPY_CLOUD_BASE}", instanceId = notice.instanceId, userId = notice.userId)
    private val push get() = RemotePush("Exact agent title", "Exact agent body", notice.json(), "messages", "provider-message-id")

    @Before fun prepare() {
        manager.cancelAll()
        for (name in listOf("cloud-push-notifications", "cloud-push-test-registry", "cloud-push-test-secrets")) {
            context.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit()
        }
    }
    @After fun clear() { DeepLinks.pending.value?.let(DeepLinks::consume) }

    private fun connections(accounts: List<AgentConnection> = listOf(account), credentialUser: String? = notice.userId): AgentConnections {
        val registry = context.getSharedPreferences("cloud-push-test-registry", Context.MODE_PRIVATE)
        registry.edit().putString("accounts", Json.encodeToString(accounts)).commit()
        val secrets = ExpoSecureStore(context.getSharedPreferences("cloud-push-test-secrets", Context.MODE_PRIVATE), SoftwareKeys())
        if (credentialUser != null) {
            val credentials = AgentConnectionCredentials("qa.${BuildConfig.HAPPY_CLOUD_BASE}", 443, "", "", publicUrl = account.server, oauth = OAuthCredential("oauth", "app", userId = credentialUser))
            secrets.setItem(account.id, Json.encodeToString(credentials))
        }
        return AgentConnections(secrets, registry)
    }

    @Test fun exactNamespaceAndFieldsAreRequiredWithoutLegacyFallback() {
        assertEquals(notice, CloudPushNotification.parse(notice.json()))
        assertFalse(CloudPushNotification.owns("""{"sessionId":"s1"}"""))
        for (invalid in listOf(
            notice.json().replace("happy.cloud.push.v1", "happy.cloud.push.v2"),
            notice.json().replace("\"member-one\"", "123"),
            notice.json().replace("ipkr89pp9j4f4edhsw7rpz98", "https://evil.example"),
            notice.json().replace("agent-one", "../other"),
            notice.json().replace("\"notification-one\"", "\"\""),
            notice.json().replace("}", ",\"sessionId\":\"legacy\"}"),
            notice.json().replace("}", ",\"category\":\"turnComplete\"}"),
        )) {
            assertTrue(CloudPushNotification.owns(invalid))
            assertNull(CloudPushNotification.parse(invalid))
            presentPush(context, push.copy(body = invalid))
            assertTrue(shadowOf(manager).allNotifications.isEmpty())
            val tap = pushTapIntent(context, "legacy").putExtra(EXTRA_PUSH_CLOUD, invalid)
            assertFalse(DeepLinks.offer(tap))
            assertNull(DeepLinks.pending.value)
        }
    }

    @Test fun matchingUsesInstanceAndMemberNeverActiveAccountFallback() {
        val other = account.copy(id = "other-login", userId = "member-two")
        val accounts = listOf(other, account)
        assertEquals(account, cloudPushConnection(accounts, notice.instanceId, notice.userId, open = other.id))
        assertNull(cloudPushConnection(accounts, notice.instanceId, "unknown", open = other.id))
        assertNull(cloudPushConnection(accounts, "iother89pp9j4f4edhsw7rpz98", notice.userId, open = account.id))
        for (invalid in listOf(account.copy(signInRequired = true), account.copy(profileRequired = true), account.copy(revoked = true), account.copy(server = "https://local.example"))) {
            assertNull(cloudPushConnection(listOf(invalid), notice.instanceId, notice.userId))
        }
    }

    @Test fun realCredentialMatchDisplaysExactCopyAndTapPreservesMember() = runBlocking<Unit> {
        presentCloudPush(context, push, connections())
        val notification = shadowOf(manager).allNotifications.single()
        assertEquals("Exact agent title", notification.extras.getString(Notification.EXTRA_TITLE))
        assertEquals("Exact agent body", notification.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
        assertEquals("messages", notification.channelId)
        val intent = shadowOf(notification.contentIntent).savedIntent
        assertTrue(DeepLinks.offer(intent))
        assertEquals(DeepLink.Instance(notice.instanceId, HappyLink.Reference(HappyReferenceKind.Agent, notice.agentId), notice.userId), DeepLinks.pending.value)
    }

    @Test fun absentRemovedMismatchedOrKeylessAccountsNeverDisplay() = runBlocking<Unit> {
        presentCloudPush(context, push, connections(emptyList()))
        presentCloudPush(context, push, connections(credentialUser = null))
        presentCloudPush(context, push, connections(credentialUser = "another-member"))
        presentCloudPush(context, push, connections(listOf(account.copy(signInRequired = true))))
        assertTrue(shadowOf(manager).allNotifications.isEmpty())
    }

    @Test fun duplicateIdsSurviveReceiverRecreationWithoutStoringCopy() = runBlocking<Unit> {
        val connections = connections()
        presentCloudPush(context, push, connections)
        manager.cancelAll()
        presentCloudPush(context, push.copy(tag = "different-provider-id"), connections)
        assertTrue(shadowOf(manager).allNotifications.isEmpty())
        val prefs = context.getSharedPreferences("cloud-push-notifications", Context.MODE_PRIVATE)
        assertFalse(prefs.all.toString().contains("Exact agent"))
        assertFalse(CloudPushSeen(prefs).take(notice.key))
        assertTrue(CloudPushSeen(prefs).take(notice.copy(userId = "other-member").key))
    }

    @Test fun collidingNotificationHashesCannotRetargetAnotherTap() = runBlocking<Unit> {
        val connections = connections()
        val first = notice.copy(notificationId = "Aa")
        val second = notice.copy(notificationId = "BB", agentId = "agent-two")
        assertEquals(first.key.hashCode(), second.key.hashCode())
        presentCloudPush(context, push.copy(body = first.json()), connections)
        presentCloudPush(context, push.copy(body = second.json()), connections)
        val taps = shadowOf(manager).allNotifications.map { shadowOf(it.contentIntent).savedIntent }
        assertEquals(2, taps.map { it.data }.toSet().size)
        assertEquals(setOf(first.json(), second.json()), taps.map { it.getStringExtra(EXTRA_PUSH_CLOUD) }.toSet())
    }
}