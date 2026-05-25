package com.agenthub.mobile.ui

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.agenthub.mobile.MobileViewModel
import com.agenthub.mobile.ui.screens.ChatShell
import com.agenthub.mobile.ui.screens.ConnectScreen

@Composable
fun AgentHubApp(viewModel: MobileViewModel = viewModel()) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()

    Surface(modifier = Modifier.fillMaxSize()) {
        if (state.connection == null) {
            ConnectScreen(
                connecting = state.connecting,
                error = state.error,
                onConnect = viewModel::connect,
            )
        } else {
            ChatShell(
                state = state,
                onDisconnect = viewModel::disconnect,
                onRefresh = viewModel::refreshSessions,
                onCreateSession = viewModel::createSession,
                onSelectSession = viewModel::selectSession,
                onSendMessage = viewModel::sendMessage,
            )
        }
    }
}
