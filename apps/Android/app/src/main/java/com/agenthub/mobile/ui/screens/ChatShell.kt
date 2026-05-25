package com.agenthub.mobile.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agenthub.mobile.data.Message
import com.agenthub.mobile.data.MobileUiState
import com.agenthub.mobile.data.Session

@Composable
fun ChatShell(
    state: MobileUiState,
    onDisconnect: () -> Unit,
    onRefresh: () -> Unit,
    onCreateSession: () -> Unit,
    onSelectSession: (String) -> Unit,
    onSendMessage: (String) -> Unit,
) {
    var showSessions by remember { mutableStateOf(state.selectedSession == null) }

    LaunchedEffect(state.selectedSessionId) {
        if (state.selectedSessionId == null) showSessions = true
    }

    Column(modifier = Modifier.fillMaxSize()) {
        MobileTopBar(
            title = if (showSessions) "会话" else state.selectedSession?.title.orEmpty().ifBlank { "AgentHub" },
            connected = state.connected,
            onOpenSessions = { showSessions = true },
            onDisconnect = onDisconnect,
        )
        if (!state.error.isNullOrBlank()) {
            Text(
                text = state.error,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(MaterialTheme.colorScheme.error.copy(alpha = 0.14f))
                    .padding(horizontal = 16.dp, vertical = 8.dp),
                color = MaterialTheme.colorScheme.error,
                fontSize = 12.sp,
            )
        }
        if (showSessions) {
            SessionListScreen(
                sessions = state.sessions,
                selectedSessionId = state.selectedSessionId,
                onRefresh = onRefresh,
                onCreateSession = onCreateSession,
                onSelect = {
                    onSelectSession(it.id)
                    showSessions = false
                },
            )
        } else {
            ConversationScreen(
                state = state,
                onOpenSessions = { showSessions = true },
                onSendMessage = onSendMessage,
            )
        }
    }
}

@Composable
private fun MobileTopBar(
    title: String,
    connected: Boolean,
    onOpenSessions: () -> Unit,
    onDisconnect: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surface)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Text(
                text = if (connected) "已连接电脑端" else "正在重连",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontSize = 12.sp,
            )
        }
        OutlinedButton(onClick = onOpenSessions) {
            Text("会话")
        }
        OutlinedButton(onClick = onDisconnect) {
            Text("断开")
        }
    }
}

@Composable
private fun SessionListScreen(
    sessions: List<Session>,
    selectedSessionId: String?,
    onRefresh: () -> Unit,
    onCreateSession: () -> Unit,
    onSelect: (Session) -> Unit,
) {
    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Button(onClick = onCreateSession, modifier = Modifier.weight(1f)) {
                Text("新建会话")
            }
            OutlinedButton(onClick = onRefresh) {
                Text("刷新")
            }
        }
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(sessions, key = { it.id }) { session ->
                SessionRow(
                    session = session,
                    selected = session.id == selectedSessionId,
                    onClick = { onSelect(session) },
                )
            }
        }
    }
}

@Composable
private fun SessionRow(session: Session, selected: Boolean, onClick: () -> Unit) {
    Column(
        modifier = Modifier
            .padding(horizontal = 16.dp)
            .clip(RoundedCornerShape(18.dp))
            .background(
                if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.18f)
                else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f),
            )
            .clickable(onClick = onClick)
            .padding(14.dp),
    ) {
        Text(
            text = session.title.ifBlank { "未命名会话" },
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            fontWeight = FontWeight.SemiBold,
        )
        Text(
            text = if (session.type == "group") "Agent Group" else "Direct Agent",
            modifier = Modifier.padding(top = 4.dp),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            fontSize = 12.sp,
        )
    }
}

@Composable
private fun ConversationScreen(
    state: MobileUiState,
    onOpenSessions: () -> Unit,
    onSendMessage: (String) -> Unit,
) {
    var input by remember(state.selectedSessionId) { mutableStateOf("") }
    val messages = state.messages + listOfNotNull(state.streamingMessage)

    Column(modifier = Modifier.fillMaxSize()) {
        if (state.selectedSession == null) {
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                OutlinedButton(onClick = onOpenSessions) {
                    Text("选择会话")
                }
            }
            return
        }
        LazyColumn(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item { Spacer(modifier = Modifier.height(8.dp)) }
            items(messages, key = { it.id }) { message ->
                MessageBubble(message)
            }
            if (state.agentTyping && state.streamingMessage == null) {
                item {
                    Text(
                        text = "Agent 正在思考...",
                        modifier = Modifier.padding(horizontal = 18.dp, vertical = 6.dp),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        fontSize = 12.sp,
                    )
                }
            }
            item { Spacer(modifier = Modifier.height(8.dp)) }
        }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(MaterialTheme.colorScheme.surface)
                .padding(12.dp),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            OutlinedTextField(
                value = input,
                onValueChange = { input = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text("发送消息给 AgentHub") },
                maxLines = 4,
            )
            Button(
                onClick = {
                    onSendMessage(input)
                    input = ""
                },
                enabled = input.isNotBlank(),
                colors = ButtonDefaults.buttonColors(),
            ) {
                Text("发送")
            }
        }
    }
}

@Composable
private fun MessageBubble(message: Message) {
    val isUser = message.senderType == "user"
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth(0.86f)
                .clip(RoundedCornerShape(20.dp))
                .background(
                    if (isUser) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.surfaceVariant,
                )
                .padding(14.dp),
        ) {
            Text(
                text = if (isUser) "你" else senderLabel(message),
                color = if (isUser) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = message.content.ifBlank { " " },
                modifier = Modifier.padding(top = 6.dp),
                color = if (isUser) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface,
                lineHeight = 20.sp,
            )
        }
    }
}

private fun senderLabel(message: Message): String {
    return when (message.senderType) {
        "agent" -> "Agent"
        "system" -> "System"
        else -> message.senderType.ifBlank { "AgentHub" }
    }
}
