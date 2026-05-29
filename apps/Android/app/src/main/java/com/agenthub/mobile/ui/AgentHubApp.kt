package com.agenthub.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsTopHeight
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.agenthub.mobile.MobileViewModel
import com.agenthub.mobile.ui.screens.ChatShell

@Composable
fun AgentHubApp(viewModel: MobileViewModel = viewModel()) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()

    Surface(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .background(MaterialTheme.colorScheme.background),
        ) {
            Spacer(
                modifier = Modifier
                    .windowInsetsTopHeight(WindowInsets.statusBars)
                    .background(MaterialTheme.colorScheme.background),
            )
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxSize(),
            ) {
                ChatShell(
                    state = state,
                    onDisconnect = viewModel::disconnect,
                    onRefresh = viewModel::refreshAll,
                    onCreateSession = viewModel::createSession,
                    onOpenWorkspaceGroupSession = viewModel::openWorkspaceGroupSession,
                    onOpenAgentContact = viewModel::openAgentContact,
                    onSelectSession = viewModel::selectSession,
                    onSendMessage = viewModel::sendMessage,
                    onArchiveSession = viewModel::archiveSession,
                    onUnarchiveSession = viewModel::unarchiveSession,
                    onDeleteSession = viewModel::deleteSession,
                    onStartOffice = viewModel::startOffice,
                    onOpenFirewall = viewModel::openFirewallPort,
                    onInstallCodingTools = viewModel::installCodingTools,
                    onRepairCodingTools = viewModel::repairCodingTools,
                    onScanPairingQr = viewModel::connectWithPairingQr,
                )
            }
        }
    }
}
