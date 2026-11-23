package com.alkarrar.mobile;

import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.util.Log;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;

/**
 * Plain unencrypted standard Android SQLite offline queue storage (no SQLCipher, no passphrases).
 */
public class EncryptedOfflineDbHelper extends SQLiteOpenHelper {
    private static final String TAG = "AlkarrarPlainSqlite";
    private static final String DB_NAME = "alkarrar_plain.db";
    private static final int DB_VERSION = 1;
    private static final String TABLE_KV = "kv_store";

    public static final String KEY_PENDING_QUEUE = "alkarrar_offline_pending_queue";
    public static final String KEY_SERVER_URL = "alkarrar_backend_server_url";

    private static volatile EncryptedOfflineDbHelper instance = null;

    private EncryptedOfflineDbHelper(Context context) {
        super(context.getApplicationContext(), DB_NAME, null, DB_VERSION);
    }

    private static EncryptedOfflineDbHelper getInstance(Context context) {
        if (instance == null) {
            synchronized (EncryptedOfflineDbHelper.class) {
                if (instance == null) {
                    instance = new EncryptedOfflineDbHelper(context);
                }
            }
        }
        return instance;
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS " + TABLE_KV + " (" +
            "k TEXT PRIMARY KEY, " +
            "v TEXT NOT NULL, " +
            "updated_at INTEGER NOT NULL)"
        );
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        onCreate(db);
    }

    public static synchronized void putValue(Context context, String key, String value) {
        if (context == null || key == null || value == null) return;
        try {
            SQLiteDatabase db = getInstance(context).getWritableDatabase();
            ContentValues cv = new ContentValues();
            cv.put("k", key);
            cv.put("v", value);
            cv.put("updated_at", System.currentTimeMillis());
            db.insertWithOnConflict(TABLE_KV, null, cv, SQLiteDatabase.CONFLICT_REPLACE);
        } catch (Throwable e) {
            Log.e(TAG, "Plain SQLite putValue error: " + e.getMessage());
        }
    }

    public static synchronized String getValue(Context context, String key) {
        if (context == null || key == null) return null;
        Cursor cursor = null;
        try {
            SQLiteDatabase db = getInstance(context).getReadableDatabase();
            cursor = db.rawQuery("SELECT v FROM " + TABLE_KV + " WHERE k = ? LIMIT 1", new String[]{ key });
            if (cursor != null && cursor.moveToFirst()) {
                return cursor.getString(0);
            }
        } catch (Throwable e) {
            Log.e(TAG, "Plain SQLite getValue error: " + e.getMessage());
        } finally {
            if (cursor != null) {
                try { cursor.close(); } catch (Throwable ignored) {}
            }
        }
        return null;
    }

    public static synchronized void removeValue(Context context, String key) {
        if (context == null || key == null) return;
        try {
            SQLiteDatabase db = getInstance(context).getWritableDatabase();
            db.delete(TABLE_KV, "k = ?", new String[]{ key });
        } catch (Throwable e) {
            Log.e(TAG, "Plain SQLite removeValue error: " + e.getMessage());
        }
    }

    /**
     * Imports any existing plaintext JSON file or SharedPreferences pending queue into plain SQLite.
     */
    public static synchronized void migrateLegacyPlaintextIfPresent(Context context) {
        if (context == null) return;
        try {
            String existingQueue = getValue(context, KEY_PENDING_QUEUE);
            if (existingQueue == null) {
                File legacyFile = new File(context.getFilesDir(), "alkarrar_offline_queue.json");
                if (legacyFile.exists() && legacyFile.length() > 2) {
                    try (FileInputStream fis = new FileInputStream(legacyFile);
                         ByteArrayOutputStream baos = new ByteArrayOutputStream()) {
                        byte[] buf = new byte[2048];
                        int len;
                        while ((len = fis.read(buf)) != -1) {
                            baos.write(buf, 0, len);
                        }
                        String content = baos.toString("UTF-8").trim();
                        if (content.startsWith("[") && content.endsWith("]")) {
                            putValue(context, KEY_PENDING_QUEUE, content);
                        }
                    } catch (Throwable ignored) {}
                }
            }

            String[] prefNames = { "AlkarrarSync", "CapacitorStorage", "CapacitorPreferences" };
            String[] keyNames = {
                KEY_PENDING_QUEUE,
                "CapacitorStorage." + KEY_PENDING_QUEUE,
                "CapacitorPreferences." + KEY_PENDING_QUEUE,
                "_cap_" + KEY_PENDING_QUEUE
            };
            for (String pName : prefNames) {
                try {
                    SharedPreferences prefs = context.getSharedPreferences(pName, Context.MODE_PRIVATE);
                    if (getValue(context, KEY_PENDING_QUEUE) == null) {
                        for (String k : keyNames) {
                            String val = prefs.getString(k, null);
                            if (val != null && val.trim().startsWith("[") && val.trim().endsWith("]")) {
                                putValue(context, KEY_PENDING_QUEUE, val.trim());
                                break;
                            }
                        }
                    }
                    if (getValue(context, KEY_SERVER_URL) == null) {
                        String urlVal = prefs.getString(KEY_SERVER_URL, null);
                        if (urlVal != null && !urlVal.trim().isEmpty()) {
                            putValue(context, KEY_SERVER_URL, urlVal.trim());
                        }
                    }
                } catch (Throwable ignored) {}
            }
        } catch (Throwable e) {
            Log.w(TAG, "Legacy migration note: " + e.getMessage());
        }
    }
}
