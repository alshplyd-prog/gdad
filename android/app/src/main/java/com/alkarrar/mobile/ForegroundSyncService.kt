package com.alkarrar.mobile

import android.app.*
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.ServiceInfo
import android.net.*
import android.os.*
import android.util.Log
import android.webkit.ValueCallback
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.app.NotificationCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

class ForegroundSyncService : Service() {
    companion object {
        private const val TAG = "ForegroundSyncService"
        private const val CHANNEL_ID = "alkarrar_sync_channel"
        private const val NOTIFICATION_ID = 9981

        private val CANDIDATE_SYNC_URLS = arrayOf(
            "http://72.62.158.128:3000/api/sync/batch",
            "https://ais-dev-asc5xuvnur4hlmpl5rfxpz-655986077616.europe-west2.run.app/api/sync/batch",
            "https://ais-pre-asc5xuvnur4hlmpl5rfxpz-655986077616.europe-west2.run.app/api/sync/batch"
        )

        private var activeActivityWebView: java.lang.ref.WeakReference<WebView>? = null
        var instance: ForegroundSyncService? = null
            private set

        fun setActiveWebView(webView: WebView?) {
            if (webView != null) {
                activeActivityWebView = java.lang.ref.WeakReference(webView)
                Log.i(TAG, "Active Activity WebView registered.")
            }
        }

        fun startSyncService(context: Context?) {
            if (context == null) return
            try {
                val serviceIntent = Intent(context, ForegroundSyncService::class.java)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(serviceIntent)
                } else {
                    context.startService(serviceIntent)
                }
            } catch (e: Throwable) {
                Log.e(TAG, "Failed to start ForegroundSyncService: ${e.message}")
            }
        }

        fun triggerSyncNow(context: Context?) {
            if (instance != null) {
                instance?.triggerImmediateSync("Direct triggerSyncNow")
            } else if (context != null) {
                Thread {
                    try {
                        performNativeStorageSync(context)
                    } catch (_: Throwable) {}
                }.start()
                startSyncService(context)
            }
        }

        private const val FILE_NAME_QUEUE = "alkarrar_offline_queue.json"
        private const val PREFS_ALKARRAR = "AlkarrarSync"
        private const val PREFS_CAPACITOR_STORAGE = "CapacitorStorage"
        private const val PREFS_CAPACITOR_PREFERENCES = "CapacitorPreferences"
        private const val KEY_PENDING_QUEUE = "alkarrar_offline_pending_queue"
        private const val KEY_SERVER_URL = "alkarrar_backend_server_url"

        @Synchronized
        fun persistPendingQueueFromWeb(context: Context?, queueJson: String?, serverUrl: String?) {
            if (context == null || queueJson == null) return
            try {
                val file = File(context.filesDir, FILE_NAME_QUEUE)
                val tempFile = File(context.filesDir, "$FILE_NAME_QUEUE.tmp")
                FileOutputStream(tempFile).use { fos ->
                    fos.write(queueJson.toByteArray(Charsets.UTF_8))
                    fos.flush()
                }
                if (tempFile.exists()) {
                    tempFile.renameTo(file)
                }

                val prefNames = arrayOf(PREFS_ALKARRAR, PREFS_CAPACITOR_STORAGE, PREFS_CAPACITOR_PREFERENCES)
                val keyNames = arrayOf(
                    KEY_PENDING_QUEUE,
                    "CapacitorStorage.$KEY_PENDING_QUEUE",
                    "CapacitorPreferences.$KEY_PENDING_QUEUE",
                    "_cap_$KEY_PENDING_QUEUE"
                )

                for (pName in prefNames) {
                    try {
                        val prefs = context.getSharedPreferences(pName, Context.MODE_PRIVATE)
                        val editor = prefs.edit()
                        for (k in keyNames) {
                            editor.putString(k, queueJson)
                        }
                        if (!serverUrl.isNullOrBlank()) {
                            editor.putString(KEY_SERVER_URL, serverUrl.trim())
                            editor.putString("CapacitorStorage.$KEY_SERVER_URL", serverUrl.trim())
                            editor.putString("CapacitorPreferences.$KEY_SERVER_URL", serverUrl.trim())
                        }
                        editor.apply()
                    } catch (_: Throwable) {}
                }

                triggerSyncNow(context)
            } catch (e: Throwable) {
                Log.w(TAG, "persistPendingQueueFromWeb error: ${e.message}")
            }
        }

        @Synchronized
        fun readNativePendingQueue(context: Context?): String {
            if (context == null) return "[]"
            try {
                val file = File(context.filesDir, FILE_NAME_QUEUE)
                if (file.exists() && file.length() > 2) {
                    try {
                        FileInputStream(file).use { fis ->
                            ByteArrayOutputStream().use { baos ->
                                val buf = ByteArray(2048)
                                var len: Int
                                while (fis.read(buf).also { len = it } != -1) {
                                    baos.write(buf, 0, len)
                                }
                                val content = baos.toString(Charsets.UTF_8).trim()
                                if (content.startsWith("[") && content.endsWith("]")) {
                                    return content
                                }
                            }
                        }
                    } catch (_: Throwable) {}
                }

                val prefNames = arrayOf(PREFS_ALKARRAR, PREFS_CAPACITOR_STORAGE, PREFS_CAPACITOR_PREFERENCES)
                val keyNames = arrayOf(
                    KEY_PENDING_QUEUE,
                    "CapacitorStorage.$KEY_PENDING_QUEUE",
                    "CapacitorPreferences.$KEY_PENDING_QUEUE",
                    "_cap_$KEY_PENDING_QUEUE"
                )

                for (pName in prefNames) {
                    try {
                        val prefs = context.getSharedPreferences(pName, Context.MODE_PRIVATE)
                        for (k in keyNames) {
                            val valStr = prefs.getString(k, null)
                            if (valStr != null) {
                                val trimmed = valStr.trim()
                                if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
                                    return trimmed
                                }
                            }
                        }
                    } catch (_: Throwable) {}
                }
            } catch (e: Throwable) {
                Log.w(TAG, "readNativePendingQueue error: ${e.message}")
            }
            return "[]"
        }

        @Synchronized
        fun writeNativePendingQueue(context: Context?, queueJson: String?) {
            if (context == null || queueJson == null) return
            persistPendingQueueFromWeb(context, queueJson, null)
        }

        fun performNativeStorageSync(context: Context?): Int {
            var uploadedCount = 0
            val ctx = context ?: instance ?: return 0
            try {
                val queueJson = readNativePendingQueue(ctx)
                if (queueJson.isBlank() || queueJson == "[]") return 0

                val queue = JSONArray(queueJson)
                if (queue.length() == 0) return 0

                val pendingItems = JSONArray()
                for (i in 0 until queue.length()) {
                    val item = queue.optJSONObject(i)
                    if (item != null) {
                        val status = item.optString("status", "pending")
                        val id = item.optString("id", "")
                        if (status != "synced" && !id.startsWith("__meta_")) {
                            pendingItems.put(item)
                        }
                    }
                }

                if (pendingItems.length() == 0) return 0

                val prefs = ctx.getSharedPreferences(PREFS_ALKARRAR, Context.MODE_PRIVATE)
                var customServerUrl = prefs.getString(KEY_SERVER_URL, null)
                if (customServerUrl == null) {
                    val capPrefs = ctx.getSharedPreferences(PREFS_CAPACITOR_STORAGE, Context.MODE_PRIVATE)
                    customServerUrl = capPrefs.getString(KEY_SERVER_URL, null)
                }

                val targetUrls = mutableListOf<String>()
                if (!customServerUrl.isNullOrBlank()) {
                    targetUrls.add(customServerUrl.replace(Regex("/+$"), "") + "/api/sync/batch")
                }
                for (u in CANDIDATE_SYNC_URLS) {
                    if (!targetUrls.contains(u)) {
                        targetUrls.add(u)
                    }
                }

                val totalSyncedIds = mutableSetOf<String>()
                val chunkSize = 30

                for (b in 0 until pendingItems.length() step chunkSize) {
                    val chunk = JSONArray()
                    for (k in b until Math.min(b + chunkSize, pendingItems.length())) {
                        chunk.put(pendingItems.get(k))
                    }

                    val chunkVerifiedIds = mutableSetOf<String>()
                    val batchPayload = JSONObject().apply {
                        put("actions", chunk)
                        put("timestamp", System.currentTimeMillis())
                    }
                    val out = batchPayload.toString().toByteArray(Charsets.UTF_8)

                    for (targetUrl in targetUrls) {
                        try {
                            val url = URL(targetUrl)
                            val conn = url.openConnection() as HttpURLConnection
                            conn.requestMethod = "POST"
                            conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8")
                            conn.setRequestProperty("Accept", "application/json")
                            conn.connectTimeout = 12000
                            conn.readTimeout = 20000
                            conn.doOutput = true

                            conn.outputStream.use { os ->
                                os.write(out)
                                os.flush()
                            }

                            val code = conn.responseCode
                            val contentType = conn.contentType
                            if (code in 200..299 && contentType != null && contentType.contains("application/json")) {
                                val respText = conn.inputStream.use { it.bufferedReader().readText() }
                                val respJson = JSONObject(respText)
                                if (respJson.has("processedIds")) {
                                    val arr = respJson.optJSONArray("processedIds")
                                    if (arr != null) {
                                        for (p in 0 until arr.length()) {
                                            chunkVerifiedIds.add(arr.optString(p))
                                        }
                                    }
                                } else if (respJson.optBoolean("success", false)) {
                                    for (p in 0 until chunk.length()) {
                                        val itm = chunk.optJSONObject(p)
                                        if (itm != null && itm.has("id")) {
                                            chunkVerifiedIds.add(itm.optString("id"))
                                        }
                                    }
                                }

                                if (chunkVerifiedIds.size > 0) {
                                    conn.disconnect()
                                    break
                                }
                            }
                            conn.disconnect()
                        } catch (e: Throwable) {
                            Log.w(TAG, "Chunk Batch POST exception for $targetUrl: ${e.message}")
                        }
                    }

                    // Fallback for unverified items
                    val unverifiedInChunk = JSONArray()
                    for (i in 0 until chunk.length()) {
                        val item = chunk.optJSONObject(i)
                        if (item != null) {
                            val aId = item.optString("id", "")
                            if (!chunkVerifiedIds.contains(aId)) {
                                unverifiedInChunk.put(item)
                            }
                        }
                    }

                    if (unverifiedInChunk.length() > 0) {
                        val primaryBaseUrl = if (targetUrls.isNotEmpty()) targetUrls[0].replace(Regex("/api/sync/batch.*"), "") else "http://72.62.158.128:3000"
                        for (i in 0 until unverifiedInChunk.length()) {
                            val item = unverifiedInChunk.optJSONObject(i) ?: continue
                            val actionId = item.optString("id", null)
                            val actionType = item.optString("type", "")
                            val payload = item.optJSONObject("payload") ?: continue

                            val docId = payload.optString("id", actionId)
                            var table: String? = null
                            val isDelete = actionType.startsWith("DELETE_")

                            if (actionType.contains("CONTRACT")) {
                                table = "contracts"
                            } else if (actionType.contains("PAYMENT")) {
                                table = "payments"
                            } else if (actionType.contains("INVENTORY")) {
                                table = "inventory"
                            } else if (actionType.contains("REP")) {
                                table = "reps"
                            } else if (actionType.contains("FUND")) {
                                table = "funds"
                            }

                            if (table != null) {
                                try {
                                    var ep = "$primaryBaseUrl/api/$table"
                                    if (isDelete && docId != null) {
                                        ep += "/$docId"
                                    }
                                    val sUrl = URL(ep)
                                    val sConn = sUrl.openConnection() as HttpURLConnection
                                    sConn.requestMethod = if (isDelete) "DELETE" else "POST"
                                    sConn.setRequestProperty("Content-Type", "application/json; charset=UTF-8")
                                    sConn.setRequestProperty("Accept", "application/json")
                                    sConn.connectTimeout = 6000
                                    sConn.readTimeout = 10000

                                    if (!isDelete) {
                                        sConn.doOutput = true
                                        val rowBytes = payload.toString().toByteArray(Charsets.UTF_8)
                                        sConn.outputStream.use { os ->
                                            os.write(rowBytes)
                                            os.flush()
                                        }
                                    }

                                    val sCode = sConn.responseCode
                                    if (sCode in 200..299) {
                                        if (actionId != null) {
                                            chunkVerifiedIds.add(actionId)
                                        }
                                    }
                                    sConn.disconnect()
                                } catch (sErr: Throwable) {
                                    Log.w(TAG, "Chunk fallback error for $table: ${sErr.message}")
                                }
                            }
                        }
                    }

                    if (chunkVerifiedIds.size > 0) {
                        totalSyncedIds.addAll(chunkVerifiedIds)
                        uploadedCount += chunkVerifiedIds.size()

                        val updatedQueue = JSONArray()
                        for (i in 0 until queue.length()) {
                            val item = queue.optJSONObject(i)
                            if (item != null) {
                                val id = item.optString("id", "")
                                if (totalSyncedIds.contains(id)) {
                                    item.put("status", "synced")
                                    item.put("syncedAt", System.currentTimeMillis())
                                }
                                updatedQueue.put(item)
                            }
                        }
                        writeNativePendingQueue(ctx, updatedQueue.toString())
                        instance?.updateNotification("تمت مزامنة ${totalSyncedIds.size()} من ${pendingItems.length()} عملية في الخلفية ✓")
                    }
                }
            } catch (e: Throwable) {
                Log.e(TAG, "Error in performNativeStorageSync: ${e.message}")
            }
            return uploadedCount
        }
    }

    private var connectivityManager: ConnectivityManager? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: android.net.wifi.WifiManager.WifiLock? = null
    private var backgroundWebView: WebView? = null
    private lateinit var mainHandler: Handler
    private lateinit var periodicHandler: Handler
    private lateinit var periodicRunnable: Runnable
    private lateinit var executorService: ExecutorService
    private var isSyncing = false

    override fun onCreate() {
        super.onCreate()
        instance = this
        mainHandler = Handler(Looper.getMainLooper())
        periodicHandler = Handler(Looper.getMainLooper())
        executorService = Executors.newSingleThreadExecutor()

        createNotificationChannel()
        startInForeground("يراقب الاتصال للمزامنة الفورية عند توفر الإنترنت")
        initBackgroundWebView()
        registerNetworkListener()
        acquirePartialWakeLock()
        acquireWifiLock()
        startPeriodicSyncLoop()
        scheduleRepeatingAlarmHeartbeat(10000)

        Log.i(TAG, "ForegroundSyncService created and initialized successfully in Kotlin.")
    }

    private fun scheduleRepeatingAlarmHeartbeat(delayMs: Long) {
        try {
            val alarmManager = getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
            val intent = Intent(this, ForegroundSyncService::class.java).apply {
                action = "ACTION_HEARTBEAT_SYNC"
            }
            val pendingIntent = PendingIntent.getService(
                this,
                9982,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0
            )

            val triggerAt = SystemClock.elapsedRealtime() + delayMs
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                alarmManager.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pendingIntent)
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
                alarmManager.setExact(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pendingIntent)
            } else {
                alarmManager.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pendingIntent)
            }
        } catch (e: Throwable) {
            Log.w(TAG, "scheduleRepeatingAlarmHeartbeat error: ${e.message}")
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "المزامنة الميدانية التلقائية",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "الحفاظ على اتصال النظام ومزامنة الفواتير والحسابات تلقائياً عند عودة الإنترنت"
                setShowBadge(false)
                enableVibration(false)
                enableLights(false)
            }

            val manager = getSystemService(NotificationManager::class.java)
            manager?.createNotificationChannel(channel)
        }
    }

    private fun startInForeground(statusText: String) {
        try {
            var launchIntent = packageManager.getLaunchIntentForPackage(packageName)
            if (launchIntent == null) {
                launchIntent = Intent(this, MainActivity::class.java)
            }
            launchIntent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            val pendingIntent = PendingIntent.getActivity(
                this,
                0,
                launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0
            )

            val notification = NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("نظام الكرار - المزامنة الميدانية نشطة")
                .setContentText(statusText)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setContentIntent(pendingIntent)
                .setAutoCancel(false)
                .build()

            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (e: Throwable) {
            Log.e(TAG, "Error starting foreground notification: ${e.message}")
        }
    }

    fun updateNotification(statusText: String) {
        try {
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
            var launchIntent = packageManager.getLaunchIntentForPackage(packageName)
            if (launchIntent == null) {
                launchIntent = Intent(this, MainActivity::class.java)
            }
            val pendingIntent = PendingIntent.getActivity(
                this,
                0,
                launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0
            )

            val notification = NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("نظام الكرار - المزامنة الميدانية نشطة")
                .setContentText(statusText)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setContentIntent(pendingIntent)
                .setAutoCancel(false)
                .build()

            manager.notify(NOTIFICATION_ID, notification)
        } catch (e: Throwable) {
            Log.w(TAG, "Failed to update notification: ${e.message}")
        }
    }

    private fun initBackgroundWebView() {
        mainHandler.post {
            try {
                if (backgroundWebView == null) {
                    backgroundWebView = WebView(applicationContext).apply {
                        settings.javaScriptEnabled = true
                        settings.domStorageEnabled = true
                        settings.databaseEnabled = true
                        settings.allowFileAccess = true
                        settings.allowContentAccess = true
                        settings.cacheMode = WebSettings.LOAD_DEFAULT

                        webViewClient = object : WebViewClient() {
                            override fun onPageFinished(view: WebView?, url: String?) {
                                super.onPageFinished(view, url)
                                Log.i(TAG, "Background WebView loaded successfully: $url")
                                triggerImmediateSync("Background WebView Page Finished")
                            }
                        }

                        loadUrl("https://localhost")
                    }
                    Log.i(TAG, "Background headless WebView initiated.")
                }
            } catch (e: Throwable) {
                Log.e(TAG, "Error initiating background WebView: ${e.message}")
            }
        }
    }

    private fun registerNetworkListener() {
        try {
            connectivityManager = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            if (connectivityManager == null) return

            val request = NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build()

            networkCallback = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    super.onAvailable(network)
                    Log.i(TAG, "⚡ Network connected! Executing instant auto-sync...")
                    mainHandler.post {
                        updateNotification("تم الاتصال بالإنترنت - جاري المزامنة...")
                        triggerImmediateSync("Network OnAvailable")
                    }
                }

                override fun onLost(network: Network) {
                    super.onLost(network)
                    Log.i(TAG, "Network disconnected. Standing by for reconnection...")
                    mainHandler.post {
                        updateNotification("يراقب الاتصال للمزامنة الفورية عند توفر الإنترنت")
                    }
                }
            }

            connectivityManager?.registerNetworkCallback(request, networkCallback!!)
        } catch (e: Throwable) {
            Log.w(TAG, "Could not register network callback: ${e.message}")
        }
    }

    private fun startPeriodicSyncLoop() {
        periodicRunnable = Runnable {
            try {
                acquirePartialWakeLock()
                acquireWifiLock()
                if (isInternetAvailable()) {
                    triggerImmediateSync("Periodic Loop (15s)")
                }
                scheduleRepeatingAlarmHeartbeat(20000)
            } catch (_: Throwable) {}
            periodicHandler.postDelayed(periodicRunnable, 15000)
        }
        periodicHandler.postDelayed(periodicRunnable, 15000)
    }

    private fun isInternetAvailable(): Boolean {
        try {
            if (connectivityManager == null) {
                connectivityManager = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            }
            connectivityManager?.let { cm ->
                val activeNet = cm.activeNetwork
                if (activeNet != null) {
                    val caps = cm.getNetworkCapabilities(activeNet)
                    return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                }
            }
        } catch (_: Throwable) {}
        return false
    }

    @Synchronized
    fun triggerImmediateSync(reason: String) {
        if (isSyncing) {
            Log.d(TAG, "Sync already in progress, skipping duplicate trigger ($reason)")
            return
        }
        isSyncing = true
        Log.i(TAG, "🚀 Starting Sync triggered by: $reason")

        acquirePartialWakeLock()

        mainHandler.post {
            try {
                activeActivityWebView?.get()?.evaluateJavascript(
                    "if (typeof window !== 'undefined' && typeof window.alkarrarFlushQueue === 'function') { window.alkarrarFlushQueue(); }",
                    null
                )
            } catch (_: Throwable) {}

            try {
                backgroundWebView?.evaluateJavascript(
                    "(function() {" +
                    "  try {" +
                    "    if (typeof window !== 'undefined' && typeof window.alkarrarFlushQueue === 'function') {" +
                    "      return window.alkarrarFlushQueue();" +
                    "    }" +
                    "  } catch (e) { return 'ERR: ' + e.message; }" +
                    "  return 'NOT_FOUND';" +
                    "})();"
                ) { value -> Log.d(TAG, "Background WebView sync eval result: $value") }
            } catch (_: Throwable) {}

            try {
                val syncIntent = Intent("com.alkarrar.mobile.INTERNET_RESTORED").apply {
                    setPackage(packageName)
                }
                sendBroadcast(syncIntent)
            } catch (_: Throwable) {}
        }

        executorService.execute {
            var syncedCount = 0
            try {
                syncedCount = performNativeStorageSync(this@ForegroundSyncService)
            } catch (e: Throwable) {
                Log.w(TAG, "Native storage sync error: ${e.message}")
            } finally {
                val count = syncedCount
                isSyncing = false
                mainHandler.post {
                    if (count > 0) {
                        updateNotification("تمت مزامنة $count عملية بنجاح ✓")
                        mainHandler.postDelayed({
                            updateNotification("يراقب الاتصال للمزامنة الفورية عند توفر الإنترنت")
                        }, 4000)
                    } else {
                        updateNotification("يراقب الاتصال للمزامنة الفورية عند توفر الإنترنت")
                    }
                }
            }
        }
    }

    private fun acquirePartialWakeLock() {
        try {
            val powerManager = getSystemService(Context.POWER_SERVICE) as? PowerManager
            if (powerManager != null) {
                if (wakeLock == null) {
                    wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Alkarrar:SyncWakeLock").apply {
                        setReferenceCounted(false)
                    }
                }
                if (wakeLock?.isHeld == false) {
                    wakeLock?.acquire(10 * 60 * 1000L)
                }
            }
        } catch (e: Throwable) {
            Log.w(TAG, "WakeLock acquisition warning: ${e.message}")
        }
    }

    private fun acquireWifiLock() {
        try {
            val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as? android.net.wifi.WifiManager
            if (wifiManager != null) {
                if (wifiLock == null) {
                    val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.HONEYCOMB_MR1)
                        android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF
                    else
                        android.net.wifi.WifiManager.WIFI_MODE_FULL
                    wifiLock = wifiManager.createWifiLock(mode, "Alkarrar:WifiSyncLock").apply {
                        setReferenceCounted(false)
                    }
                }
                if (wifiLock?.isHeld == false) {
                    wifiLock?.acquire()
                }
            }
        } catch (e: Throwable) {
            Log.w(TAG, "WifiLock acquisition warning: ${e.message}")
        }
    }

    private fun releaseWifiLock() {
        try {
            if (wifiLock?.isHeld == true) {
                wifiLock?.release()
            }
        } catch (_: Throwable) {}
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startInForeground("يراقب الاتصال للمزامنة الفورية عند توفر الإنترنت")
        acquirePartialWakeLock()
        acquireWifiLock()
        val triggerSource = intent?.action ?: "onStartCommand"
        triggerImmediateSync(triggerSource)
        scheduleRepeatingAlarmHeartbeat(20000)
        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        Log.i(TAG, "Application task removed / closed by user. Triggering immediate background sync & persistence...")
        try {
            acquirePartialWakeLock()
            acquireWifiLock()
            Thread {
                try {
                    performNativeStorageSync(applicationContext)
                } catch (e: Throwable) {
                    Log.w(TAG, "onTaskRemoved sync error: ${e.message}")
                }
            }.start()
        } catch (_: Throwable) {}

        try {
            SyncWorker.enqueueImmediateWork(applicationContext)
            SyncWorker.enqueueWork(applicationContext)
        } catch (_: Throwable) {}

        try {
            val restartIntent = Intent(applicationContext, ForegroundSyncService::class.java).apply {
                setPackage(packageName)
            }
            val pendingIntent = PendingIntent.getService(
                applicationContext,
                1001,
                restartIntent,
                PendingIntent.FLAG_ONE_SHOT or if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0
            )
            val alarmManager = getSystemService(Context.ALARM_SERVICE) as? AlarmManager
            alarmManager?.set(
                AlarmManager.ELAPSED_REALTIME,
                SystemClock.elapsedRealtime() + 1500,
                pendingIntent
            )
        } catch (_: Throwable) {}

        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        super.onDestroy()
        try {
            periodicHandler.removeCallbacks(periodicRunnable)
            if (connectivityManager != null && networkCallback != null) {
                connectivityManager?.unregisterNetworkCallback(networkCallback!!)
            }
            if (wakeLock?.isHeld == true) {
                wakeLock?.release()
            }
            releaseWifiLock()
        } catch (_: Throwable) {}

        try {
            SyncWorker.enqueueImmediateWork(applicationContext)
            SyncWorker.enqueueWork(applicationContext)
        } catch (_: Throwable) {}

        try {
            val restartIntent = Intent(applicationContext, ForegroundSyncService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                applicationContext.startForegroundService(restartIntent)
            } else {
                applicationContext.startService(restartIntent)
            }
        } catch (_: Throwable) {}
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
