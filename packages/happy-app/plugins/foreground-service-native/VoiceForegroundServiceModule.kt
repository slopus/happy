package __PACKAGE__.foregroundservice

import android.content.Intent
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise

class VoiceForegroundServiceModule(
    private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "VoiceForegroundService"

    @ReactMethod
    fun start(promise: Promise) {
        try {
            val intent = Intent(reactContext, VoiceForegroundService::class.java)
            reactContext.startForegroundService(intent)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("FOREGROUND_SERVICE_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun stop(promise: Promise) {
        try {
            val intent = Intent(reactContext, VoiceForegroundService::class.java)
            reactContext.stopService(intent)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("FOREGROUND_SERVICE_ERROR", e.message, e)
        }
    }
}
