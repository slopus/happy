package com.slopus.happy.ui.start

import android.app.ActivityManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.PowerManager
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import com.slopus.happy.ui.components.rememberReduceMotion

/**
 * Whether the sky ([GrainGradient]) and the Happy Cloud mark
 * ([LiquidMetalMark]) move. Each holds Paper's frame 0, drawn by its own
 * shader, where a frame on every refresh costs most or isn't wanted:
 * animations removed, Battery Saver on, a low-RAM (Android Go) phone, or a
 * phone running hot (thermal status severe or worse, Android 10 and
 * later). Before Android 13 neither has a runtime shader, so both are
 * still there anyway ([ShaderStills]).
 */
@Composable
fun rememberShadersMove(): Boolean {
    val context = LocalContext.current
    val reduceMotion = rememberReduceMotion()
    val power = remember(context) { context.getSystemService(PowerManager::class.java) }
    val lowRam = remember(context) { context.getSystemService(ActivityManager::class.java)?.isLowRamDevice == true }
    var saver by remember(power) { mutableStateOf(power?.isPowerSaveMode == true) }
    var hot by remember(power) { mutableStateOf(power.hot()) }
    DisposableEffect(context, power) {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                saver = power?.isPowerSaveMode == true
            }
        }
        ContextCompat.registerReceiver(context, receiver, IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED), ContextCompat.RECEIVER_NOT_EXPORTED)
        val thermal = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && power != null) {
            PowerManager.OnThermalStatusChangedListener { hot = it >= PowerManager.THERMAL_STATUS_SEVERE }.also {
                // A phone without a thermal service just never says it is hot.
                runCatching { power.addThermalStatusListener(ContextCompat.getMainExecutor(context), it) }
            }
        } else {
            null
        }
        onDispose {
            context.unregisterReceiver(receiver)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && thermal != null) runCatching { power?.removeThermalStatusListener(thermal) }
        }
    }
    return !reduceMotion && !saver && !lowRam && !hot
}

private fun PowerManager?.hot(): Boolean =
    this != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && runCatching { currentThermalStatus >= PowerManager.THERMAL_STATUS_SEVERE }.getOrDefault(false)
