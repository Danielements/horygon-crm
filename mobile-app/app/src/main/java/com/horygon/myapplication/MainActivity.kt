package com.horygon.myapplication

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.horygon.myapplication.ui.HorygonTabletApp
import com.horygon.myapplication.ui.theme.HorygonTabletTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            HorygonTabletTheme {
                HorygonTabletApp()
            }
        }
    }
}
