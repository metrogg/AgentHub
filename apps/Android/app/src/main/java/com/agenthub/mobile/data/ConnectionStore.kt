package com.agenthub.mobile.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.connectionDataStore by preferencesDataStore(name = "agenthub_connection")

class ConnectionStore(private val context: Context) {
    val connection: Flow<ConnectionConfig?> = context.connectionDataStore.data.map { prefs ->
        val baseUrl = prefs[BASE_URL]?.takeIf { it.isNotBlank() } ?: return@map null
        ConnectionConfig(
            baseUrl = baseUrl,
            deviceName = prefs[DEVICE_NAME] ?: "Android",
            authToken = prefs[AUTH_TOKEN]?.takeIf { it.isNotBlank() },
        )
    }

    suspend fun save(config: ConnectionConfig) {
        context.connectionDataStore.edit { prefs ->
            prefs[BASE_URL] = config.baseUrl.trim().trimEnd('/')
            prefs[DEVICE_NAME] = config.deviceName.ifBlank { "Android" }
            val token = config.authToken?.trim().orEmpty()
            if (token.isBlank()) {
                prefs.remove(AUTH_TOKEN)
            } else {
                prefs[AUTH_TOKEN] = token
            }
        }
    }

    suspend fun clear() {
        context.connectionDataStore.edit { it.clear() }
    }

    private companion object {
        val BASE_URL = stringPreferencesKey("base_url")
        val DEVICE_NAME = stringPreferencesKey("device_name")
        val AUTH_TOKEN = stringPreferencesKey("auth_token")
    }
}
