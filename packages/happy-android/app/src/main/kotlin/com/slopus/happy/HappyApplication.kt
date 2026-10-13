package com.slopus.happy

import android.app.Application

class HappyApplication : Application() {
    val graph: AppGraph by lazy {
        AppGraph(
            context = this,
            clientId = "android/${BuildConfig.VERSION_NAME}",
            defaultServerUrl = BuildConfig.DEFAULT_SERVER_URL,
        )
    }
}
