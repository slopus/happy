package com.slopus.happy.ui.connection

import com.slopus.happy.BuildConfig
import com.slopus.happy.agent.HappyUrls
import com.slopus.happy.connection.HappyCloud
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Where each settings page goes: the app's own page, a Happy Cloud server's web settings, or nowhere (iOS's mapping). */
class SettingsLinksTest {
    private val cloud = "https://acme.${BuildConfig.HAPPY_CLOUD_BASE}"
    private val desktop = "https://studio.example"

    @Test
    fun pagesTheAppHasOpenInTheApp() {
        for (server in listOf(cloud, desktop)) {
            val isCloud = server == cloud
            assertEquals(SettingsPlace.General, SettingsLinks.place("general", server, isCloud))
            assertEquals(SettingsPlace.Profile, SettingsLinks.place("account", server, isCloud))
            assertEquals(SettingsPlace.Sharing, SettingsLinks.place("sharing", server, isCloud))
            assertEquals(SettingsPlace.Voice, SettingsLinks.place("voice", server, isCloud))
        }
        assertEquals(SettingsPlace.Servers, SettingsLinks.place("servers", cloud, cloud = true))
        assertEquals(SettingsPlace.General, SettingsLinks.place("servers", desktop, cloud = false))
        assertEquals(SettingsPlace.Members, SettingsLinks.place("members", cloud, cloud = true))
    }

    @Test
    fun theRestAreTheServersWebSettingsOnHappyCloudAndNothingElsewhere() {
        val web = HappyUrls.SETTINGS_PAGES - setOf("general", "account", "sharing", "voice", "servers", "members")
        for (page in web) {
            assertEquals(page, SettingsPlace.Web(HappyCloud.webSettings(cloud, page)!!), SettingsLinks.place(page, cloud, cloud = true))
            assertEquals("https://acme.${BuildConfig.HAPPY_CLOUD_WEB}/#/settings/$page", HappyCloud.webSettings(cloud, page))
            assertNull(page, SettingsLinks.place(page, desktop, cloud = false))
        }
        assertNull(SettingsLinks.place("members", desktop, cloud = false))
    }
}
