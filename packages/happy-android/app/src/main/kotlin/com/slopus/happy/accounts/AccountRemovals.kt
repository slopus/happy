package com.slopus.happy.accounts

import android.content.SharedPreferences

/**
 * Sign-outs under way (iOS's AccountRemovals, c7d74a4e8). An account is
 * written here before anything of it goes and struck off once its database
 * is gone, so a sign-out the process didn't live to finish is finished at
 * the next start, and the account never comes back.
 */
class AccountRemovals(private val prefs: SharedPreferences) {
    @Synchronized
    fun pending(): Set<String> = prefs.getStringSet(KEY, null).orEmpty().toSet()

    @Synchronized
    fun begin(id: String) {
        prefs.edit().putStringSet(KEY, pending() + id).commit()
    }

    @Synchronized
    fun finish(id: String) {
        prefs.edit().putStringSet(KEY, pending() - id).commit()
    }

    companion object {
        const val PREFS_NAME = "account-removals"
        private const val KEY = "ids"
    }
}
