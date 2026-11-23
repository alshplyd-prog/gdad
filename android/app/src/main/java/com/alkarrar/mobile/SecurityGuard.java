package com.alkarrar.mobile;

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Disabled runtime security guard (no root/frida/xposed/debugger checks).
 */
public final class SecurityGuard {
    private SecurityGuard() {}

    public static JSONObject inspectEnvironment(Context _context) {
        JSONObject result = new JSONObject();
        try {
            result.put("compromised", false);
            result.put("rooted", false);
            result.put("fridaDetected", false);
            result.put("xposedDetected", false);
            result.put("debuggerAttached", false);
            result.put("reasons", new JSONArray());
        } catch (Throwable ignored) {}
        return result;
    }
}
