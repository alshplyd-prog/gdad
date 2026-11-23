package com.alkarrar.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

/**
 * Plain SharedPreferences helper (no Android Keystore or EncryptedSharedPreferences).
 */
public final class SecureKeyStoreHelper {
    private static final String TAG = "AlkarrarPlainPrefs";
    private static final String PREFS_FILE = "alkarrar_plain_prefs";

    private static volatile SharedPreferences cachedPrefs = null;

    private SecureKeyStoreHelper() {}

    private static SharedPreferences getVault(Context context) {
        if (context == null) return null;
        if (cachedPrefs != null) {
            return cachedPrefs;
        }
        synchronized (SecureKeyStoreHelper.class) {
            if (cachedPrefs != null) {
                return cachedPrefs;
            }
            Context appCtx = context.getApplicationContext();
            cachedPrefs = appCtx.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE);
            return cachedPrefs;
        }
    }

    public static synchronized void putString(Context context, String key, String value) {
        if (context == null || key == null) return;
        SharedPreferences vault = getVault(context);
        if (vault == null) return;
        if (value == null) {
            vault.edit().remove(key).apply();
        } else {
            vault.edit().putString(key, value).apply();
        }
    }

    public static synchronized String getString(Context context, String key, String defaultValue) {
        if (context == null || key == null) return defaultValue;
        SharedPreferences vault = getVault(context);
        if (vault == null) return defaultValue;
        try {
            return vault.getString(key, defaultValue);
        } catch (Throwable e) {
            Log.w(TAG, "Failed reading key from SharedPreferences: " + e.getMessage());
            return defaultValue;
        }
    }

    public static synchronized void remove(Context context, String key) {
        if (context == null || key == null) return;
        SharedPreferences vault = getVault(context);
        if (vault == null) return;
        vault.edit().remove(key).apply();
    }

    public static synchronized char[] getOrCreateDbPassphraseChars(Context context) {
        return new char[0];
    }
}
