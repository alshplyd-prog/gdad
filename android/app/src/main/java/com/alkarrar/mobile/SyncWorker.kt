package com.alkarrar.mobile

import android.content.Context
import android.util.Log
import androidx.work.*
import java.util.concurrent.TimeUnit

class SyncWorker(context: Context, workerParams: WorkerParameters) : Worker(context, workerParams) {
    companion object {
        private const val TAG = "SyncWorker"
        const val WORK_NAME = "AlkarrarOfflineSyncWorker"
        const val IMMEDIATE_WORK_NAME = "AlkarrarImmediateCloseSyncWorker"

        fun enqueueImmediateWork(context: Context?) {
            if (context == null) return
            try {
                val constraints = Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build()

                val request = OneTimeWorkRequest.Builder(SyncWorker::class.java)
                    .setConstraints(constraints)
                    .build()

                WorkManager.getInstance(context).enqueueUniqueWork(
                    IMMEDIATE_WORK_NAME,
                    ExistingWorkPolicy.REPLACE,
                    request
                )
                Log.i(TAG, "Immediate WorkManager sync enqueued on app close/pause.")
            } catch (e: Throwable) {
                Log.w(TAG, "Failed to enqueue immediate work: ${e.message}")
            }
        }

        fun enqueueWork(context: Context?) {
            if (context == null) return
            try {
                val constraints = Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build()

                val request = PeriodicWorkRequest.Builder(
                    SyncWorker::class.java,
                    15,
                    TimeUnit.MINUTES
                )
                .setConstraints(constraints)
                .build()

                WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                    WORK_NAME,
                    ExistingPeriodicWorkPolicy.KEEP,
                    request
                )
            } catch (_: Throwable) {}
        }
    }

    override fun doWork(): Result {
        return try {
            Log.i(TAG, "SyncWorker executing background work...")
            val synced = ForegroundSyncService.performNativeStorageSync(applicationContext)
            Log.i(TAG, "SyncWorker background sync completed. Synced count: $synced")
            ForegroundSyncService.getInstance()?.triggerImmediateSync("WorkManager doWork")
            Result.success()
        } catch (e: Throwable) {
            Log.w(TAG, "SyncWorker doWork failed: ${e.message}")
            Result.retry()
        }
    }
}
