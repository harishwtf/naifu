/*
 * Naifu - engine store.
 *
 * The heavy engines (FFmpeg, Whisper, Ollama) are ~2-3 GB and can't ship inside
 * a signed .zxp, so they're fetched ONCE and kept OUTSIDE the extension folder:
 *
 *     Windows   %APPDATA%\Naifu\engines\
 *     macOS     ~/Library/Application Support/Naifu/engines/
 *
 * Living outside the panel means updating or reinstalling Naifu never costs the
 * user another download. The AI model weights live there too, for the same
 * reason (they used to sit in the extension's bin/, which a reinstall wipes).
 *
 * The rule this module exists to enforce: NOTHING here touches the network
 * unless a binary is genuinely missing. status() is a pure filesystem check, and
 * install() short-circuits the moment the file is on disk. A satisfied install
 * makes zero network calls, ever.
 *
 * A dev checkout with binaries already in the repo's bin/ keeps working — that
 * location is searched first, so nothing is downloaded for it either.
 */
var QCEngines = (function () {
  "use strict";

  var nodeRequire =
    (typeof require === "function") ? require :
    (typeof cep_node !== "undefined" && cep_node.require) ? cep_node.require :
    null;

  function nodeAvailable() { return !!nodeRequire; }
  function fsMod() { return nodeRequire("fs"); }
  function pathMod() { return nodeRequire("path"); }
  function cpMod() { return nodeRequire("child_process"); }

  // Set once by main.js, which is the only place that knows CEP's paths.
  var cfg = { extRoot: "", userRoot: "", isMac: false, arm: false };
  function configure(o) {
    for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) { cfg[k] = o[k]; } }
  }

  function exists(p) { try { return !!p && fsMod().existsSync(p); } catch (e) { return false; } }
  function mkdirp(p) { try { fsMod().mkdirSync(p, { recursive: true }); } catch (e) {} }
  function join() {
    return Array.prototype.slice.call(arguments).filter(Boolean).join("/").replace(/\/+/g, "/");
  }

  /* ---------- what we need, and where it comes from ---------- */

  function defs() {
    var mac = cfg.isMac, arm = !!cfg.arm;
    return {
      ffmpeg: {
        label: "FFmpeg",
        why: "Pulls audio out of your clips. Every feature needs it.",
        binName: mac ? "ffmpeg" : "ffmpeg.exe",
        multi: false,                       // a single self-contained binary
        sizeMb: mac ? 30 : 90,
        url: mac
          ? ("https://ffmpeg.martin-riedl.de/redirect/latest/macos/" + (arm ? "arm64" : "amd64") + "/release/ffmpeg.zip")
          : "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
      },
      whisper: {
        label: "Whisper (speech-to-text)",
        why: "Word-level transcripts — needed by Fillers, Cleanup, Captions, Vox Pop, Story, Hook and Speaker.",
        destDir: "Faster-Whisper-XXL",
        binName: mac ? "whisper-faster" : "faster-whisper-xxl.exe",
        multi: true,                        // ships as a folder of DLLs/libs
        sizeMb: mac ? 78 : 1358,
        url: mac
          // Purfview publishes no current macOS build; this is the last one they
          // shipped (2023, Intel — runs under Rosetta 2 on Apple Silicon).
          ? "https://github.com/Purfview/whisper-standalone-win/releases/download/faster-whisper/Whisper-Faster_r186.1_macOS-x86-64.zip"
          : "https://github.com/Purfview/whisper-standalone-win/releases/download/Faster-Whisper-XXL/Faster-Whisper-XXL_r245.4_windows.7z",
        legacy: mac   // flagged in the UI so the user knows what they're getting
      },
      ollama: {
        label: "Ollama (local AI)",
        why: "Runs the local brain. Skip it if you only use Claude (manual) — that needs no install.",
        destDir: "ollama",
        binName: mac ? "ollama" : "ollama.exe",
        multi: true,
        sizeMb: mac ? 146 : (arm ? 200 : 1392),
        url: mac
          ? "https://github.com/ollama/ollama/releases/latest/download/ollama-darwin.tgz"
          : ("https://github.com/ollama/ollama/releases/latest/download/ollama-windows-" + (arm ? "arm64" : "amd64") + ".zip"),
        optional: true
      }
    };
  }

  /** Path of an engine relative to whichever root holds it. */
  function relFor(d) { return d.multi ? join(d.destDir, d.binName) : d.binName; }

  /**
   * Where an engine is, or where it would go. A dev checkout (repo bin/) wins so
   * an existing setup keeps working untouched; otherwise the persistent store.
   */
  function pathFor(name) {
    var d = defs()[name];
    if (!d) { return ""; }
    var rel = relFor(d);
    var inRepo = join(cfg.extRoot, "bin", rel);
    if (exists(inRepo)) { return inRepo; }
    return join(cfg.userRoot, rel);
  }

  function have(name) { return exists(pathFor(name)); }

  /** Model weights live beside the engines so a reinstall never re-downloads them. */
  function modelsDir() {
    var inRepo = join(cfg.extRoot, "bin", "ollama-models");
    if (exists(inRepo)) { return inRepo; }
    var dir = join(cfg.userRoot, "ollama-models");
    mkdirp(dir);
    return dir;
  }

  /** Pure filesystem check — never hits the network. */
  function status() {
    var d = defs(), out = [];
    for (var k in d) {
      if (!Object.prototype.hasOwnProperty.call(d, k)) { continue; }
      var p = pathFor(k);
      out.push({
        name: k, label: d[k].label, why: d[k].why, sizeMb: d[k].sizeMb,
        optional: !!d[k].optional, legacy: !!d[k].legacy,
        ok: exists(p), path: p,
        inRepo: exists(p) && p.indexOf(join(cfg.extRoot, "bin")) === 0
      });
    }
    return out;
  }

  /** True when everything required is present (Ollama is optional). */
  function ready() {
    return status().every(function (s) { return s.ok || s.optional; });
  }

  /* ---------- download + extract ---------- */

  function download(url, dest, onProgress) {
    return new Promise(function (resolve, reject) {
      var https = nodeRequire("https");
      var fs = fsMod();
      var hops = 0;

      function get(u) {
        var req = https.get(u, { headers: { "User-Agent": "Naifu" } }, function (res) {
          // GitHub hands off to a CDN; follow it.
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            if (++hops > 5) { reject(new Error("Too many redirects.")); return; }
            get(res.headers.location);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error("Download failed (HTTP " + res.statusCode + ") — " + u));
            return;
          }
          var total = parseInt(res.headers["content-length"], 10) || 0;
          var got = 0, lastPct = -1;
          var file = fs.createWriteStream(dest);
          res.on("data", function (c) {
            got += c.length;
            if (onProgress && total) {
              var pct = Math.floor(got / total * 100);
              if (pct !== lastPct) { lastPct = pct; onProgress(pct, got, total); }
            }
          });
          res.pipe(file);
          file.on("finish", function () { file.close(function () { resolve(dest); }); });
          file.on("error", function (e) { reject(e); });
        });
        req.on("error", function (e) { reject(new Error("Download failed: " + e.message)); });
        req.setTimeout(120000, function () { req.destroy(); reject(new Error("Download timed out.")); });
      }
      get(url);
    });
  }

  /**
   * Unpack with bsdtar (libarchive), which reads zip, tar.gz AND 7z — one path
   * for every archive we fetch. On Windows use the System32 copy explicitly:
   * a Git-for-Windows GNU tar earlier on PATH can't read zip or 7z.
   */
  function extract(archive, destDir) {
    return new Promise(function (resolve, reject) {
      mkdirp(destDir);
      var tar = cfg.isMac ? "/usr/bin/tar"
        : ((process.env.SystemRoot || "C:\\Windows") + "\\System32\\tar.exe");
      var child = cpMod().spawn(tar, ["-xf", archive, "-C", destDir], { windowsHide: true });
      var err = "";
      child.stderr.on("data", function (c) { err += c; });
      child.on("error", function (e) { reject(new Error("Could not run tar: " + e.message)); });
      child.on("close", function (code) {
        if (code === 0) { resolve(destDir); }
        else { reject(new Error("Could not unpack the archive. " + (err || "").slice(0, 300))); }
      });
    });
  }

  /** Depth-first hunt for a file by name inside an extracted tree. */
  function findFile(root, name, depth) {
    var fs = fsMod();
    if (depth == null) { depth = 0; }
    if (depth > 6) { return ""; }
    var entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return ""; }
    var dirs = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var full = join(root, e.name);
      if (e.isDirectory()) { dirs.push(full); }
      else if (e.name === name) { return full; }
    }
    for (var j = 0; j < dirs.length; j++) {
      var hit = findFile(dirs[j], name, depth + 1);
      if (hit) { return hit; }
    }
    return "";
  }

  function copyRecursive(src, dst) {
    var fs = fsMod();
    var st = fs.statSync(src);
    if (st.isDirectory()) {
      mkdirp(dst);
      fs.readdirSync(src).forEach(function (n) { copyRecursive(join(src, n), join(dst, n)); });
    } else {
      mkdirp(dst.replace(/\/[^\/]+$/, ""));
      fs.copyFileSync(src, dst);
      try { fs.chmodSync(dst, 0o755); } catch (e) {}
    }
  }

  /** macOS kills unsigned/quarantined binaries — clear the flags and ad-hoc sign. */
  function unquarantine(target) {
    if (!cfg.isMac || !exists(target)) { return; }
    try { cpMod().spawnSync("xattr", ["-cr", target]); } catch (e) {}
    try { cpMod().spawnSync("codesign", ["-s", "-", "-f", target]); } catch (e) {}
  }

  // In-flight installs, so a double-click can't start the same download twice.
  var inFlight = {};

  /**
   * Fetch an engine — but only if it isn't already there. Resolves immediately
   * (no network) when the binary exists, which is the normal case on every run
   * after the first.
   */
  function install(name, onProgress) {
    if (!nodeAvailable()) { return Promise.reject(new Error("Node.js isn't enabled in this panel.")); }
    var d = defs()[name];
    if (!d) { return Promise.reject(new Error("Unknown component: " + name)); }
    if (have(name)) { return Promise.resolve({ name: name, path: pathFor(name), skipped: true }); }
    if (inFlight[name]) { return inFlight[name]; }

    var os = nodeRequire("os");
    var tmpRoot = join(String(os.tmpdir()).replace(/\\/g, "/"), "naifu-install-" + name + "-" + Date.now());
    var archive = tmpRoot + "-archive";
    var work = tmpRoot + "-unpacked";

    var p = Promise.resolve()
      .then(function () {
        mkdirp(cfg.userRoot);
        if (onProgress) { onProgress({ phase: "download", pct: 0 }); }
        return download(d.url, archive, function (pct) {
          if (onProgress) { onProgress({ phase: "download", pct: pct }); }
        });
      })
      .then(function () {
        if (onProgress) { onProgress({ phase: "extract", pct: null }); }
        return extract(archive, work);
      })
      .then(function () {
        var found = findFile(work, d.binName);
        if (!found) {
          throw new Error("Downloaded " + d.label + ", but couldn't find " + d.binName + " inside it. " +
            "The publisher may have changed their layout — install it by hand and point Naifu at it.");
        }
        var dest;
        if (d.multi) {
          // Keep the binary's whole folder — it needs its sibling libraries.
          var parent = found.replace(/\/[^\/]+$/, "");
          dest = join(cfg.userRoot, d.destDir);
          copyRecursive(parent, dest);
          unquarantine(dest);
        } else {
          dest = join(cfg.userRoot, d.binName);
          copyRecursive(found, dest);
          unquarantine(dest);
        }
        // Clean up the temp files; failure here is harmless.
        try { fsMod().rmSync(archive, { force: true }); } catch (e) {}
        try { fsMod().rmSync(work, { recursive: true, force: true }); } catch (e) {}

        var finalPath = pathFor(name);
        if (!exists(finalPath)) { throw new Error("Install finished but " + d.binName + " isn't where expected."); }
        writeManifest(name, d);
        if (onProgress) { onProgress({ phase: "done", pct: 100 }); }
        return { name: name, path: finalPath, skipped: false };
      })
      .then(function (r) { delete inFlight[name]; return r; })
      .catch(function (e) {
        delete inFlight[name];
        try { fsMod().rmSync(archive, { force: true }); } catch (e2) {}
        try { fsMod().rmSync(work, { recursive: true, force: true }); } catch (e3) {}
        throw e;
      });

    inFlight[name] = p;
    return p;
  }

  /**
   * Adopt a copy the user already has (they point at the binary or its folder).
   * The offline path, and the answer for a platform we have no download for.
   */
  function adopt(name, srcPath) {
    var d = defs()[name];
    if (!d) { return Promise.reject(new Error("Unknown component: " + name)); }
    if (!exists(srcPath)) { return Promise.reject(new Error("Can't find " + srcPath)); }
    return Promise.resolve().then(function () {
      var fs = fsMod();
      var st = fs.statSync(srcPath);
      var src = srcPath.replace(/\\/g, "/");
      // Given a folder, locate the binary inside it.
      if (st.isDirectory()) {
        var hit = findFile(src, d.binName);
        if (!hit) { throw new Error("No " + d.binName + " inside that folder."); }
        src = d.multi ? hit.replace(/\/[^\/]+$/, "") : hit;
      }
      mkdirp(cfg.userRoot);
      var dest = d.multi ? join(cfg.userRoot, d.destDir) : join(cfg.userRoot, d.binName);
      copyRecursive(src, dest);
      unquarantine(dest);
      if (!exists(pathFor(name))) { throw new Error("Copied, but " + d.binName + " isn't where expected."); }
      writeManifest(name, d);
      return { name: name, path: pathFor(name) };
    });
  }

  /** Informational only — the filesystem, not this file, decides what's installed. */
  function writeManifest(name, d) {
    try {
      var f = join(cfg.userRoot, "engines.json");
      var data = {};
      if (exists(f)) { try { data = JSON.parse(fsMod().readFileSync(f, "utf8")) || {}; } catch (e) {} }
      data[name] = { source: d.url, installed: new Date().toISOString() };
      fsMod().writeFileSync(f, JSON.stringify(data, null, 2), "utf8");
    } catch (e) {}
  }

  return {
    nodeAvailable: nodeAvailable,
    configure: configure,
    defs: defs,
    pathFor: pathFor,
    have: have,
    status: status,
    ready: ready,
    modelsDir: modelsDir,
    install: install,
    adopt: adopt
  };
})();
