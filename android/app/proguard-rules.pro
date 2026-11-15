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

# Preserve WebView JavascriptInterface bridge methods
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keepclassmembers class com.alkarrar.mobile.MainActivity$PrinterJavascriptInterface {
    public *;
}

# Preserve Capacitor Bridge & Plugins
-keep class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }

# Preserve SQLCipher native bindings & AndroidX Security Crypto
-keep class net.sqlcipher.** { *; }
-keep class net.sqlcipher.database.** { *; }
-keep class androidx.security.crypto.** { *; }
-dontwarn net.sqlcipher.**
-dontwarn com.google.errorprone.annotations.**
