package com.slopus.happy.camera

import android.content.Context
import android.hardware.camera2.CameraManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Hardware, without permission or a session. Null means the camera service could not answer. */
internal suspend fun cameraPresent(context: Context): Boolean? = withContext(Dispatchers.IO) {
    try {
        context.getSystemService(CameraManager::class.java)?.cameraIdList?.isNotEmpty()
    } catch (_: Exception) {
        null
    }
}
