package com.alkarrar.mobile;

import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.util.Log;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.util.Arrays;
import net.sqlcipher.database.SQLiteDatabase;
import net.sqlcipher.database.SQLiteOpenHelper;

/**
 * Full-database encrypted storage powered by SQLCipher (AES-256).
 * The database passphrase is generated dynamically and kept solely inside
 * Android Keystore via SecureKeyStoreHelper.
 */
public class EncryptedOfflineDbHelper extends SQLiteOpenHelper {
    private static final String TAG = "AlkarrarSqlCipher";
    private static final String DB_NAME = "alkarrar_secure.db";
    private static final int DB_VERSION = 1;
    private static final String TABLE_KV = "kv_store";

    public static final String KEY_PENDING_QUEUE = "alkarrar_offline_pending_queue";
    public static final String KEY_SERVER_URL = "alkarrar_backend_server_url";

    private static volatile boolean libsLoaded = false;
    private static volatile EncryptedOfflineDbHelper instance = null;

    private EncryptedOfflineDbHelper(Context context) {
        super(context.getApplicationContext(), DB_NAME, null, DB_VERSION);
    }

    private static void ensureLibsLoaded(Context context) {
        if (!libsLoaded) {
            synchronized (EncryptedOfflineDbHelper.class) {
                if (!libsLoaded) {
                    SQLiteDatabase.loadLibs(context.getApplicationContext());
                    libsLoaded = true;
                }
            }
        }
    }

    private static EncryptedOfflineDbHelper getInstance(Context context) {
        ensureLibsLoaded(context);
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
        char[] passphrase = SecureKeyStoreHelper.getOrCreateDbPassphraseChars(context);
        SQLiteDatabase db = null;
        try {
            db = getInstance(context).getWritableDatabase(passphrase);
            ContentValues cv = new ContentValues();
            cv.put("k", key);
            cv.put("v", value);
            cv.put("updated_at", System.currentTimeMillis());
            db.insertWithOnConflict(TABLE_KV, null, cv, SQLiteDatabase.CONFLICT_REPLACE);
        } catch (Throwable e) {
            Log.e(TAG, "SQLCipher putValue error: " + e.getMessage());
        } finally {
            Arrays.fill(passphrase, '\0');
        }
    }

    public static synchronized String getValue(Context context, String key) {
        if (context == null || key == null) return null;
        char[] passphrase = SecureKeyStoreHelper.getOrCreateDbPassphraseChars(context);
        Cursor cursor = null;
        try {
            SQLiteDatabase db = getInstance(context).getReadableDatabase(passphrase);
            cursor = db.rawQuery("SELECT v FROM " + TABLE_KV + " WHERE k = ? LIMIT 1", new String[]{ key });
            if (cursor != null && cursor.moveToFirst()) {
                return cursor.getString(0);
            }
        } catch (Throwable e) {
            Log.e(TAG, "SQLCipher getValue error: " + e.getMessage());
        } finally {
            Arrays.fill(passphrase, '\0');
            if (cursor != null) {
                try { cursor.close(); } catch (Throwable ignored) {}
            }
        }
        return null;
    }

    public static synchronized void removeValue(Context context, String key) {
        if (context == null || key == null) return;
        char[] passphrase = SecureKeyStoreHelper.getOrCreateDbPassphraseChars(context);
        try {
            SQLiteDatabase db = getInstance(context).getWritableDatabase(passphrase);
            db.delete(TABLE_KV, "k = ?", new String[]{ key });
        } catch (Throwable e) {
            Log.e(TAG, "SQLCipher removeValue error: " + e.getMessage());
        } finally {
            Arrays.fill(passphrase, '\0');
        }
    }

    /**
     * One-time migration from legacy plaintext JSON/SharedPreferences storage into
     * SQLCipher, then scrubs all plaintext remnants from disk.
     */
    public static synchronized void migrateLegacyPlaintextIfPresent(Context context) {
        if (context == null) return;
        try {
            String existingEncrypted = getValue(context, KEY_PENDING_QUEUE);
            if (existingEncrypted == null) {
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

            // Always remove legacy plaintext file and shared preferences queue copies
            File legacyFile = new File(context.getFilesDir(), "alkarrar_offline_queue.json");
            if (legacyFile.exists()) {
                legacyFile.delete();
            }
            File legacyTmp = new File(context.getFilesDir(), "alkarrar_offline_queue.json.tmp");
            if (legacyTmp.exists()) {
                legacyTmp.delete();
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
                    SharedPreferences.Editor editor = prefs.edit();
                    for (String k : keyNames) {
                        editor.remove(k);
                    }
                    editor.apply();
                } catch (Throwable ignored) {}
            }
        } catch (Throwable e) {
            Log.w(TAG, "Legacy plaintext migration note: " + e.getMessage());
        }
    }
}
