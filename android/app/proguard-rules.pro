# R8 / ProGuard Obfuscation & Hardening Rules for Alkarrar Mobile

-repackageclasses 'o'
-allowaccessmodification
-optimizationpasses 5
-renamesourcefileattribute SourceFile
-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod

# Strip debug/verbose/info logs in release APK to prevent reverse-engineering leaks
-assumenosideeffects class android.util.Log {
    public static boolean isLoggable(java.lang.String, int);
    public static int v(...);
    public static int d(...);
    public static int i(...);
    public static int w(...);
}

# Preserve app AndroidManifest components & native security helpers
-keep class com.alkarrar.mobile.MainActivity { *; }
-keep class com.alkarrar.mobile.ForegroundSyncService { *; }
-keep class com.alkarrar.mobile.BootReceiver { *; }
-keep class com.alkarrar.mobile.SyncWorker { *; }
-keep class com.alkarrar.mobile.EncryptedOfflineDbHelper { *; }
-keep class com.alkarrar.mobile.SecureKeyStoreHelper { *; }
-keep class com.alkarrar.mobile.SecurityGuard { *; }
-keep class com.alkarrar.mobile.MainActivity$PrinterJavascriptInterface {
    public *;
}

# Preserve WebView JavascriptInterface bridge methods
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Preserve Capacitor Bridge, Plugins, and AndroidX FileProvider
-keep class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keep class androidx.core.content.FileProvider { *; }

# Preserve AndroidX WorkManager workers instantiated via reflection
-keep class androidx.work.** { *; }
-keep class * extends androidx.work.Worker { *; }
-keep class * extends androidx.work.ListenableWorker { *; }

# Preserve SQLCipher native bindings, AndroidX Security Crypto, and Google Tink (required by EncryptedSharedPreferences)
-keep class net.sqlcipher.** { *; }
-keep class net.sqlcipher.database.** { *; }
-keep class net.zetetic.** { *; }
-keep class androidx.security.crypto.** { *; }
-keep class com.google.crypto.tink.** { *; }
-keepclassmembers class com.google.crypto.tink.shaded.protobuf.** { *; }

-dontwarn net.sqlcipher.**
-dontwarn net.zetetic.**
-dontwarn com.google.crypto.tink.**
-dontwarn com.google.errorprone.annotations.**
-dontwarn javax.annotation.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
