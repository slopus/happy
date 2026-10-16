package com.slopus.happy

import android.app.Application
import com.slopus.happy.push.PushServices

class HappyApplication : Application() {
    val graph: AppGraph by lazy {
        AppGraph(
            context = this,
            clientId = "android/${BuildConfig.VERSION_NAME}",
            defaultServerUrl = BuildConfig.DEFAULT_SERVER_URL,
        ).also { PushServices.unregisterOnLogout(this, it) }
    }
}
