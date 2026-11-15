package com.alkarrar.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;
import android.util.Log;
import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;
import java.security.SecureRandom;

/**
 * Hardware-backed Android Keystore vault using Jetpack Security MasterKey (AES256-GCM)
 * and EncryptedSharedPreferences. Stores JWT auth tokens, session HMAC keys, and the
 * randomly generated SQLCipher database encryption passphrase.
 */
public final class SecureKeyStoreHelper {
    private static final String TAG = "AlkarrarKeyStore";
    private static final String VAULT_FILE = "alkarrar_keystore_vault";
    private static final String KEY_SQLCIPHER_PASSPHRASE = "__sqlcipher_db_key_v1__";

    private static volatile SharedPreferences cachedEncryptedPrefs = null;

    private SecureKeyStoreHelper() {}

    private static SharedPreferences getVault(Context context) {
        if (context == null) return null;
        if (cachedEncryptedPrefs != null) {
            return cachedEncryptedPrefs;
        }
        synchronized (SecureKeyStoreHelper.class) {
            if (cachedEncryptedPrefs != null) {
                return cachedEncryptedPrefs;
            }
            Context appCtx = context.getApplicationContext();
            try {
                MasterKey masterKey = new MasterKey.Builder(appCtx)
                    .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                    .build();

                cachedEncryptedPrefs = EncryptedSharedPreferences.create(
                    appCtx,
                    VAULT_FILE,
                    masterKey,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
                );
                return cachedEncryptedPrefs;
            } catch (Throwable e) {
                Log.e(TAG, "EncryptedSharedPreferences init failed, attempting recovery: " + e.getMessage());
                try {
                    // Recover only if Keystore master key was invalidated by OS backup/restore
                    appCtx.deleteSharedPreferences(VAULT_FILE);
                    MasterKey masterKey = new MasterKey.Builder(appCtx)
                        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                        .build();

                    cachedEncryptedPrefs = EncryptedSharedPreferences.create(
                        appCtx,
                        VAULT_FILE,
                        masterKey,
                        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
                    );
                    return cachedEncryptedPrefs;
                } catch (Throwable fatal) {
                    Log.e(TAG, "Critical Keystore failure: " + fatal.getMessage());
                    return null;
                }
            }
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
            Log.w(TAG, "Failed reading key from Keystore vault: " + e.getMessage());
            return defaultValue;
        }
    }

    public static synchronized void remove(Context context, String key) {
        if (context == null || key == null) return;
        SharedPreferences vault = getVault(context);
        if (vault == null) return;
        vault.edit().remove(key).apply();
    }

    /**
     * Retrieves or randomly generates a 256-bit passphrase stored exclusively
     * inside the Android Keystore-backed EncryptedSharedPreferences vault.
     */
    public static synchronized char[] getOrCreateDbPassphraseChars(Context context) {
        String existing = getString(context, KEY_SQLCIPHER_PASSPHRASE, null);
        if (existing != null && existing.length() >= 32) {
            return existing.toCharArray();
        }
        byte[] randomBytes = new byte[32];
        new SecureRandom().nextBytes(randomBytes);
        String generated = Base64.encodeToString(randomBytes, Base64.NO_WRAP);
        putString(context, KEY_SQLCIPHER_PASSPHRASE, generated);
        return generated.toCharArray();
    }
}
