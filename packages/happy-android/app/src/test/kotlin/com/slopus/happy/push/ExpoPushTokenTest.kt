package com.slopus.happy.push

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList

/**
 * expo-notifications 55 getExpoPushTokenAsync on Android, against a mock
 * of Expo's endpoint: the exact request it sends and how it reads the
 * answer, and the InstallationId it sends as the device id.
 */
@RunWith(AndroidJUnit4::class)
class ExpoPushTokenTest {
    private val server = MockWebServer()
    private val requests = CopyOnWriteArrayList<RecordedRequest>()
    private var respond: (RecordedRequest) -> MockResponse = { json(200, """{"data":{"expoPushToken":"ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]"}}""") }
    private lateinit var client: ExpoPushTokenClient

    private val context: Context get() = ApplicationProvider.getApplicationContext()

    private fun json(code: Int, body: String) = MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build()

    @Before
    fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                return respond(request)
            }
        }
        server.start()
        client = ExpoPushTokenClient(OkHttpClient(), url = server.url("/--/api/v2/push/getExpoPushToken").toString())
    }

    @After
    fun tearDown() = server.close()

    private fun exchange(fcm: String = "fcm:token-1", installationId: String = "6F1C1A44-5E0B-4D9A-9C0B-2B1F6A0C9E71") =
        runBlocking { client.exchange(fcm, installationId, applicationId = "com.ex3ndr.happy") }

    @Test
    fun theRequestIsTheOneExpoBuilds() {
        assertEquals("ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]", exchange())
        assertEquals("https://exp.host/--/api/v2/push/getExpoPushToken", ExpoPushTokenClient.PRODUCTION_URL)
        assertEquals("4558dd3d-cd5a-47cd-bad9-e591a241cc06", EXPO_PROJECT_ID)

        val request = requests.single()
        assertEquals("POST", request.method)
        assertEquals("/--/api/v2/push/getExpoPushToken", request.url.encodedPath)
        assertEquals("application/json", request.headers["Content-Type"])
        // Nothing of Happy's goes to Expo.
        assertNull(request.headers["Authorization"])
        assertNull(request.headers["X-Happy-Client"])
        // JSON.stringify of expo's body object, keys in its order; the device id lowercased.
        assertEquals(
            """{"type":"fcm","deviceId":"6f1c1a44-5e0b-4d9a-9c0b-2b1f6a0c9e71","development":false,""" +
                """"appId":"com.ex3ndr.happy","deviceToken":"fcm:token-1","projectId":"4558dd3d-cd5a-47cd-bad9-e591a241cc06"}""",
            request.body!!.utf8(),
        )
    }

    @Test
    fun errorStatusesFail() {
        respond = { json(503, """{"errors":[{"code":"INTERNAL_SERVER_ERROR"}]}""") }
        val error = assertThrows(ExpoPushTokenException::class.java) { exchange() }
        assertEquals(
            """Error encountered while fetching Expo token, expected an OK response, received: 503 (body: "{"errors":[{"code":"INTERNAL_SERVER_ERROR"}]}").""",
            error.message,
        )
    }

    @Test
    fun answersWithoutATokenAreMalformed() {
        listOf(
            "{}",
            """{"data":{}}""",
            """{"data":"ExponentPushToken[x]"}""",
            """{"data":{"expoPushToken":""}}""",
            """{"data":{"expoPushToken":5}}""",
            """{"data":{"expoPushToken":null}}""",
            "[]",
            "not json",
        ).forEach { body ->
            respond = { json(200, body) }
            val error = assertThrows(body, ExpoPushTokenException::class.java) { exchange() }
            assertEquals("""Malformed response from server, expected "{ data: { expoPushToken: string } }", received: $body""", error.message)
        }
    }

    @Test
    fun aNewInstallationGetsAnIdThatStays() {
        val id = InstallationId(context).getOrCreate()
        assertEquals(id, UUID.fromString(id).toString())
        assertEquals(id, InstallationId(context).getOrCreate())
        assertEquals(id, File(context.noBackupFilesDir, InstallationId.UUID_FILE_NAME).readText())
    }

    @Test
    fun theReactNativeBuildsIdIsKept() {
        val id = "0a6e3f7e-41b2-4a43-9d9c-3c1bfc1e2a55"
        File(context.noBackupFilesDir, InstallationId.UUID_FILE_NAME).writeText(id)
        assertEquals(id, InstallationId(context).getOrCreate())
    }

    @Test
    fun theLegacyPreferenceMovesToTheFile() {
        val id = "1b2c3d4e-0000-4000-8000-000000000001"
        val prefs = context.getSharedPreferences(InstallationId.LEGACY_PREFERENCES_FILE_NAME, Context.MODE_PRIVATE)
        prefs.edit().putString(InstallationId.LEGACY_PREFERENCES_UUID_KEY, id).commit()

        assertEquals(id, InstallationId(context).getOrCreate())
        assertEquals(id, File(context.noBackupFilesDir, InstallationId.UUID_FILE_NAME).readText())
        assertFalse(prefs.contains(InstallationId.LEGACY_PREFERENCES_UUID_KEY))
    }

    @Test
    fun theLegacyFileIsCopiedToTheNewOne() {
        val id = "2c3d4e5f-0000-4000-8000-000000000002"
        File(context.noBackupFilesDir, InstallationId.LEGACY_UUID_FILE_NAME).writeText(id)

        assertEquals(id, InstallationId(context).getOrCreate())
        assertEquals(id, File(context.noBackupFilesDir, InstallationId.UUID_FILE_NAME).readText())
    }

    @Test
    fun aDamagedFileIsReplaced() {
        val file = File(context.noBackupFilesDir, InstallationId.UUID_FILE_NAME)
        file.writeText("not a uuid")
        val id = InstallationId(context).getOrCreate()
        assertNotEquals("not a uuid", id)
        assertTrue(file.readText() == id)
    }
}
