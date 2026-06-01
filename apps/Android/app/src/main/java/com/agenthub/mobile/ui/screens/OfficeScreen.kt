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

private val Ink = Color(0xFF000000)
private val MutedText = Color(0xFF7A7A7A)
private val PanelBackground = Color.White
private val PageBackground = Color(0xFFF5F5F5)
private val TgBlue = Color(0xFF3390EC)
private val SuccessGreen = Color(0xFF07C160)
private val ErrorRed = Color(0xFFB42318)
private val WorkAmber = Color(0xFFF2A23A)

@Composable
fun OfficeScreen(
    state: MobileUiState,
    onBack: () -> Unit,
    onStartOffice: () -> Unit,
    onOpenFirewall: () -> Unit,
    onRefresh: () -> Unit,
) {
    val office = state.workbench?.office
    val connectivity = state.workbench?.connectivity
    val officeRunning = office?.running == true
    val officeStarting = office?.starting == true

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .background(PageBackground)
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // Status hero
        item {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(14.dp))
                    .background(PanelBackground)
                    .padding(18.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text("办公室", color = Ink, fontWeight = FontWeight.Bold, fontSize = 20.sp)
                        Text(
                            when {
                                officeRunning -> "Star Office 正在运行"
                                officeStarting -> "Star Office 启动中..."
                                else -> "Star Office 未启动"
                            },
                            color = when {
                                officeRunning -> SuccessGreen
                                officeStarting -> WorkAmber
                                else -> MutedText
                            },
                            fontSize = 14.sp, modifier = Modifier.padding(top = 6.dp),
                        )
                    }
                    BigStatusBadge(
                        running = officeRunning,
                        starting = officeStarting,
                    )
                }

                // Office details
                if (office != null) {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        if (office.url.isNotBlank()) {
                            DetailRow("访问地址", office.url)
                        }
                        if (office.root.isNotBlank()) {
                            DetailRow("项目目录", office.root)
                        }
                        if (office.pid != null) {
                            DetailRow("PID", office.pid.toString())
                        }
                        DetailRow("目录存在", if (office.rootExists) "是" else "否")
                        DetailRow("已启动", if (office.started) "是" else "否")
                    }
                }

                // Error display
                if (!office?.error.isNullOrBlank()) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(10.dp))
                            .background(Color(0xFFFFF5F5))
                            .padding(12.dp),
                    ) {
                        Text("错误信息", color = ErrorRed, fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
                        Text(
                            office!!.error.orEmpty(),
                            color = ErrorRed, fontSize = 12.sp, lineHeight = 18.sp,
                            modifier = Modifier.padding(top = 4.dp),
                        )
                    }
                }

                // Action buttons
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = onStartOffice,
                        modifier = Modifier.weight(1f),
                        enabled = !officeStarting && !state.workbenchLoading,
                        colors = ButtonDefaults.buttonColors(containerColor = TgBlue),
                    ) {
                        if (officeStarting || state.workbenchLoading) {
                            CircularProgressIndicator(
                                modifier = Modifier.height(16.dp).width(16.dp),
                                strokeWidth = 2.dp,
                                color = Color.White,
                            )
                            Spacer(modifier = Modifier.width(6.dp))
                        }
                        Text(if (officeRunning) "重启办公室" else "启动办公室")
                    }
                    OutlinedButton(
                        onClick = onOpenFirewall,
                        modifier = Modifier.weight(1f),
                        enabled = !state.workbenchLoading,
                    ) {
                        Text("开放端口")
                    }
                }
            }
        }

        // Network connectivity
        item {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(14.dp))
                    .background(PanelBackground)
                    .padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text("网络连通性", color = Ink, fontWeight = FontWeight.Bold, fontSize = 16.sp)

                if (connectivity != null) {
                    if (connectivity.port > 0) {
                        DetailRow("服务端口", connectivity.port.toString())
                    }

                    if (connectivity.message.isNotBlank()) {
                        Text(
                            connectivity.message,
                            color = MutedText, fontSize = 12.sp, lineHeight = 18.sp,
                        )
                    }

                    if (connectivity.localAddresses.isNotEmpty()) {
                        Text("本机地址", color = Ink, fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
                        connectivity.localAddresses.forEach { addr ->
                            Text(
                                addr,
                                color = MutedText, fontSize = 12.sp,
                                modifier = Modifier.padding(start = 8.dp, top = 2.dp),
                            )
                        }
                    }

                    if (connectivity.baseUrls.isNotEmpty()) {
                        Text("可访问 URL", color = Ink, fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
                        connectivity.baseUrls.forEach { url ->
                            Text(
                                url,
                                color = TgBlue, fontSize = 12.sp,
                                modifier = Modifier.padding(start = 8.dp, top = 2.dp),
                                maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                } else {
                    Text("未获取到网络信息，请先连接电脑端。", color = MutedText, fontSize = 12.sp)
                }
            }
        }

        // About Star Office
        item {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(14.dp))
                    .background(PanelBackground)
                    .padding(14.dp),
            ) {
                Text("关于 Star Office", color = Ink, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                Text(
                    "Star Office 是 AgentHub 的 Web 办公界面，提供可视化的 Agent 管理、任务看板和协作空间。" +
                        "启动后，同一局域网内的设备可通过浏览器访问。",
                    color = MutedText, fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp), lineHeight = 18.sp,
                )
                Text(
                    "如果手机无法访问，请先点击「开放端口」确保 Windows 防火墙允许该端口。",
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
private fun BigStatusBadge(running: Boolean, starting: Boolean) {
    val (text, color, bgColor) = when {
        running -> Triple("运行中", SuccessGreen, Color(0xFFE8F5E9))
        starting -> Triple("启动中", WorkAmber, Color(0xFFFFF8E1))
        else -> Triple("已停止", MutedText, Color(0xFFF5F5F5))
    }
    Text(
        text = text,
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(bgColor)
            .padding(horizontal = 14.dp, vertical = 7.dp),
        color = color,
        fontSize = 13.sp,
        fontWeight = FontWeight.SemiBold,
    )
}

@Composable
private fun DetailRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth()) {
        Text(
            label,
            color = MutedText, fontSize = 12.sp,
            modifier = Modifier.width(80.dp),
        )
        Text(
            value,
            color = Ink, fontSize = 12.sp, fontWeight = FontWeight.Medium,
            maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
    }
}
