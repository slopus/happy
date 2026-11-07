package com.slopus.happy.ui.connection

import androidx.navigation.NavHostController
import com.slopus.happy.AppGraph
import com.slopus.happy.connection.HappyCloud
import com.slopus.happy.ui.SettingsRoute

/**
 * Where a settings link (`happy://settings/<page>`, API.md "Settings
 * links") goes on this phone, as iOS maps it: the app's own page where it
 * has one, a Happy Cloud server's web settings for the rest, and nothing
 * on any other connection. Opening one only navigates.
 */
sealed interface SettingsPlace {
    /** The connection's Settings, which lists every account on the phone too. */
    data object General : SettingsPlace
    data object Profile : SettingsPlace
    data object Sharing : SettingsPlace
    data object Voice : SettingsPlace
    /** Happy Cloud's servers. */
    data object Servers : SettingsPlace
    data object Members : SettingsPlace
    /** The page in the web app, in a Custom Tab. */
    data class Web(val url: String) : SettingsPlace
}

object SettingsLinks {
    /** [page] on a connection to [server]; [cloud] when that is a Happy Cloud server this build signs in to. Null where it's inert. */
    fun place(page: String, server: String?, cloud: Boolean): SettingsPlace? = when (page) {
        "general" -> SettingsPlace.General
        "account" -> SettingsPlace.Profile
        "sharing" -> SettingsPlace.Sharing
        "voice" -> SettingsPlace.Voice
        "servers" -> if (cloud) SettingsPlace.Servers else SettingsPlace.General
        "members" -> if (cloud) SettingsPlace.Members else null
        else -> if (cloud) HappyCloud.webSettings(server, page)?.let(SettingsPlace::Web) else null
    }

    /** [page] on agent connection [connectionId]. */
    fun place(graph: AppGraph, connectionId: String, page: String): SettingsPlace? {
        val server = graph.agentConnections.accounts.value.firstOrNull { it.id == connectionId }?.server
        return place(page, server, cloud = graph.cloudAccount != null && HappyCloud.isServer(server))
    }
}

/** Opens [page] of [connectionId]'s settings, a web page through [openWeb], or nothing where the phone has no such page. */
fun NavHostController.openSettingsLink(graph: AppGraph, connectionId: String, page: String, openWeb: (String) -> Unit) {
    when (val place = SettingsLinks.place(graph, connectionId, page)) {
        SettingsPlace.General -> navigate(SettingsRoute())
        SettingsPlace.Profile -> navigate(AgentProfileRoute(connectionId))
        SettingsPlace.Sharing -> navigate(AgentSharingRoute(connectionId))
        SettingsPlace.Voice -> navigate(AgentVoiceRoute(connectionId))
        SettingsPlace.Members -> navigate(CloudMembersRoute(connectionId))
        SettingsPlace.Servers -> {
            // As the account menu's Connect: a pass whose hour is up opens on the sign-in.
            graph.cloudAccount?.signedIn()
            navigate(CloudRoute) { launchSingleTop = true }
        }
        is SettingsPlace.Web -> openWeb(place.url)
        null -> Unit
    }
}
