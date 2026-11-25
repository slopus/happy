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
    /** A local daemon this phone is paired with, and a push as that daemon sends one: for `standalone`, a title and no second line. */
    private val paired = AgentConnection("connection-paired", "Studio", addedAt = 2, instanceId = "k3x9q2m7p0a4b8c1d5e6f7g2", pushRegistrations = true)
    private val local = CloudPushNotification("k3x9q2m7p0a4b8c1d5e6f7g2", "standalone", "agent-local", "notification-local")
    private val localPush get() = RemotePush("Scratch volume down to 16 GB free", null, local.json(), "messages", "provider-message-id")

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

    private fun pairings(accounts: List<AgentConnection> = listOf(paired), deviceToken: Boolean = true): AgentConnections {
        val registry = context.getSharedPreferences("cloud-push-test-registry", Context.MODE_PRIVATE)
        registry.edit().putString("accounts", Json.encodeToString(accounts)).commit()
        val secrets = ExpoSecureStore(context.getSharedPreferences("cloud-push-test-secrets", Context.MODE_PRIVATE), SoftwareKeys())
        if (deviceToken) secrets.setItem(paired.id, Json.encodeToString(AgentConnectionCredentials("tcAddress", 24781, "device", "device-token")))
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
        for (invalid in listOf(account.copy(signInRequired = true), account.copy(profileRequired = true), account.copy(revoked = true), account.copy(userId = null))) {
            assertNull(cloudPushConnection(listOf(invalid), notice.instanceId, notice.userId))
        }
        // A team's own server is matched as a Happy Cloud one is: by its installation and member, whatever its host.
        val selfHosted = account.copy(server = "https://happy.team.example")
        assertEquals(selfHosted, cloudPushConnection(listOf(selfHosted), notice.instanceId, notice.userId))
    }

    @Test fun aStandalonePushOpensOnlyOnAPairingOfThatInstallation() {
        val signIn = account.copy(id = "sign-in", server = "https://happy.team.example", instanceId = local.instanceId)
        assertEquals(paired, cloudPushConnection(listOf(signIn, paired), local.instanceId, "standalone", open = signIn.id))
        assertNull(cloudPushConnection(listOf(signIn), local.instanceId, "standalone"))
        assertNull(cloudPushConnection(listOf(signIn.copy(userId = null)), local.instanceId, "standalone"))
        assertNull(cloudPushConnection(listOf(paired), "iother89pp9j4f4edhsw7rpz", "standalone"))
        assertNull(cloudPushConnection(listOf(paired.copy(instanceId = null)), local.instanceId, "standalone"))
        assertNull(cloudPushConnection(listOf(paired.copy(revoked = true)), local.instanceId, "standalone"))
    }

    @Test fun aMemberPushNeverOpensOnAStandalonePairingOrAnotherMembers() {
        assertNull(cloudPushConnection(listOf(paired), local.instanceId, "member-one"))
        // Paired with a team's daemon, the phone acts for the member that daemon names, and for nobody else.
        val teamPairing = paired.copy(userId = "member-two")
        assertEquals(teamPairing, cloudPushConnection(listOf(teamPairing), local.instanceId, "member-two"))
        assertNull(cloudPushConnection(listOf(teamPairing), local.instanceId, "member-one"))
        assertNull(cloudPushConnection(listOf(teamPairing), local.instanceId, "standalone"))
    }

    @Test fun aPairedDaemonsPushIsShownAndItsTapOpensThatAgentOnThePairing() = runBlocking<Unit> {
        presentCloudPush(context, localPush, pairings())
        val notification = shadowOf(manager).allNotifications.single()
        assertEquals("Scratch volume down to 16 GB free", notification.extras.getString(Notification.EXTRA_TITLE))
        assertNull(notification.extras.getCharSequence(Notification.EXTRA_TEXT))
        assertTrue(DeepLinks.offer(shadowOf(notification.contentIntent).savedIntent))
        assertEquals(DeepLink.Instance(local.instanceId, HappyLink.Reference(HappyReferenceKind.Agent, "agent-local"), "standalone"), DeepLinks.pending.value)
    }

    @Test fun aStandalonePushForAnotherInstallationOrAForgottenPairingNeverDisplays() = runBlocking<Unit> {
        presentCloudPush(context, localPush.copy(body = local.copy(instanceId = "iother89pp9j4f4edhsw7rpz").json()), pairings())
        presentCloudPush(context, localPush, pairings(deviceToken = false))
        presentCloudPush(context, localPush, pairings(listOf(paired.copy(revoked = true))))
        presentCloudPush(context, localPush, pairings(listOf(paired.copy(userId = "member-two"))))
        presentCloudPush(context, localPush.copy(body = local.copy(userId = "member-one").json()), pairings())
        // A sign-in to the same installation is another person's: the installation's one person is not them.
        presentCloudPush(context, localPush, connections(listOf(account.copy(instanceId = local.instanceId)), credentialUser = "standalone"))
        assertTrue(shadowOf(manager).allNotifications.isEmpty())
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