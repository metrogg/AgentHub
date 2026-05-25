package com.agenthub.mobile

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.agenthub.mobile.data.AgentHubClient
import com.agenthub.mobile.data.AgentHubRepository
import com.agenthub.mobile.data.ConnectionConfig
import com.agenthub.mobile.data.ConnectionStore
import com.agenthub.mobile.data.MobileUiState
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json

class MobileViewModel(application: Application) : AndroidViewModel(application) {
    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }
    private val connectionStore = ConnectionStore(application)
    private val repository = AgentHubRepository(
        scope = viewModelScope,
        client = AgentHubClient(json),
        json = json,
    )

    val uiState: StateFlow<MobileUiState> = repository.uiState

    init {
        viewModelScope.launch {
            connectionStore.connection.collect { config ->
                if (config == null) {
                    repository.disconnect()
                } else if (uiState.value.connection != config || !uiState.value.connected) {
                    repository.connect(config)
                }
            }
        }
    }

    fun connect(baseUrl: String, authToken: String?) {
        val trimmedUrl = baseUrl.trim().trimEnd('/')
        if (trimmedUrl.isBlank()) return
        viewModelScope.launch {
            connectionStore.save(
                ConnectionConfig(
                    baseUrl = trimmedUrl,
                    authToken = authToken?.trim()?.takeIf { it.isNotBlank() },
                ),
            )
        }
    }

    fun disconnect() {
        viewModelScope.launch {
            connectionStore.clear()
        }
    }

    fun refreshSessions() = repository.refreshSessions()

    fun createSession() = repository.createSession()

    fun selectSession(sessionId: String) = repository.selectSession(sessionId)

    fun sendMessage(content: String) = repository.sendMessage(content)
}
