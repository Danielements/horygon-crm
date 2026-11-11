package com.horygon.myapplication.data

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKeys

class SessionStore(context: Context) {
    private val prefs = run {
        val masterKeyAlias = MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC)
        EncryptedSharedPreferences.create(
            PREF_NAME,
            masterKeyAlias,
            context,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    fun saveSession(session: SessionData) {
        prefs.edit()
            .putString(KEY_BASE_URL, session.baseUrl)
            .putString(KEY_TOKEN, session.token)
            .putInt(KEY_CUSTOMER_ID, session.customerId)
            .putString(KEY_EMAIL, session.email)
            .apply()
    }

    fun readSession(): SessionData? {
        val token = prefs.getString(KEY_TOKEN, null).orEmpty()
        if (token.isBlank()) return null
        return SessionData(
            baseUrl = prefs.getString(KEY_BASE_URL, DEFAULT_BASE_URL) ?: DEFAULT_BASE_URL,
            token = token,
            customerId = prefs.getInt(KEY_CUSTOMER_ID, -1),
            email = prefs.getString(KEY_EMAIL, "").orEmpty()
        )
    }

    fun clearSession() {
        prefs.edit()
            .remove(KEY_TOKEN)
            .remove(KEY_CUSTOMER_ID)
            .remove(KEY_EMAIL)
            .apply()
    }

    fun saveBaseUrl(baseUrl: String) {
        prefs.edit().putString(KEY_BASE_URL, baseUrl).apply()
    }

    fun readBaseUrl(): String = prefs.getString(KEY_BASE_URL, DEFAULT_BASE_URL) ?: DEFAULT_BASE_URL

    companion object {
        private const val PREF_NAME = "horygon_app_secure"
        private const val KEY_BASE_URL = "base_url"
        private const val KEY_TOKEN = "token"
        private const val KEY_CUSTOMER_ID = "customer_id"
        private const val KEY_EMAIL = "email"
        private const val DEFAULT_BASE_URL = "https://app.horygon.com/"
    }
}
