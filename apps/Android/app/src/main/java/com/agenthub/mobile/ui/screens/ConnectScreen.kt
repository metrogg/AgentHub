package com.agenthub.mobile.ui.screens

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.background
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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

private val TgBlue = Color(0xFF4EA2F6)
private val TgBlueLight = Color(0xFF223648)
private val Ink = Color(0xFFF4F7FA)
private val PageBackground = Color(0xFF121B24)
private val Hairline = Color(0xFF253343)
private val MutedText = Color(0xFF92A0AE)
private val SoftFill = Color(0xFF22303F)

@Composable
fun ConnectScreen(
    connecting: Boolean,
    error: String?,
    onConnect: (baseUrl: String, authToken: String?) -> Unit,
    onScanPairingQr: (String) -> Unit,
) {
    var baseUrl by remember { mutableStateOf("") }
    var token by remember { mutableStateOf("") }
    val qrLauncher = rememberLauncherForActivityResult(ScanContract()) { result ->
        val contents = result.contents
        if (!contents.isNullOrBlank()) onScanPairingQr(contents)
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(PageBackground)
            .padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // Logo (circular, Telegram style)
        Box(
            modifier = Modifier
                .size(80.dp)
                .clip(CircleShape)
                .background(TgBlue),
            contentAlignment = Alignment.Center,
        ) {
            Text("AH", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 28.sp)
        }

        Text(
            "AgentHub",
            modifier = Modifier.padding(top = 16.dp),
            fontSize = 28.sp,
            fontWeight = FontWeight.SemiBold,
            color = Ink,
        )
        Text(
            "移动端 IM 控制台",
            modifier = Modifier.padding(top = 4.dp),
            color = MutedText,
            fontSize = 15.sp,
        )

        Spacer(modifier = Modifier.height(32.dp))

        // Pairing steps
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(SoftFill)
                .padding(16.dp),
        ) {
            PairingStep("1", "在电脑端打开移动端扫码连接")
            PairingStep("2", "手机扫码后会共享历史会话和流式输出")
            PairingStep("3", "也可以手动填写同局域网 Server 地址")
        }

        Spacer(modifier = Modifier.height(20.dp))

        // Input fields (Telegram-style clean)
        TextField(
            value = baseUrl,
            onValueChange = { baseUrl = it },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("电脑端 Server 地址") },
            placeholder = { Text("http://IP:8000") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            colors = TextFieldDefaults.colors(
                focusedContainerColor = SoftFill,
                unfocusedContainerColor = SoftFill,
                focusedIndicatorColor = TgBlue,
                unfocusedIndicatorColor = Color.Transparent,
            ),
            shape = RoundedCornerShape(12.dp),
        )
        TextField(
            value = token,
            onValueChange = { token = it },
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 10.dp),
            label = { Text("设备 Token（可选）") },
            singleLine = true,
            colors = TextFieldDefaults.colors(
                focusedContainerColor = SoftFill,
                unfocusedContainerColor = SoftFill,
                focusedIndicatorColor = TgBlue,
                unfocusedIndicatorColor = Color.Transparent,
            ),
            shape = RoundedCornerShape(12.dp),
        )

        AnimatedVisibility(
            visible = !error.isNullOrBlank(),
            enter = slideInVertically { -it / 2 } + fadeIn(),
            exit = fadeOut(),
        ) {
            Text(
                text = error.orEmpty(),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 12.dp),
                color = MaterialTheme.colorScheme.error,
                fontSize = 13.sp,
            )
        }

        Button(
            onClick = { onConnect(baseUrl, token.takeIf { it.isNotBlank() }) },
            enabled = !connecting && baseUrl.isNotBlank(),
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 20.dp)
                .height(48.dp),
            colors = ButtonDefaults.buttonColors(containerColor = TgBlue),
            shape = RoundedCornerShape(24.dp),
        ) {
            if (connecting) {
                CircularProgressIndicator(
                    modifier = Modifier
                        .size(20.dp)
                        .padding(end = 8.dp),
                    strokeWidth = 2.dp,
                    color = Color.White,
                )
            }
            Text(
                if (connecting) "正在连接..." else "连接电脑端",
                fontSize = 16.sp,
                fontWeight = FontWeight.Medium,
            )
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
                .padding(top = 12.dp)
                .height(48.dp),
            shape = RoundedCornerShape(24.dp),
        ) {
            Text("扫码连接", fontSize = 15.sp)
        }

        Text(
            text = "电脑连接手机热点时，请填写电脑在热点中获得的 IP",
            modifier = Modifier.padding(top = 20.dp),
            color = MutedText,
            fontSize = 12.sp,
        )
    }
}

@Composable
private fun PairingStep(number: String, text: String) {
    Row(
        modifier = Modifier.padding(bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(22.dp)
                .clip(CircleShape)
                .background(TgBlueLight),
            contentAlignment = Alignment.Center,
        ) {
            Text(number, color = TgBlue, fontWeight = FontWeight.Bold, fontSize = 11.sp)
        }
        Spacer(modifier = Modifier.width(10.dp))
        Text(text, color = Ink, fontSize = 13.sp)
    }
}
