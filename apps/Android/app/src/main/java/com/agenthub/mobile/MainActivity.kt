package com.agenthub.mobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.agenthub.mobile.ui.AgentHubApp
import com.agenthub.mobile.ui.theme.AgentHubTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            AgentHubTheme {
                AgentHubApp()
            }
        }
    }
}
