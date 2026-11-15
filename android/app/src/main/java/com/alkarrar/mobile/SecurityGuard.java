package com.alkarrar.mobile;

import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Debug;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.net.InetSocketAddress;
import java.net.Socket;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Runtime Anti-Tampering, Root Detection, Debugger, Xposed, and Frida Hook Inspector.
 */
public final class SecurityGuard {
    private static final String[] SU_PATHS = {
        "/system/app/Superuser.apk",
        "/sbin/su",
        "/system/bin/su",
        "/system/xbin/su",
        "/data/local/xbin/su",
        "/data/local/bin/su",
        "/system/sd/xbin/su",
        "/system/bin/failsafe/su",
        "/data/local/su",
        "/su/bin/su",
        "/magisk/.core/bin/su"
    };

    private static final String[] ROOT_PACKAGES = {
        "com.topjohnwu.magisk",
        "eu.chainfire.supersu",
        "com.noshufou.android.su",
        "com.koushikdutta.superuser",
        "com.thirdparty.superuser",
        "com.kingroot.kinguser",
        "com.yellowes.su"
    };

    private SecurityGuard() {}

    public static JSONObject inspectEnvironment(Context context) {
        JSONObject result = new JSONObject();
        JSONArray reasons = new JSONArray();
        boolean rooted = false;
        boolean fridaDetected = false;
        boolean xposedDetected = false;
        boolean debuggerAttached = false;

        try {
            // 1. Root checks
            for (String path : SU_PATHS) {
                try {
                    if (new File(path).exists()) {
                        rooted = true;
                        reasons.put("su_binary:" + path);
                        break;
                    }
                } catch (Throwable ignored) {}
            }

            if (Build.TAGS != null && Build.TAGS.contains("test-keys")) {
                rooted = true;
                reasons.put("build_test_keys");
            }

            if (context != null) {
                PackageManager pm = context.getPackageManager();
                for (String pkg : ROOT_PACKAGES) {
                    try {
                        pm.getPackageInfo(pkg, 0);
                        rooted = true;
                        reasons.put("root_pkg:" + pkg);
                        break;
                    } catch (Throwable ignored) {}
                }
            }

            // 2. Debugger detection
            if (Debug.isDebuggerConnected() || Debug.waitingForDebugger()) {
                debuggerAttached = true;
                reasons.put("debugger_connected");
            }

            // 3. Process memory map inspection for Frida / Xposed / Substrate hooks
            try (BufferedReader br = new BufferedReader(new FileReader("/proc/self/maps"))) {
                String line;
                while ((line = br.readLine()) != null) {
                    String lower = line.toLowerCase();
                    if (lower.contains("frida") || lower.contains("gadget")) {
                        fridaDetected = true;
                        reasons.put("proc_maps_frida");
                        break;
                    }
                    if (lower.contains("xposed") || lower.contains("lsposed") || lower.contains("edxposed") || lower.contains("substrate")) {
                        xposedDetected = true;
                        reasons.put("proc_maps_xposed");
                        break;
                    }
                }
            } catch (Throwable ignored) {}

            // 4. Xposed class/stack presence
            try {
                Class.forName("de.robv.android.xposed.XposedBridge", false, SecurityGuard.class.getClassLoader());
                xposedDetected = true;
                reasons.put("xposed_bridge_loaded");
            } catch (Throwable ignored) {}

            // 5. Fast loopback check for active Frida server ports (27042 / 27043)
            if (!fridaDetected) {
                if (isLocalPortOpen(27042) || isLocalPortOpen(27043)) {
                    fridaDetected = true;
                    reasons.put("frida_port_open");
                }
            }
        } catch (Throwable ignored) {}

        boolean compromised = rooted || fridaDetected || xposedDetected || debuggerAttached;
        try {
            result.put("compromised", compromised);
            result.put("rooted", rooted);
            result.put("fridaDetected", fridaDetected);
            result.put("xposedDetected", xposedDetected);
            result.put("debuggerAttached", debuggerAttached);
            result.put("reasons", reasons);
        } catch (Throwable ignored) {}

        return result;
    }

    private static boolean isLocalPortOpen(int port) {
        final boolean[] open = { false };
        Thread probe = new Thread(() -> {
            Socket socket = null;
            try {
                socket = new Socket();
                socket.connect(new InetSocketAddress("127.0.0.1", port), 80);
                open[0] = true;
            } catch (Throwable ignored) {
            } finally {
                if (socket != null) {
                    try { socket.close(); } catch (Throwable ignored) {}
                }
            }
        });
        probe.start();
        try {
            probe.join(100);
        } catch (InterruptedException ignored) {}
        return open[0];
    }
}
