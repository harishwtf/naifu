/*
 * Naifu - minimal CSInterface shim.
 *
 * Adobe ships a large CSInterface.js with their CEP samples. We only need a
 * small, well-understood subset for this panel, so this file implements just
 * that subset against the `window.__adobe_cep__` object that Premiere injects
 * into every CEP panel. If we ever need more (events, themes, etc.) we can drop
 * in Adobe's full CSInterface.js without changing how main.js calls it.
 */

/** Known system path keys (matches Adobe's SystemPath enum). */
var SystemPath = {
    USER_DATA: "userData",
    COMMON_FILES: "commonFiles",
    MY_DOCUMENTS: "myDocuments",
    APPLICATION: "application",
    EXTENSION: "extension",
    HOST_APPLICATION: "hostApplication"
};

function CSInterface() {}

/**
 * Run an ExtendScript string in the host (Premiere). The host evaluates it in
 * the context of jsx/host.jsx (loaded via the manifest ScriptPath), so any
 * function defined there is callable here.
 *
 * @param {string} script   ExtendScript to evaluate, e.g. "getActiveSequenceInfo()".
 * @param {function} callback  Receives the function's return value as a string.
 */
CSInterface.prototype.evalScript = function (script, callback) {
    if (typeof callback !== "function") {
        callback = function () {};
    }
    if (window.__adobe_cep__ && typeof window.__adobe_cep__.evalScript === "function") {
        window.__adobe_cep__.evalScript(script, callback);
    } else {
        // Running outside Premiere (e.g. opened in a browser for UI work).
        callback("EvalScript error: not running inside a CEP host.");
    }
};

/** Returns a JSON string describing the host app (id + version). */
CSInterface.prototype.getHostEnvironment = function () {
    if (window.__adobe_cep__ && typeof window.__adobe_cep__.getHostEnvironment === "function") {
        return JSON.parse(window.__adobe_cep__.getHostEnvironment());
    }
    return null;
};

/** Returns an absolute path for one of the SystemPath keys. */
CSInterface.prototype.getSystemPath = function (pathType) {
    if (!window.__adobe_cep__ || typeof window.__adobe_cep__.getSystemPath !== "function") {
        return "";
    }
    var path = window.__adobe_cep__.getSystemPath(pathType);
    // CEP returns a file URL on some hosts; normalize to a plain OS path.
    var OSVersion = this.getOSInformation();
    if (OSVersion.indexOf("Windows") >= 0) {
        path = path.replace(/\//g, "\\").replace("file:\\\\\\", "");
    } else {
        path = path.replace("file://", "");
    }
    try {
        path = decodeURIComponent(path);
    } catch (e) {}
    return path;
};

/** Open a URL in the user's default browser (CEP-native). Returns true if the
 * CEP runtime handled it; false if unavailable (caller can fall back). */
CSInterface.prototype.openURLInDefaultBrowser = function (url) {
    if (window.cep && window.cep.util && typeof window.cep.util.openURLInDefaultBrowser === "function") {
        window.cep.util.openURLInDefaultBrowser(url);
        return true;
    }
    return false;
};

/** Best-effort OS string ("Windows..." or "Mac..."). */
CSInterface.prototype.getOSInformation = function () {
    var userAgent = navigator.userAgent;
    if (navigator.platform === "Win32" || navigator.platform === "Windows" || userAgent.indexOf("Windows") >= 0) {
        return "Windows";
    }
    if (navigator.platform === "MacIntel" || navigator.platform === "Macintosh" || userAgent.indexOf("Mac") >= 0) {
        return "Mac";
    }
    return navigator.platform;
};
