package com.agenthub.mobile.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Telegram-inspired dark palette
private val AgentHubDarkColors = darkColorScheme(
    primary = Color(0xFF4FA3F7),
    onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFF22384C),
    onPrimaryContainer = Color(0xFFD8ECFF),
    background = Color(0xFF121B24),
    onBackground = Color(0xFFF4F7FA),
    surface = Color(0xFF1C2733),
    onSurface = Color(0xFFF4F7FA),
    surfaceVariant = Color(0xFF243241),
    onSurfaceVariant = Color(0xFF9AA8B5),
    outline = Color(0xFF314252),
    outlineVariant = Color(0xFF243241),
    secondary = Color(0xFF55D66B),
    onSecondary = Color(0xFFFFFFFF),
    error = Color(0xFFFF6B78),
    onError = Color(0xFFFFFFFF),
    inverseSurface = Color(0xFFF4F7FA),
    inverseOnSurface = Color(0xFF121B24),
    inversePrimary = Color(0xFF2A7FD1),
)

@Composable
fun AgentHubTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = AgentHubDarkColors,
        content = content,
    )
}
