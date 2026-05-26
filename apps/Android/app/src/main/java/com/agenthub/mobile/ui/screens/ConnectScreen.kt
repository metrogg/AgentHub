package com.agenthub.mobile.ui.screens

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

private val Ink = Color(0xFF171717)
private val PageBackground = Color(0xFFFCFCFA)
private val Hairline = Color(0xFFE8E6E0)
private val MutedText = Color(0xFF71716B)

@Composable
fun ConnectScreen(
    connecting: Boolean,
    error: String?,
    onConnect: (baseUrl: String, authToken: String?) -> Unit,
    onScanPairingQr: (String) -> Unit,
) {
    var baseUrl by remember { mutableStateOf("http://10.0.2.2:8000") }
    var token by remember { mutableStateOf("") }
    val qrLauncher = rememberLauncherForActivityResult(ScanContract()) { result ->
        val contents = result.contents
        if (!contents.isNullOrBlank()) onScanPairingQr(contents)
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(PageBackground)
            .padding(22.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(58.dp)
                    .clip(RoundedCornerShape(18.dp))
                    .background(Ink),
                contentAlignment = Alignment.Center,
            ) {
                Text("AH", color = Color.White, fontWeight = FontWeight.Black, fontSize = 19.sp)
            }
            Spacer(modifier = Modifier.width(14.dp))
            Column {
                Text("AgentHub", fontSize = 32.sp, fontWeight = FontWeight.Bold, color = Ink)
                Text("移动端轻量 IM 控制台", color = MutedText, fontSize = 14.sp)
            }
        }

        Spacer(modifier = Modifier.height(26.dp))
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(26.dp))
                .background(Color.White)
                .border(1.dp, Hairline, RoundedCornerShape(26.dp))
                .padding(18.dp),
        ) {
            PairingStep("1", "在电脑端打开移动端扫码连接")
            PairingStep("2", "手机扫码后会共享历史会话和流式输出")
            PairingStep("3", "也可以手动填写同局域网 Server 地址")

            Spacer(modifier = Modifier.height(16.dp))
            OutlinedTextField(
                value = baseUrl,
                onValueChange = { baseUrl = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("电脑端 Server 地址") },
                singleLine = true,
            )
            OutlinedTextField(
                value = token,
                onValueChange = { token = it },
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 12.dp),
                label = { Text("设备 Token（配对前可留空）") },
                singleLine = true,
            )

            AnimatedVisibility(
                visible = !error.isNullOrBlank(),
                enter = slideInVertically { -it / 2 } + fadeIn(),
                exit = fadeOut(),
            ) {
                Text(
                    text = error.orEmpty(),
                    modifier = Modifier.padding(top = 12.dp),
                    color = MaterialTheme.colorScheme.error,
                    fontSize = 13.sp,
                )
            }

            Button(
                onClick = { onConnect(baseUrl, token.takeIf { it.isNotBlank() }) },
                enabled = !connecting,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 18.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Ink),
            ) {
                if (connecting) {
                    CircularProgressIndicator(modifier = Modifier.padding(end = 10.dp), strokeWidth = 2.dp)
                }
                Text(if (connecting) "正在连接" else "连接电脑端")
            }
            OutlinedButton(
                onClick = {
                    qrLauncher.launch(
                        ScanOptions()
                            .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                            .setPrompt("扫描电脑端 AgentHub 配对二维码")
                            .setBeepEnabled(false)
                            .setOrientationLocked(false),
                    )
                },
                enabled = !connecting,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 10.dp),
            ) {
                Text("扫码连接局域网")
            }
        }

        Text(
            text = "模拟器默认使用 10.0.2.2 访问宿主机；真机请填写电脑局域网 IP。",
            modifier = Modifier.padding(top = 16.dp),
            color = MutedText,
            fontSize = 12.sp,
        )
    }
}

@Composable
private fun PairingStep(number: String, text: String) {
    Row(
        modifier = Modifier.padding(bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(24.dp)
                .clip(CircleShape)
                .background(Color(0xFFF1F1EE)),
            contentAlignment = Alignment.Center,
        ) {
            Text(number, color = Ink, fontWeight = FontWeight.Bold, fontSize = 12.sp)
        }
        Spacer(modifier = Modifier.width(10.dp))
        Text(text, color = MutedText, fontSize = 13.sp)
    }
}
