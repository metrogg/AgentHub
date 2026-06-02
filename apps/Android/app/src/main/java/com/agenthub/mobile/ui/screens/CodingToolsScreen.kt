package com.agenthub.mobile.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agenthub.mobile.data.MobileUiState
import com.agenthub.mobile.data.MobileWorkbenchCodingToolItem

private val Ink = Color(0xFFF4F7FA)
private val MutedText = Color(0xFF92A0AE)
private val PanelBackground = Color(0xFF1B2530)
private val PageBackground = Color(0xFF121B24)
private val SuccessGreen = Color(0xFF55D66B)
private val ErrorRed = Color(0xFFFF6B78)
private val TgBlue = Color(0xFF4EA2F6)
private val SoftFill = Color(0xFF22303F)

@Composable
fun CodingToolsScreen(
    state: MobileUiState,
    onBack: () -> Unit,
    onInstall: () -> Unit,
    onRepair: () -> Unit,
    onRefresh: () -> Unit,
) {
    val tools = state.workbench?.codingTools
    val items = tools?.items.orEmpty()
    val readyCount = items.count { it.ready }
    val platform = tools?.platform.orEmpty()

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .background(PageBackground)
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // Summary header
        item {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(14.dp))
                    .background(PanelBackground)
                    .padding(18.dp),
            ) {
                Text("Coding Tools", color = Ink, fontWeight = FontWeight.Bold, fontSize = 20.sp)
                Text(
                    "本机 CLI 探测与执行状态",
                    color = MutedText, fontSize = 14.sp, modifier = Modifier.padding(top = 8.dp),
                )
                Spacer(modifier = Modifier.height(12.dp))
                Row(
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    MetricTile("就绪", "$readyCount", Modifier.weight(1f))
                    MetricTile("总计", "${items.size}", Modifier.weight(1f))
                    MetricTile("平台", platform.ifBlank { "-" }, Modifier.weight(1f))
                }
                Spacer(modifier = Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = onInstall, modifier = Modifier.weight(1f)) {
                        Text("安装缺失 CLI")
                    }
                    Button(
                        onClick = onRepair,
                        modifier = Modifier.weight(1f),
                        colors = ButtonDefaults.buttonColors(containerColor = TgBlue),
                    ) {
                        Text("修复/重启")
                    }
                }
                Spacer(modifier = Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        if (tools?.localCliProbesEnabled == true) "本地探测: 开启" else "本地探测: 关闭",
                        color = MutedText, fontSize = 11.sp,
                    )
                    Text(
                        if (tools?.executionEnabled == true) "执行: 开启" else "执行: 关闭",
                        color = MutedText, fontSize = 11.sp,
                    )
                }
            }
        }

        // Loading indicator
        if (state.workbenchLoading) {
            item {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(14.dp))
                        .background(PanelBackground)
                        .padding(16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.Center,
                ) {
                    CircularProgressIndicator(modifier = Modifier.height(20.dp).width(20.dp), strokeWidth = 2.dp)
                    Spacer(modifier = Modifier.width(8.dp))
                    Text("同步中...", color = MutedText, fontSize = 13.sp)
                }
            }
        }

        // Section header
        item {
            Text(
                "CLI 工具详情",
                color = Ink, fontWeight = FontWeight.Bold, fontSize = 16.sp,
                modifier = Modifier.padding(horizontal = 4.dp),
            )
        }

        if (items.isEmpty()) {
            item {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(14.dp))
                        .background(PanelBackground)
                        .padding(16.dp),
                ) {
                    Text("暂无 CLI 探测结果", color = Ink, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                    Text(
                        "请确保电脑端已启用本地 CLI 探测 (ENABLE_LOCAL_CLI_PROBES=true)，然后点击同步。",
                        color = MutedText, fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp), lineHeight = 18.sp,
                    )
                }
            }
        } else {
            items(items, key = { it.id }) { tool ->
                CodingToolDetailCard(tool = tool)
            }
        }

        // Supported tools info
        item {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(14.dp))
                    .background(PanelBackground)
                    .padding(14.dp),
            ) {
                Text("支持的 Code Agent", color = Ink, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                Text(
                    "Codex CLI、Claude Code、OpenCode、Gemini CLI",
                    color = MutedText, fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp), lineHeight = 18.sp,
                )
                Text(
                    "这些工具是 Agent 执行任务的基础运行时。确保至少一个 CLI 处于 ready 状态才能正常执行任务。",
                    color = MutedText, fontSize = 11.sp, modifier = Modifier.padding(top = 6.dp), lineHeight = 17.sp,
                )
            }
        }

        // Sync button
        item {
            OutlinedButton(
                onClick = onRefresh,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("刷新工作台数据")
            }
        }

        item { Spacer(modifier = Modifier.height(84.dp)) }
    }
}

@Composable
private fun MetricTile(label: String, value: String, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(12.dp))
            .background(SoftFill)
            .padding(12.dp),
    ) {
        Text(value, color = Ink, fontWeight = FontWeight.Bold, fontSize = 18.sp)
        Text(label, modifier = Modifier.padding(top = 3.dp), color = MutedText, fontSize = 11.sp)
    }
}

@Composable
private fun CodingToolDetailCard(tool: MobileWorkbenchCodingToolItem) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(PanelBackground)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        // Header row
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    tool.name,
                    color = Ink, fontWeight = FontWeight.Bold, fontSize = 15.sp,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                Text(
                    tool.command,
                    color = MutedText, fontSize = 12.sp,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            StatusBadge(ready = tool.ready)
        }

        // Status detail
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            DetailChip("installed", tool.installed)
            DetailChip("configured", tool.configured)
            DetailChip("enabled", tool.executionEnabled)
        }

        // Version & config
        if (!tool.version.isNullOrBlank()) {
            Row {
                Text("版本: ", color = MutedText, fontSize = 12.sp)
                Text(tool.version, color = Ink, fontSize = 12.sp, fontWeight = FontWeight.Medium)
            }
        }
        if (!tool.configEnv.isNullOrBlank()) {
            Row {
                Text("配置环境: ", color = MutedText, fontSize = 12.sp)
                Text(tool.configEnv, color = Ink, fontSize = 12.sp, fontWeight = FontWeight.Medium)
            }
        }

        // Status messages
        if (tool.configMessage.isNotBlank()) {
            Text(tool.configMessage, color = MutedText, fontSize = 11.sp, lineHeight = 16.sp)
        }
        if (tool.readiness.isNotBlank()) {
            Text(
                tool.readiness,
                color = if (tool.ready) SuccessGreen else ErrorRed,
                fontSize = 11.sp, lineHeight = 16.sp,
            )
        }
        if (tool.docsHint.isNotBlank()) {
            Text(
                "提示：${tool.docsHint}",
                color = MutedText, fontSize = 11.sp, lineHeight = 16.sp,
            )
        }
    }
}

@Composable
private fun StatusBadge(ready: Boolean) {
    Text(
        text = if (ready) "✓ Ready" else "✗ Not Ready",
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(if (ready) Color(0xFF163523) else Color(0xFF3A1F25))
            .padding(horizontal = 10.dp, vertical = 5.dp),
        color = if (ready) SuccessGreen else ErrorRed,
        fontSize = 11.sp,
        fontWeight = FontWeight.SemiBold,
    )
}

@Composable
private fun DetailChip(label: String, value: Boolean) {
    Text(
        text = "$label: ${if (value) "✓" else "✗"}",
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(if (value) SoftFill else PanelBackground)
            .padding(horizontal = 9.dp, vertical = 4.dp),
        color = if (value) SuccessGreen else MutedText,
        fontSize = 10.sp,
    )
}
