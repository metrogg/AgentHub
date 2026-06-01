package com.agenthub.mobile

import android.app.Application
import android.os.Build
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.agenthub.mobile.data.AgentHubClient
import com.agenthub.mobile.data.AgentHubRepository
import com.agenthub.mobile.data.AgentContact
import com.agenthub.mobile.data.ConnectionConfig
import com.agenthub.mobile.data.ConnectionStore
import com.agenthub.mobile.data.MobileUiState
import com.agenthub.mobile.data.PairingPayload
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.decodeFromString
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
        viewModelScope.launch {
            connectionStore.archivedSessionIds.collect { ids ->
                repository.setArchivedSessionIds(ids)
            }
        }
    }

    fun connect(baseUrl: String, authToken: String?) {
        val trimmedUrl = baseUrl.trim().trimEnd('/')
        if (trimmedUrl.isBlank()) return
        if (isAndroidEmulatorHost(trimmedUrl) && !isProbablyEmulator()) {
            repository.setError("10.0.2.2 只适用于 Android 模拟器。真机连接手机热点时，请填写电脑在热点里获得的 IP。")
            return
        }
        viewModelScope.launch {
            connectionStore.save(
                ConnectionConfig(
                    baseUrl = trimmedUrl,
                    authToken = authToken?.trim()?.takeIf { it.isNotBlank() },
                ),
            )
        }
    }

    fun connectWithPairingQr(contents: String) {
        viewModelScope.launch {
            runCatching {
                val payload = json.decodeFromString<PairingPayload>(contents.trim())
                val confirmed = repository.confirmPairing(payload)
                connectionStore.save(
                    ConnectionConfig(
                        baseUrl = confirmed.baseUrl.trim().trimEnd('/'),
                        deviceName = confirmed.deviceName.ifBlank { "Android" },
                        authToken = confirmed.authToken?.trim()?.takeIf { it.isNotBlank() },
                    ),
                )
            }.onFailure { error ->
                repository.setError(error.message ?: "二维码无效或配对失败")
            }
        }
    }

    fun disconnect() {
        viewModelScope.launch {
            connectionStore.clear()
        }
    }

    fun refreshAll() {
        repository.refreshSessions()
        repository.refreshWorkbench()
    }

    fun refreshSessions() = refreshAll()

    fun createSession() = repository.createSession()

    fun openWorkspaceAgent(workspaceId: String, agentId: String) = repository.openWorkspaceAgent(workspaceId, agentId)

    fun openWorkspaceGroupSession(workspaceId: String) = repository.openWorkspaceGroupSession(workspaceId)

    fun openAgentContact(contact: AgentContact) = repository.openAgentContact(contact)

    fun selectSession(sessionId: String) = repository.selectSession(sessionId)

    fun sendMessage(content: String) = repository.sendMessage(content)

    fun archiveSession(sessionId: String) {
        repository.archiveSession(sessionId)
        viewModelScope.launch {
            connectionStore.saveArchivedSessionIds(uiState.value.archivedSessionIds)
        }
    }

    fun unarchiveSession(sessionId: String) {
        repository.unarchiveSession(sessionId)
        viewModelScope.launch {
            connectionStore.saveArchivedSessionIds(uiState.value.archivedSessionIds)
        }
    }

    fun deleteSession(sessionId: String) = repository.deleteSession(sessionId)

    fun startOffice() = repository.startOffice()

    fun openFirewallPort() = repository.openFirewallPort()

    fun installCodingTools() = repository.installCodingTools()

    fun repairCodingTools() = repository.repairCodingTools()

    fun fetchSettings() = repository.fetchSettings()

    fun updateSettings(settings: Map<String, String>) = repository.updateSettings(settings)

    fun testModel(request: com.agenthub.mobile.data.TestModelRequest) {
        viewModelScope.launch {
            repository.testModel(request)
        }
    }

    fun clearTestModelResult() = repository.clearTestModelResult()

    private fun isAndroidEmulatorHost(url: String): Boolean {
        return Regex("^https?://10\\.0\\.2\\.2(?::\\d+)?(?:/.*)?$", RegexOption.IGNORE_CASE).matches(url)
    }

    private fun isProbablyEmulator(): Boolean {
        return Build.FINGERPRINT.startsWith("generic") ||
            Build.FINGERPRINT.startsWith("unknown") ||
            Build.MODEL.contains("Emulator", ignoreCase = true) ||
            Build.MODEL.contains("Android SDK built for", ignoreCase = true) ||
            Build.MANUFACTURER.contains("Genymotion", ignoreCase = true) ||
            Build.BRAND.startsWith("generic") && Build.DEVICE.startsWith("generic") ||
            Build.PRODUCT == "google_sdk"
    }
}
