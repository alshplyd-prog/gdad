package com.alkarrar.mobile

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothSocket
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.util.Base64
import android.util.Log
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.getcapacitor.BridgeActivity
import org.json.JSONArray
import org.json.JSONObject
import java.io.OutputStream
import java.nio.charset.StandardCharsets
import java.util.*

class MainActivity : BridgeActivity() {
    companion object {
        private const val TAG = "AlkarrarNativeBT"
        private val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
        private const val PERMISSION_REQUEST_CODE = 404
    }

    private var bluetoothAdapter: BluetoothAdapter? = null
    private var syncReceiver: BroadcastReceiver? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        try {
            bluetoothAdapter = BluetoothAdapter.getDefaultAdapter()
        } catch (e: Throwable) {
            Log.w(TAG, "BluetoothAdapter init error: ${e.message}")
        }

        try {
            syncReceiver = object : BroadcastReceiver() {
                override fun onReceive(context: Context?, intent: Intent?) {
                    Log.i(TAG, "Sync broadcast received in MainActivity")
                    triggerWebSync()
                }
            }
            val filter = IntentFilter("com.alkarrar.mobile.INTERNET_RESTORED")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(syncReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                registerReceiver(syncReceiver, filter)
            }
        } catch (e: Throwable) {
            Log.w(TAG, "Failed to register syncReceiver: ${e.message}")
        }

        setupWebViewInterface()

        try {
            ForegroundSyncService.startSyncService(this)
        } catch (e: Throwable) {
            Log.w(TAG, "ForegroundSyncService init error: ${e.message}")
        }

        try {
            SyncWorker.enqueueWork(this)
        } catch (e: Throwable) {
            Log.w(TAG, "SyncWorker init error: ${e.message}")
        }

        checkAndRequestPermissions()
    }

    override fun onResume() {
        super.onResume()
        setupWebViewInterface()
        triggerWebSync()
        checkAndRequestPermissions()
        try {
            ForegroundSyncService.startSyncService(this)
        } catch (_: Throwable) {}
    }

    override fun onPause() {
        super.onPause()
        triggerWebSync()
        try {
            ForegroundSyncService.triggerSyncNow(this)
            SyncWorker.enqueueImmediateWork(this)
        } catch (_: Throwable) {}
    }

    override fun onStop() {
        super.onStop()
        triggerWebSync()
        try {
            ForegroundSyncService.triggerSyncNow(this)
            SyncWorker.enqueueImmediateWork(this)
        } catch (_: Throwable) {}
    }

    override fun onDestroy() {
        triggerWebSync()
        try {
            ForegroundSyncService.triggerSyncNow(this)
            SyncWorker.enqueueImmediateWork(this)
        } catch (_: Throwable) {}
        try {
            if (syncReceiver != null) {
                unregisterReceiver(syncReceiver)
            }
        } catch (_: Throwable) {}
        super.onDestroy()
    }

    private fun triggerWebSync() {
        try {
            if (bridge != null && bridge.webView != null) {
                runOnUiThread {
                    try {
                        bridge.webView?.evaluateJavascript(
                            "if (typeof window !== 'undefined') {" +
                            "  try { if (typeof window.alkarrarSendBeacon === 'function') { window.alkarrarSendBeacon(); } } catch (e) {}" +
                            "  try { if (typeof window.alkarrarFlushQueue === 'function') { window.alkarrarFlushQueue(); } } catch (e) {}" +
                            "}", null
                        )
                    } catch (_: Throwable) {}
                }
            }
        } catch (_: Throwable) {}
    }

    private fun setupWebViewInterface() {
        try {
            if (bridge != null && bridge.webView != null) {
                val webView = bridge.webView
                ForegroundSyncService.setActiveWebView(webView)
                webView.settings.apply {
                    javaScriptEnabled = true
                    domStorageEnabled = true
                    databaseEnabled = true
                    allowFileAccess = true
                    allowContentAccess = true
                    mediaPlaybackRequiresUserGesture = false
                }

                val nativeInterface = PrinterJavascriptInterface()
                webView.addJavascriptInterface(nativeInterface, "AndroidPrinter")
                webView.addJavascriptInterface(nativeInterface, "AndroidInterface")
            }
        } catch (e: Throwable) {
            Log.w(TAG, "Failed to attach AndroidPrinter JavascriptInterface: ${e.message}")
        }
    }

    private fun checkAndRequestPermissions() {
        runOnUiThread {
            val permissions = mutableListOf<String>()

            if (Build.VERSION.SDK_INT >= 33) {
                if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    permissions.add(Manifest.permission.POST_NOTIFICATIONS)
                }
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
                    permissions.add(Manifest.permission.BLUETOOTH_CONNECT)
                }
                if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_SCAN) != PackageManager.PERMISSION_GRANTED) {
                    permissions.add(Manifest.permission.BLUETOOTH_SCAN)
                }
                if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_ADVERTISE) != PackageManager.PERMISSION_GRANTED) {
                    permissions.add(Manifest.permission.BLUETOOTH_ADVERTISE)
                }
            } else {
                if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH) != PackageManager.PERMISSION_GRANTED) {
                    permissions.add(Manifest.permission.BLUETOOTH)
                }
                if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_ADMIN) != PackageManager.PERMISSION_GRANTED) {
                    permissions.add(Manifest.permission.BLUETOOTH_ADMIN)
                }
            }

            if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                permissions.add(Manifest.permission.ACCESS_FINE_LOCATION)
            }
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                permissions.add(Manifest.permission.ACCESS_COARSE_LOCATION)
            }

            if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.S_V2) {
                if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                    permissions.add(Manifest.permission.READ_EXTERNAL_STORAGE)
                }
                if (ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                    permissions.add(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                }
            }

            if (permissions.isNotEmpty()) {
                ActivityCompat.requestPermissions(this, permissions.toTypedArray(), PERMISSION_REQUEST_CODE)
            }

            checkAndPromptBatteryOptimization()
        }
    }

    private fun checkAndPromptBatteryOptimization() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
                if (pm != null && !pm.isIgnoringBatteryOptimizations(packageName)) {
                    val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                        data = android.net.Uri.parse("package:$packageName")
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK
                    }
                    startActivity(intent)
                }
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val am = getSystemService(Context.ALARM_SERVICE) as? android.app.AlarmManager
                if (am != null && !am.canScheduleExactAlarms()) {
                    val intent = Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM).apply {
                        data = android.net.Uri.parse("package:$packageName")
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK
                    }
                    startActivity(intent)
                }
            }
        } catch (e: Throwable) {
            Log.w(TAG, "checkAndPromptBatteryOptimization note: ${e.message}")
        }
    }

    inner class PrinterJavascriptInterface {
        @JavascriptInterface
        fun isNative(): Boolean = true

        @JavascriptInterface
        fun isBluetoothEnabled(): Boolean {
            return bluetoothAdapter?.isEnabled == true
        }

        @JavascriptInterface
        fun enableBluetooth(): Boolean {
            if (bluetoothAdapter == null) return false
            if (!bluetoothAdapter!!.isEnabled) {
                try {
                    return bluetoothAdapter!!.enable()
                } catch (se: SecurityException) {
                    Log.w(TAG, "SecurityException on enable(): ${se.message}")
                }
            }
            return true
        }

        @JavascriptInterface
        fun requestPermissions() {
            checkAndRequestPermissions()
        }

        @JavascriptInterface
        fun requestAllAndroidPermissions() {
            checkAndRequestPermissions()
        }

        @JavascriptInterface
        fun requestExactAlarmPermission() {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    val am = getSystemService(Context.ALARM_SERVICE) as? android.app.AlarmManager
                    if (am != null && !am.canScheduleExactAlarms()) {
                        val intent = Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM).apply {
                            data = android.net.Uri.parse("package:$packageName")
                            flags = Intent.FLAG_ACTIVITY_NEW_TASK
                        }
                        startActivity(intent)
                    }
                }
            } catch (e: Throwable) {
                Log.w(TAG, "requestExactAlarmPermission error: ${e.message}")
            }
        }

        @JavascriptInterface
        fun hasOverlayPermission(): Boolean {
            return try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    Settings.canDrawOverlays(this@MainActivity)
                } else {
                    true
                }
            } catch (e: Throwable) {
                Log.w(TAG, "hasOverlayPermission check error: ${e.message}")
                false
            }
        }

        @JavascriptInterface
        fun requestOverlayPermission() {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    val intent = Intent(
                        Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        android.net.Uri.parse("package:$packageName")
                    ).apply {
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK
                    }
                    startActivity(intent)
                    return
                }
            } catch (e: Throwable) {
                Log.w(TAG, "requestOverlayPermission failed: ${e.message}")
            }

            val manufacturer = Build.MANUFACTURER.lowercase(Locale.getDefault())
            if (manufacturer.contains("xiaomi") || manufacturer.contains("redmi") || manufacturer.contains("poco")) {
                try {
                    val miuiIntent = Intent("miui.intent.action.APP_PERM_EDITOR").apply {
                        setClassName("com.miui.securitycenter", "com.miui.permcenter.permissions.PermissionsEditorActivity")
                        putExtra("extra_pkgname", packageName)
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK
                    }
                    startActivity(miuiIntent)
                    return
                } catch (_: Throwable) {}
            }

            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    val fallbackIntent = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION).apply {
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK
                    }
                    startActivity(fallbackIntent)
                    return
                }
            } catch (_: Throwable) {}

            openAppSettings()
        }

        @JavascriptInterface
        fun openAppSettings() {
            try {
                val appSettings = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = android.net.Uri.parse("package:$packageName")
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK
                }
                startActivity(appSettings)
            } catch (e: Throwable) {
                Log.e(TAG, "openAppSettings error: ${e.message}")
            }
        }

        @JavascriptInterface
        fun openOverlaySettings() {
            requestOverlayPermission()
        }

        @JavascriptInterface
        fun requestSystemAlertWindow() {
            requestOverlayPermission()
        }

        @JavascriptInterface
        fun isIgnoringBatteryOptimizations(): Boolean {
            return try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
                    pm?.isIgnoringBatteryOptimizations(packageName) == true
                } else {
                    true
                }
            } catch (_: Throwable) {
                false
            }
        }

        @JavascriptInterface
        fun requestIgnoreBatteryOptimizations() {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
                    if (pm != null && !pm.isIgnoringBatteryOptimizations(packageName)) {
                        try {
                            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                                data = android.net.Uri.parse("package:$packageName")
                                flags = Intent.FLAG_ACTIVITY_NEW_TASK
                            }
                            startActivity(intent)
                            return
                        } catch (_: Throwable) {}

                        val generalIntent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).apply {
                            flags = Intent.FLAG_ACTIVITY_NEW_TASK
                        }
                        startActivity(generalIntent)
                    }
                }
            } catch (e: Throwable) {
                Log.e(TAG, "requestIgnoreBatteryOptimizations error: ${e.message}")
            }
        }

        @JavascriptInterface
        fun openBatterySettings() {
            try {
                val intent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK
                }
                startActivity(intent)
            } catch (_: Throwable) {
                requestIgnoreBatteryOptimizations()
            }
        }

        @JavascriptInterface
        fun openAutoStartSettings() {
            try {
                val manufacturer = Build.MANUFACTURER.lowercase(Locale.getDefault())
                val intent = Intent().apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK
                }

                if (manufacturer.contains("xiaomi") || manufacturer.contains("redmi") || manufacturer.contains("poco")) {
                    intent.component = android.content.ComponentName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity")
                } else if (manufacturer.contains("huawei") || manufacturer.contains("honor")) {
                    intent.component = android.content.ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity")
                } else if (manufacturer.contains("oppo") || manufacturer.contains("realme")) {
                    intent.component = android.content.ComponentName("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity")
                } else if (manufacturer.contains("vivo") || manufacturer.contains("iqoo")) {
                    intent.component = android.content.ComponentName("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity")
                } else if (manufacturer.contains("samsung")) {
                    intent.component = android.content.ComponentName("com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity")
                } else {
                    intent.action = Settings.ACTION_APPLICATION_DETAILS_SETTINGS
                    intent.data = android.net.Uri.parse("package:$packageName")
                }
                startActivity(intent)
            } catch (e: Throwable) {
                Log.w(TAG, "Specific auto-start intent failed: ${e.message}")
                try {
                    val appSettings = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                        data = android.net.Uri.parse("package:$packageName")
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK
                    }
                    startActivity(appSettings)
                } catch (_: Throwable) {}
            }
        }

        @JavascriptInterface
        fun setKeepScreenOn(keepOn: Boolean) {
            runOnUiThread {
                try {
                    if (keepOn) {
                        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    } else {
                        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    }
                } catch (_: Throwable) {}
            }
        }

        @JavascriptInterface
        fun isKeepScreenOn(): Boolean {
            return try {
                val flags = window.attributes.flags
                (flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) != 0
            } catch (_: Throwable) {
                false
            }
        }

        @JavascriptInterface
        fun requestBackgroundExecution() {
            requestIgnoreBatteryOptimizations()
        }

        @JavascriptInterface
        fun enableBackgroundSync() {
            requestIgnoreBatteryOptimizations()
        }

        @JavascriptInterface
        fun syncPendingQueueToNative(queueJson: String?, serverUrl: String?) {
            try {
                ForegroundSyncService.persistPendingQueueFromWeb(this@MainActivity, queueJson, serverUrl)
            } catch (e: Throwable) {
                Log.w(TAG, "Error in syncPendingQueueToNative: ${e.message}")
            }
        }

        @JavascriptInterface
        fun getPendingQueueFromNative(): String {
            return try {
                ForegroundSyncService.readNativePendingQueue(this@MainActivity)
            } catch (e: Throwable) {
                Log.w(TAG, "Error in getPendingQueueFromNative: ${e.message}")
                "[]"
            }
        }

        @JavascriptInterface
        fun triggerBackgroundSyncNow() {
            try {
                ForegroundSyncService.triggerSyncNow(this@MainActivity)
                SyncWorker.enqueueImmediateWork(this@MainActivity)
            } catch (e: Throwable) {
                Log.w(TAG, "Error in triggerBackgroundSyncNow: ${e.message}")
            }
        }

        @JavascriptInterface
        fun triggerImmediateCloseSync(queueJson: String?, serverUrl: String?) {
            try {
                if (!queueJson.isNullOrBlank()) {
                    ForegroundSyncService.persistPendingQueueFromWeb(this@MainActivity, queueJson, serverUrl)
                }
                ForegroundSyncService.triggerSyncNow(this@MainActivity)
                SyncWorker.enqueueImmediateWork(this@MainActivity)
                Thread {
                    try {
                        ForegroundSyncService.performNativeStorageSync(this@MainActivity)
                    } catch (_: Throwable) {}
                }.start()
            } catch (e: Throwable) {
                Log.w(TAG, "Error in triggerImmediateCloseSync: ${e.message}")
            }
        }

        @JavascriptInterface
        fun openBluetoothSettings() {
            try {
                val intent = Intent(Settings.ACTION_BLUETOOTH_SETTINGS).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK
                }
                startActivity(intent)
            } catch (e: Exception) {
                Log.e(TAG, "openBluetoothSettings error: ${e.message}")
            }
        }

        @JavascriptInterface
        fun getBondedDevices(): String {
            val array = JSONArray()
            if (bluetoothAdapter == null) return array.toString()

            if (!bluetoothAdapter!!.isEnabled) {
                try {
                    bluetoothAdapter!!.enable()
                } catch (_: Exception) {}
            }

            try {
                val pairedDevices: Set<BluetoothDevice>? = bluetoothAdapter!!.bondedDevices
                if (pairedDevices != null) {
                    for (device in pairedDevices) {
                        val obj = JSONObject()
                        val name = device.name
                        val addr = device.address
                        obj.put("name", if (!name.isNullOrBlank()) name else "طابعة بلوتوث ($addr)")
                        obj.put("address", addr ?: "")
                        obj.put("id", addr ?: "")
                        array.put(obj)
                    }
                }
            } catch (se: SecurityException) {
                Log.w(TAG, "SecurityException in getBondedDevices: ${se.message}")
            } catch (e: Exception) {
                Log.e(TAG, "Error in getBondedDevices: ${e.message}")
            }
            return array.toString()
        }

        @JavascriptInterface
        fun printBase64Bytes(targetAddressOrName: String?, base64Data: String?): String {
            if (bluetoothAdapter == null || !bluetoothAdapter!!.isEnabled) {
                return "{\"success\": false, \"message\": \"البلوتوث غير مفعّل على الهاتف. يرجى تشغيله\"}"
            }
            if (base64Data == null) {
                return "{\"success\": false, \"message\": \"بيانات الطباعة فارغة\"}"
            }

            val targetDevice = findDevice(targetAddressOrName)
            if (targetDevice == null) {
                return "{\"success\": false, \"message\": \"لم يتم العثور على الطابعة المقترنة. يرجى الاقتران بالطابعة في إعدادات بلوتوث الهاتف أولاً\"}"
            }

            var socket: BluetoothSocket? = null
            var outStream: OutputStream? = null

            return try {
                val rawBytes = Base64.decode(base64Data, Base64.DEFAULT)
                try {
                    bluetoothAdapter!!.cancelDiscovery()
                } catch (_: Exception) {}

                try {
                    socket = targetDevice.createRfcommSocketToServiceRecord(SPP_UUID)
                    socket.connect()
                } catch (connErr: Exception) {
                    Log.w(TAG, "Standard SPP socket failed, trying fallback port 1: ${connErr.message}")
                    try {
                        socket?.close()
                        val m = targetDevice.javaClass.getMethod("createRfcommSocket", Int::class.javaPrimitiveType)
                        socket = m.invoke(targetDevice, 1) as? BluetoothSocket
                        socket?.connect()
                    } catch (reflectionErr: Exception) {
                        Log.e(TAG, "Reflection fallback connection failed: ${reflectionErr.message}")
                        throw connErr
                    }
                }

                if (socket != null && socket.isConnected) {
                    outStream = socket.outputStream
                    outStream.write(rawBytes)
                    outStream.flush()
                    Thread.sleep(200)
                    "{\"success\": true, \"message\": \"تمت الطباعة المباشرة بنجاح\"}"
                } else {
                    "{\"success\": false, \"message\": \"تعذر فتح قناة الاتصال مع الطابعة\"}"
                }
            } catch (e: Exception) {
                Log.e(TAG, "Print error: ${e.message}")
                "{\"success\": false, \"message\": \"فشل الاتصال بالطابعة: ${e.message ?: "خطأ غير معروف"}\"}"
            } finally {
                try { outStream?.close() } catch (_: Exception) {}
                try { socket?.close() } catch (_: Exception) {}
            }
        }

        @JavascriptInterface
        fun printReceiptText(targetAddressOrName: String?, text: String?): String {
            if (text == null) return "{\"success\": false, \"message\": \"النص فارغ\"}"
            val textBytes = text.toByteArray(StandardCharsets.UTF_8)
            val base64 = Base64.encodeToString(textBytes, Base64.NO_WRAP)
            return printBase64Bytes(targetAddressOrName, base64)
        }

        @JavascriptInterface
        fun printRawBT(text: String?): Boolean {
            if (text == null) return false
            try {
                val intent = Intent(Intent.ACTION_SEND).apply {
                    setPackage("ru.a402d.rawbtprinter")
                    type = "text/plain"
                    putExtra(Intent.EXTRA_TEXT, text)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                startActivity(intent)
                return true
            } catch (_: Exception) {
                try {
                    val intent2 = Intent(Intent.ACTION_VIEW).apply {
                        data = android.net.Uri.parse("rawbt:text;base64," + Base64.encodeToString(text.toByteArray(StandardCharsets.UTF_8), Base64.NO_WRAP))
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    startActivity(intent2)
                    return true
                } catch (e2: Exception) {
                    Log.e(TAG, "printRawBT failed: ${e2.message}")
                    return false
                }
            }
        }

        @JavascriptInterface
        fun printEscPos(text: String?) {
            printReceiptText("", text)
        }

        @JavascriptInterface
        fun printReceipt(text: String?) {
            printReceiptText("", text)
        }

        @JavascriptInterface
        fun printBluetooth(text: String?) {
            printReceiptText("", text)
        }

        private fun findDevice(addressOrName: String?): BluetoothDevice? {
            if (bluetoothAdapter == null) return null
            return try {
                val pairedDevices = bluetoothAdapter!!.bondedDevices
                if (pairedDevices.isNullOrEmpty()) return null

                if (!addressOrName.isNullOrBlank() && !addressOrName.contains("طابعة")) {
                    val query = addressOrName.trim().lowercase(Locale.getDefault())
                    for (device in pairedDevices) {
                        if (device.address?.equals(query, ignoreCase = true) == true) {
                            return device
                        }
                    }
                    for (device in pairedDevices) {
                        if (device.name?.lowercase(Locale.getDefault())?.contains(query) == true) {
                            return device
                        }
                    }
                }

                for (device in pairedDevices) {
                    val name = (device.name ?: "").lowercase(Locale.getDefault())
                    if (name.contains("print") || name.contains("pos") || name.contains("thermal") ||
                        name.contains("mpt") || name.contains("rpp") || name.contains("rp") ||
                        name.contains("58") || name.contains("80") || name.contains("bt") ||
                        name.contains("6ba1") || name.contains("xprinter") || name.contains("rongta") ||
                        name.contains("sunmi") || name.contains("ble")) {
                        return device
                    }
                }

                pairedDevices.iterator().next()
            } catch (se: SecurityException) {
                Log.w(TAG, "findDevice SecurityException: ${se.message}")
                null
            } catch (e: Exception) {
                Log.e(TAG, "findDevice error: ${e.message}")
                null
            }
        }
    }
}
