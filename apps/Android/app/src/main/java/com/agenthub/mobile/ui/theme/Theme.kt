package com.agenthub.mobile.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val AgentHubDarkColors = darkColorScheme(
    primary = Color(0xFF60A5FA),
    onPrimary = Color(0xFF08111F),
    background = Color(0xFF101010),
    onBackground = Color(0xFFF5F5F5),
    surface = Color(0xFF171717),
    onSurface = Color(0xFFF5F5F5),
    surfaceVariant = Color(0xFF242424),
    onSurfaceVariant = Color(0xFFCFCFCF),
    outline = Color(0xFF3A3A3A),
)

@Composable
fun AgentHubTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = AgentHubDarkColors,
        content = content,
    )
}
