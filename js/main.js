/*
 * Naifu - panel UI logic.
 *   Tab 1 (Silence): FFmpeg silencedetect -> review -> razor + ripple-delete.
 *   Tab 2 (Zoom):    pick segments (smart/alternate/every) -> review -> Motion Scale.
 * All edits land on a non-destructive "- Naifu" duplicate.
 */
(function () {
  "use strict";

  var cs = new CSInterface();

  /* ---------- shared helpers ---------- */

  var els = {
    status: document.getElementById("status"),
    activeSeq: document.getElementById("activeSeq"),
    dupBtn: document.getElementById("dupBtn")
  };

  function setStatus(msg, kind) {
    els.status.textContent = msg;
    els.status.className = "status" + (kind ? " " + kind : "");
  }

  function fmtTime(sec) {
    var m = Math.floor(sec / 60);
    var s = sec - m * 60;
    return m + ":" + (s < 10 ? "0" : "") + s.toFixed(2);
  }

  // The editing engine (jsx/host.jsx) didn't load, or a call hit a function
  // that isn't there — almost always fixed by reloading the panel.
  var RELOAD_HINT = "Couldn't reach the editing engine. Reload the panel (close Naifu and reopen it from Window → Extensions), and make sure a project is open.";

  function parseHostResult(raw) {
    if (raw === undefined || raw === null || raw === "") {
      return { ok: false, error: RELOAD_HINT };
    }
    var s = String(raw);
    if (s.indexOf("EvalScript error") === 0 || /\bis undefined\b|not a function/i.test(s)) {
      return { ok: false, error: RELOAD_HINT };
    }
    try { return JSON.parse(s); }
    catch (e) { return { ok: false, error: "Unexpected response from Premiere — reload the panel and try again." }; }
  }

  function host(call) {
    return new Promise(function (resolve) {
      cs.evalScript(call, function (raw) { resolve(parseHostResult(raw)); });
    });
  }

  // Escape a string (e.g. a Windows file path) for safe embedding in an
  // evalScript("fn(\"...\")") call — backslashes and quotes.
  function jsxEscape(s) {
    return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  // Honest tail for a cut-apply result: warn about ranges the engine left alone
  // (they crossed a clip edit / gap, or would have desynced a track).
  function skipNote(res) {
    return (res && res.skipped)
      ? " " + res.skipped + " skipped — they cross a clip edit, a gap, or would desync a track; trim those by hand."
      : "";
  }

  // Move Premiere's playhead to a time (seconds) so the user can preview a spot.
  function jumpToTime(sec) {
    host("qcSetPlayhead(" + Number(sec).toFixed(3) + ")");
  }

  // First `n` words of a string, with an ellipsis if it was longer.
  function firstWords(text, n) {
    var w = String(text || "").trim().split(/\s+/).filter(Boolean);
    if (w.length === 0) { return ""; }
    var out = w.slice(0, n).join(" ");
    return (w.length > n) ? out + "…" : out;
  }
  // First `n` spoken words inside [start,end] pulled from transcript segments —
  // used to label a zoom moment with what's actually being said there.
  function firstWordsFromSegments(segments, start, end, n) {
    if (!segments || !segments.length) { return ""; }
    var txt = "";
    for (var i = 0; i < segments.length; i++) {
      var s = segments[i];
      if (s.start >= end) { break; }
      if (s.start < end && s.end > start) { txt += " " + (s.text || ""); }
    }
    return firstWords(txt, n);
  }

  // Per-clip transcription progress message (only counts when >1 clip so a
  // single-clip sequence just says "Transcribing…").
  function transcribeProgress(verb) {
    return function (doneIndex, total) {
      if (total > 1) { setStatus(verb + " clip " + (doneIndex + 1) + " of " + total + "…", "busy"); }
      else { setStatus(verb + "…", "busy"); }
    };
  }

  /* ---------- shared AI "brain" selector (used by Highlights + Zoom) ---------- */
  var BRAIN_KEY = "quietcut.brain.v1";
  function brainGet() {
    try { var v = JSON.parse(localStorage.getItem(BRAIN_KEY)); if (v) { return v; } } catch (e) {}
    return { brain: "local", apiKey: "" };
  }
  function brainSync() {
    var v = brainGet();
    document.querySelectorAll(".qc-brain").forEach(function (s) { s.value = v.brain; });
    document.querySelectorAll(".qc-key").forEach(function (i) { i.value = v.apiKey; });
    document.querySelectorAll(".qc-keyfield").forEach(function (f) {
      f.classList.toggle("hidden", v.brain !== "claude-api");
    });
  }
  function brainInit() {
    document.querySelectorAll(".qc-brain").forEach(function (s) {
      s.addEventListener("change", function () {
        var v = brainGet(); v.brain = s.value;
        try { localStorage.setItem(BRAIN_KEY, JSON.stringify(v)); } catch (e) {}
        brainSync();
      });
    });
    document.querySelectorAll(".qc-key").forEach(function (i) {
      i.addEventListener("input", function () {
        var v = brainGet(); v.apiKey = i.value;
        try { localStorage.setItem(BRAIN_KEY, JSON.stringify(v)); } catch (e) {}
      });
    });
    brainSync();
  }

  /* ---------- shared AI context (brand / topic / who's speaking) ----------
   * One free-text note the editor types once; fed into every AI prompt
   * (Cleanup, Quick Clean, Highlights, Vox Pop, Zoom). Synced across all the
   * .qc-context boxes and persisted, so setting it in any tab sets it everywhere.
   */
  var CTX_KEY = "quietcut.aicontext.v1";
  function aiContext() {
    try { return localStorage.getItem(CTX_KEY) || ""; } catch (e) { return ""; }
  }
  function contextInit() {
    var boxes = document.querySelectorAll(".qc-context");
    boxes.forEach(function (t) {
      t.value = aiContext();
      t.addEventListener("input", function () {
        try { localStorage.setItem(CTX_KEY, t.value); } catch (e) {}
        boxes.forEach(function (o) { if (o !== t) { o.value = t.value; } });
      });
    });
  }

  /* ---------- manual claude.ai bridge ---------- */
  var CLAUDE_URL = "https://claude.ai/new";
  var manualEls = {
    overlay: document.getElementById("manualOverlay"),
    prompt: document.getElementById("mPrompt"),
    reply: document.getElementById("mReply"),
    copyBtn: document.getElementById("mCopyBtn"),
    openBtn: document.getElementById("mOpenBtn"),
    useBtn: document.getElementById("mUseBtn"),
    cancelBtn: document.getElementById("mCancelBtn"),
    status: document.getElementById("mStatus")
  };
  // Active session: { promptText, parse, resolve, reject }. parse(replyText) turns
  // the pasted reply into the caller's data — it runs INSIDE the overlay so a bad
  // paste keeps the overlay open (reply preserved) instead of losing everything.
  var manualState = null;
  // Last session remembered so reopening prefills the previous prompt + reply.
  var manualLast = { prompt: "", reply: "" };

  // Open a URL in the default browser: CEP-native first, Node fallback.
  function openExternal(url) {
    try { if (cs.openURLInDefaultBrowser(url)) { return true; } } catch (e) {}
    try {
      var cp = (typeof require === "function") ? require("child_process")
             : (typeof cep_node !== "undefined" && cep_node.require) ? cep_node.require("child_process") : null;
      if (cp) {
        var os = cs.getOSInformation();
        if (os.indexOf("Mac") >= 0) { cp.spawn("open", [url], { detached: true }).unref(); }
        else { cp.spawn("cmd", ["/c", "start", "", url], { detached: true }).unref(); }
        return true;
      }
    } catch (e2) {}
    return false;
  }

  // Copy the prompt textarea to the clipboard. Returns true on success.
  function copyPrompt() {
    manualEls.prompt.focus(); manualEls.prompt.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) {}
    try { window.getSelection().removeAllRanges(); } catch (e) {}
    return ok;
  }

  // Show the overlay with `promptText`. `parse(replyText)` converts the pasted
  // reply into the caller's data; the returned Promise resolves with THAT result
  // (not the raw text). If parse throws, the overlay stays open with the reply
  // intact so the editor can fix the JSON and click Use again — no re-transcribe.
  // `prefillReply` (optional) seeds the reply box, e.g. when reopening to tweak.
  function manualClaude(promptText, parse, prefillReply) {
    return new Promise(function (resolve, reject) {
      var seed = (prefillReply != null) ? prefillReply
               : (promptText === manualLast.prompt ? manualLast.reply : "");
      manualState = { promptText: promptText, parse: parse || null, resolve: resolve, reject: reject };
      manualEls.prompt.value = promptText;
      manualEls.reply.value = seed;
      manualEls.overlay.classList.remove("hidden");
      var copied = copyPrompt();
      manualEls.status.textContent = copied
        ? "Prompt copied. Click “Open claude.ai”, pick Opus, paste, then bring the reply back."
        : "Click “Copy again”, open claude.ai, pick Opus, paste, then bring the reply back.";
    });
  }
  function manualClose() { manualEls.overlay.classList.add("hidden"); }
  // Remember the current prompt + whatever's typed, so a reopen restores it.
  function manualRemember() {
    if (manualState) { manualLast = { prompt: manualState.promptText, reply: manualEls.reply.value }; }
  }
  // Reopen the overlay on a remembered manual session so the editor can tweak the
  // JSON and re-apply — no re-transcribe. `sess` = { prompt, reply }; `parse`
  // converts the (edited) reply. Resolves with the new parsed result.
  function manualEdit(sess, parse) {
    if (!sess || !sess.prompt) { return Promise.reject(new Error("Run a Claude (manual) scan first.")); }
    return manualClaude(sess.prompt, function (reply) {
      sess.reply = reply;
      return parse(reply);
    }, sess.reply || "");
  }

  manualEls.copyBtn.addEventListener("click", function () {
    manualEls.status.textContent = copyPrompt() ? "Copied — paste it into claude.ai." : "Select all and press Ctrl+C.";
  });
  manualEls.openBtn.addEventListener("click", function () {
    if (!copyPrompt()) { /* keep whatever's on the clipboard */ }
    manualEls.status.textContent = openExternal(CLAUDE_URL)
      ? "Opening claude.ai — paste the prompt (it's copied), pick Opus."
      : "Couldn't open a browser. Go to claude.ai manually and paste the prompt.";
  });
  manualEls.useBtn.addEventListener("click", function () {
    var st = manualState;
    var txt = manualEls.reply.value.trim();
    manualRemember();
    if (!txt) { manualEls.status.textContent = "Paste Claude's reply first."; return; }
    if (txt.indexOf("{") === -1) {
      manualEls.status.textContent = "That doesn't look complete — paste Claude's full reply (it should contain the JSON in { }).";
      return;
    }
    if (st && st.parse) {
      var parsed;
      try { parsed = st.parse(txt); }
      catch (e) {
        manualEls.status.textContent = "Couldn't read that reply: " + (e && e.message ? e.message : e) +
          " — fix the JSON above and click “Use this reply” again.";
        return; // stay open; reply is preserved for editing
      }
      manualClose(); manualState = null;
      st.resolve(parsed);
    } else {
      manualClose(); manualState = null;
      if (st) { st.resolve(txt); }
    }
  });
  manualEls.cancelBtn.addEventListener("click", function () {
    var st = manualState;
    manualRemember();
    manualClose(); manualState = null;
    if (st && st.reject) { st.reject(new Error("Cancelled.")); }
  });

  // Cross-platform paths: Node accepts forward slashes on both Windows and macOS,
  // so we normalise to "/" and only vary the ".exe" suffix (and a couple of binary
  // sub-paths) per OS. Mac binaries go in the same bin/ layout — see README.
  function isMac() {
    try { return cs.getOSInformation().indexOf("Mac") >= 0; } catch (e) { return false; }
  }
  function extRoot() {
    return cs.getSystemPath(SystemPath.EXTENSION).replace(/[\\/]+$/, "").replace(/\\/g, "/");
  }
  function binPath(rel) { return extRoot() + "/bin/" + rel; }
  // Is this an ARM machine (Apple Silicon / Windows on ARM)? Picks the right build.
  function isArm() {
    try {
      if (typeof process !== "undefined" && process.arch) { return /arm/i.test(process.arch); }
    } catch (e) {}
    return false;
  }
  // Engines live outside the extension folder so updating Naifu never costs
  // another multi-GB download; a repo bin/ (dev checkout) still wins if present.
  function userRoot() {
    var base = "";
    try { base = cs.getSystemPath(SystemPath.USER_DATA); } catch (e) {}
    return String(base || "").replace(/[\\/]+$/, "").replace(/\\/g, "/") + "/Naifu/engines";
  }
  QCEngines.configure({ extRoot: extRoot(), userRoot: userRoot(), isMac: isMac(), arm: isArm() });

  function ffmpegPath() { return QCEngines.pathFor("ffmpeg"); }
  function whisperPath() { return QCEngines.pathFor("whisper"); }
  function ollamaExe() { return QCEngines.pathFor("ollama"); }
  function ollamaModelsDir() { return QCEngines.modelsDir(); }
  var LLM_MODEL = "qwen2.5:7b";

  function bindDrawer(settingsEl, toggleEl) {
    toggleEl.addEventListener("click", function () { settingsEl.classList.toggle("open"); });
  }

  // Show which sequence operations will affect. Refreshed on load, after a
  // duplicate, after each apply, and whenever the user clicks the name.
  function refreshActiveName() {
    return host("qcActiveSequenceName()").then(function (res) {
      if (!res.ok) {
        els.activeSeq.textContent = "(no active sequence)";
        els.dupBtn.classList.remove("suggest");
        return res;
      }
      var name = res.name || "";
      var isCopy = /naifu|quietcut|vox pop|story/i.test(name);
      els.activeSeq.innerHTML = "";
      els.activeSeq.appendChild(document.createTextNode(name));
      if (isCopy) {
        var tag = document.createElement("span");
        tag.className = "tag"; tag.textContent = "✓ copy";
        els.activeSeq.appendChild(tag);
      }
      // On an original, make Duplicate stand out as the safe next move.
      els.dupBtn.classList.toggle("suggest", !isCopy);
      els.dupBtn.title = isCopy
        ? "Make another copy of this sequence"
        : "You're on an original — click for a non-destructive safety copy";
      return res;
    });
  }

  function duplicateSequence() {
    els.dupBtn.disabled = true;
    setStatus("Duplicating active sequence", "busy");
    host("qcDuplicateSequence()").then(function (res) {
      els.dupBtn.disabled = false;
      if (!res.ok) { setStatus(res.error, "err"); return; }
      setStatus("Duplicated. Now editing “" + res.name + "”.", "ok");
      return refreshActiveName();
    }).catch(function (err) {
      els.dupBtn.disabled = false;
      setStatus(err.message || String(err), "err");
    });
  }

  els.dupBtn.addEventListener("click", duplicateSequence);
  els.activeSeq.addEventListener("click", refreshActiveName);

  /* ---------- Inspect: capture the effects on a selected clip ---------- */
  var inspectEls = {
    btn: document.getElementById("inspectBtn"),
    overlay: document.getElementById("inspectOverlay"),
    dump: document.getElementById("iDump"),
    copyBtn: document.getElementById("iCopyBtn"),
    closeBtn: document.getElementById("iCloseBtn"),
    status: document.getElementById("iStatus")
  };
  inspectEls.btn.addEventListener("click", function () {
    setStatus("Reading the selected clip…", "busy");
    host("qcInspectSelection()").then(function (res) {
      if (!res.ok) { setStatus(res.error || "Couldn't read the clip.", "err"); return; }
      setStatus("");
      inspectEls.dump.value = JSON.stringify(res, null, 2);
      inspectEls.status.textContent = (res.effects && res.effects.length)
        ? (res.effects.length + " effect(s) on “" + res.clip + "”. Copy this and paste it to me.")
        : "No effects found on this clip — make sure you selected the camera-pull layer.";
      inspectEls.overlay.classList.remove("hidden");
    }).catch(function (err) { setStatus(err.message || String(err), "err"); });
  });
  inspectEls.copyBtn.addEventListener("click", function () {
    inspectEls.dump.focus(); inspectEls.dump.select();
    var ok = false; try { ok = document.execCommand("copy"); } catch (e) {}
    try { window.getSelection().removeAllRanges(); } catch (e) {}
    inspectEls.status.textContent = ok ? "Copied — paste it to me in chat." : "Select all (Ctrl+A) and copy.";
  });
  inspectEls.closeBtn.addEventListener("click", function () { inspectEls.overlay.classList.add("hidden"); });

  /* ===================================================================
   * TAB SWITCHING
   * =================================================================== */
  var tabs = document.querySelectorAll(".tab");
  var panels = {
    silence: document.getElementById("silencePanel"),
    zoom: document.getElementById("zoomPanel"),
    fillers: document.getElementById("fillersPanel"),
    highlights: document.getElementById("highlightsPanel"),
    cleanup: document.getElementById("cleanupPanel"),
    quick: document.getElementById("quickPanel"),
    voxpop: document.getElementById("voxpopPanel"),
    story: document.getElementById("storyPanel"),
    hook: document.getElementById("hookPanel"),
    setup: document.getElementById("setupPanel"),
    captions: document.getElementById("captionsPanel"),
    speaker: document.getElementById("speakerPanel")
  };
  // Activate a tab by its data-tab name (also used for the Quick Clean → Zoom handoff).
  function tabFor(name) {
    tabs.forEach(function (t) { t.classList.toggle("active", t.dataset.tab === name); });
    for (var k in panels) { panels[k].classList.toggle("active", k === name); }
    refreshActiveName();
  }
  tabs.forEach(function (tab) {
    tab.addEventListener("click", function () { tabFor(tab.dataset.tab); });
  });

  /* ===================================================================
   * SILENCE TAB
   * =================================================================== */
  var SIL_DEFAULTS = { thresholdDb: -30, minSilenceMs: 500, paddingMs: 100 };
  var SIL_KEY = "quietcut.settings.v1";
  var sil = { cuts: [], selected: [] };

  var s = {
    scanBtn: document.getElementById("scanBtn"),
    settings: document.getElementById("settings"),
    settingsToggle: document.getElementById("settingsToggle"),
    resetBtn: document.getElementById("resetBtn"),
    thr: document.getElementById("thrInput"),
    minSil: document.getElementById("minSilInput"),
    pad: document.getElementById("padInput"),
    reviewCard: document.getElementById("reviewCard"),
    summary: document.getElementById("summary"),
    selAll: document.getElementById("selAll"),
    cutList: document.getElementById("cutList"),
    cancelBtn: document.getElementById("cancelBtn"),
    applyBtn: document.getElementById("applyBtn")
  };

  function silLoadSettings() {
    var v = SIL_DEFAULTS;
    try { var st = localStorage.getItem(SIL_KEY); if (st) { v = JSON.parse(st); } } catch (e) {}
    s.thr.value = v.thresholdDb; s.minSil.value = v.minSilenceMs; s.pad.value = v.paddingMs;
  }
  function silSettings() {
    var v = {
      thresholdDb: parseFloat(s.thr.value),
      minSilenceMs: parseFloat(s.minSil.value),
      paddingMs: parseFloat(s.pad.value)
    };
    if (isNaN(v.thresholdDb)) { v.thresholdDb = SIL_DEFAULTS.thresholdDb; }
    if (isNaN(v.minSilenceMs)) { v.minSilenceMs = SIL_DEFAULTS.minSilenceMs; }
    if (isNaN(v.paddingMs)) { v.paddingMs = SIL_DEFAULTS.paddingMs; }
    try { localStorage.setItem(SIL_KEY, JSON.stringify(v)); } catch (e) {}
    return v;
  }

  function silRender() {
    s.cutList.innerHTML = "";
    var sel = 0, saved = 0;
    sil.cuts.forEach(function (cut, idx) {
      var row = document.createElement("div");
      row.className = "cut-row" + (sil.selected[idx] ? "" : " off");
      var cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = sil.selected[idx];
      cb.addEventListener("change", function () { sil.selected[idx] = cb.checked; silRender(); });
      var range = document.createElement("span");
      range.className = "range";
      range.style.cursor = "pointer";
      range.title = "Click to move the playhead here";
      range.textContent = fmtTime(cut.start) + "  →  " + fmtTime(cut.end);
      range.addEventListener("click", function () { jumpToTime(cut.start); });
      var dur = document.createElement("span");
      dur.className = "meta"; dur.textContent = "−" + cut.duration.toFixed(2) + "s";
      row.appendChild(cb); row.appendChild(range); row.appendChild(dur);
      s.cutList.appendChild(row);
      if (sil.selected[idx]) { sel++; saved += cut.duration; }
    });
    s.summary.textContent = sel + " of " + sil.cuts.length + " cuts · saves " + saved.toFixed(1) + "s";
    s.selAll.checked = sel === sil.cuts.length && sel > 0;
    s.applyBtn.disabled = sel === 0;
  }

  function silScan() {
    if (!QCAudio.nodeAvailable()) {
      setStatus("Node.js isn't enabled — restart Premiere after running setup.ps1.", "err");
      return;
    }
    s.scanBtn.disabled = true;
    s.reviewCard.classList.add("hidden");
    setStatus("Reading audio clips from the sequence", "busy");
    var cfg = silSettings();

    host("qcGetAudioClips()").then(function (res) {
      if (!res.ok) { throw new Error(res.error); }
      if (!res.clips || res.clips.length === 0) {
        throw new Error("No audio clips with media found on the sequence.");
      }
      setStatus("Analyzing " + res.clips.length + " clip(s) with FFmpeg", "busy");
      return QCAudio.detectSilences({
        ffmpegPath: ffmpegPath(), clips: res.clips,
        thresholdDb: cfg.thresholdDb, minSilenceMs: cfg.minSilenceMs, paddingMs: cfg.paddingMs
      });
    }).then(function (cuts) {
      sil.cuts = cuts;
      sil.selected = cuts.map(function () { return true; });
      s.scanBtn.disabled = false;
      if (cuts.length === 0) {
        setStatus("No silences found with these settings. Try a higher threshold.", "ok");
        return;
      }
      silRender();
      s.reviewCard.classList.remove("hidden");
      setStatus("Review the cuts below, then apply.", "ok");
    }).catch(function (err) {
      s.scanBtn.disabled = false;
      setStatus(err.message || String(err), "err");
    });
  }

  function silApply() {
    var chosen = sil.cuts.filter(function (_, i) { return sil.selected[i]; });
    if (chosen.length === 0) { return; }
    s.applyBtn.disabled = true; s.cancelBtn.disabled = true;
    setStatus("Cutting " + chosen.length + " silence(s)", "busy");

    // Applies in place to the active sequence (use Duplicate first for a copy).
    host('qcApplySilenceCuts("' + QCAudio.rangesToString(chosen) + '")').then(function (res) {
      s.cancelBtn.disabled = false;
      if (!res.ok) { throw new Error(res.error); }
      s.reviewCard.classList.add("hidden");
      setStatus("Done — removed " + res.cuts + " silence(s)." + skipNote(res), res.skipped ? "err" : "ok");
      refreshActiveName();
    }).catch(function (err) {
      s.applyBtn.disabled = false; s.cancelBtn.disabled = false;
      setStatus(err.message || String(err), "err");
    });
  }

  s.scanBtn.addEventListener("click", silScan);
  s.applyBtn.addEventListener("click", silApply);
  s.cancelBtn.addEventListener("click", function () {
    s.reviewCard.classList.add("hidden");
    setStatus("Cancelled. Nothing was changed.");
  });
  bindDrawer(s.settings, s.settingsToggle);
  s.resetBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    s.thr.value = SIL_DEFAULTS.thresholdDb;
    s.minSil.value = SIL_DEFAULTS.minSilenceMs;
    s.pad.value = SIL_DEFAULTS.paddingMs;
    silSettings();
  });
  s.selAll.addEventListener("change", function () {
    var on = s.selAll.checked;
    sil.selected = sil.cuts.map(function () { return on; });
    silRender();
  });

  /* ===================================================================
   * ZOOM TAB — detect emphatic moments, lay adjustment-layer punch-ins
   * =================================================================== */
  var ZOOM_DEFAULTS = { detect: "loudness", amount: 108, maxLen: 10, sensitivity: "med", style: "static", easing: "smooth", ramp: 0.5, holdUntilPause: true };
  var ZOOM_KEY = "quietcut.zoom.v5";
  var zoom = { moments: [], selected: [] }; // moments: [{start,end,peakDb}]

  var z = {
    scanBtn: document.getElementById("zScanBtn"),
    settings: document.getElementById("zSettings"),
    settingsToggle: document.getElementById("zSettingsToggle"),
    resetBtn: document.getElementById("zResetBtn"),
    detect: document.getElementById("zDetect"),
    amount: document.getElementById("zAmount"),
    amountVal: document.getElementById("zAmountVal"),
    duration: document.getElementById("zDuration"),
    durationVal: document.getElementById("zDurationVal"),
    sensitivity: document.getElementById("zSensitivity"),
    holdPause: document.getElementById("zHoldPause"),
    style: document.getElementById("zStyle"),
    easing: document.getElementById("zEasing"),
    easingField: document.getElementById("zEasingField"),
    ramp: document.getElementById("zRamp"),
    rampVal: document.getElementById("zRampVal"),
    rampField: document.getElementById("zRampField"),
    reviewCard: document.getElementById("zReviewCard"),
    summary: document.getElementById("zSummary"),
    selAll: document.getElementById("zSelAll"),
    list: document.getElementById("zList"),
    cancelBtn: document.getElementById("zCancelBtn"),
    applyBtn: document.getElementById("zApplyBtn"),
    markerBtn: document.getElementById("zMarkerBtn"),
    clearBtn: document.getElementById("zClearBtn")
  };

  function zoomSyncLabels() {
    z.amountVal.textContent = z.amount.value + "%";
    z.durationVal.textContent = parseFloat(z.duration.value).toFixed(0) + "s";
    z.rampVal.textContent = parseFloat(z.ramp.value).toFixed(1) + "s";
  }

  // Ramp easing + speed only matter for the Ramp style.
  function zoomStyleVisibility() {
    var isRamp = z.style.value === "ramp";
    z.easingField.classList.toggle("hidden", !isRamp);
    z.rampField.classList.toggle("hidden", !isRamp);
  }

  function zoomLoadSettings() {
    var v = ZOOM_DEFAULTS;
    try { var st = localStorage.getItem(ZOOM_KEY); if (st) { v = JSON.parse(st); } } catch (e) {}
    z.detect.value = v.detect || "loudness";
    z.amount.value = v.amount; z.duration.value = v.maxLen;
    z.sensitivity.value = v.sensitivity; z.style.value = v.style;
    z.easing.value = v.easing; z.ramp.value = v.ramp;
    z.holdPause.checked = (v.holdUntilPause !== false); // default on
    zoomSyncLabels(); zoomStyleVisibility();
  }
  function zoomSettings() {
    var v = {
      detect: z.detect.value,
      amount: parseFloat(z.amount.value),
      maxLen: parseFloat(z.duration.value),
      sensitivity: z.sensitivity.value,
      holdUntilPause: z.holdPause.checked,
      style: z.style.value,
      easing: z.easing.value,
      ramp: parseFloat(z.ramp.value)
    };
    if (isNaN(v.amount)) { v.amount = ZOOM_DEFAULTS.amount; }
    if (isNaN(v.maxLen)) { v.maxLen = ZOOM_DEFAULTS.maxLen; }
    if (isNaN(v.ramp)) { v.ramp = ZOOM_DEFAULTS.ramp; }
    try { localStorage.setItem(ZOOM_KEY, JSON.stringify(v)); } catch (e) {}
    return v;
  }

  function zoomRender() {
    z.list.innerHTML = "";
    var on = 0;
    zoom.moments.forEach(function (m, idx) {
      var row = document.createElement("div");
      row.className = "cut-row" + (zoom.selected[idx] ? "" : " off");
      var cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = zoom.selected[idx];
      cb.addEventListener("change", function () { zoom.selected[idx] = cb.checked; zoomRender(); });

      // Middle column: the time range, with the first spoken words underneath so
      // you can see what the punch-in is zooming into. Click anywhere to preview.
      var mid = document.createElement("div");
      mid.style.cursor = "pointer";
      mid.title = "Click to move the playhead here";
      mid.addEventListener("click", function () { jumpToTime(m.start); });
      var range = document.createElement("span");
      range.className = "range";
      range.textContent = fmtTime(m.start) + "  →  " + fmtTime(m.end);
      mid.appendChild(range);
      if (m.words) {
        var q = document.createElement("div");
        q.className = "qline";
        q.textContent = "“" + m.words + "”";
        mid.appendChild(q);
      }

      var meta = document.createElement("span");
      meta.className = "meta";
      var tag = (typeof m.peakDb === "number") ? (Math.round(m.peakDb) + "dB") : "AI";
      meta.textContent = (m.end - m.start).toFixed(1) + "s · " + tag;

      row.appendChild(cb); row.appendChild(mid); row.appendChild(meta);
      z.list.appendChild(row);
      if (zoom.selected[idx]) { on++; }
    });
    z.summary.textContent = on + " of " + zoom.moments.length + " moments";
    z.selAll.checked = on === zoom.moments.length && on > 0;
    z.applyBtn.disabled = on === 0;
  }

  function zoomScan() {
    if (!QCAudio.nodeAvailable()) {
      setStatus("Node.js isn't enabled — restart Premiere after running setup.ps1.", "err");
      return;
    }
    z.scanBtn.disabled = true;
    z.reviewCard.classList.add("hidden");
    var cfg = zoomSettings();
    setStatus("Reading audio from the sequence", "busy");

    host("qcGetAudioClips()").then(function (res) {
      if (!res.ok) { throw new Error(res.error); }
      if (!res.clips || res.clips.length === 0) { throw new Error("No audio clips with media on the sequence."); }

      if (cfg.detect === "ai") {
        // Content-based: transcribe, then ask the local AI for the key moments.
        setStatus("Transcribing the interview…", "busy");
        return QCAudio.transcribeSegments({
          whisperPath: whisperPath(), ffmpegPath: ffmpegPath(), clips: res.clips, model: "small.en"
        }).then(function (segs) {
          if (!segs || segs.length === 0) { throw new Error("No speech found to analyze."); }
          var bz = brainGet();
          var count = cfg.sensitivity === "high" ? 10 : (cfg.sensitivity === "low" ? 4 : 6);
          if (bz.brain === "manual") {
            setStatus("Copy the prompt into claude.ai, then paste the reply.", "busy");
            var zprompt = QCAi.buildHighlightPrompt(segs, count, aiContext());
            return manualClaude(zprompt, function (reply) {
              return QCAi.parseHighlights(reply, segs);
            });
          }
          setStatus(bz.brain === "claude-api" ? "Asking Claude where to punch in…" : "Asking the local AI where to punch in…", "busy");
          return QCAi.findHighlights({
            brain: bz.brain, apiKey: bz.apiKey,
            ollamaExe: ollamaExe(), modelsDir: ollamaModelsDir(), model: LLM_MODEL,
            segments: segs, count: count, context: aiContext()
          });
        }).then(function (highlights) {
          // Turn each highlight into a zoom moment. The highlight's own end is a
          // natural (sentence) boundary, so in "hold until pause" mode let it run
          // a little past Max length to finish; otherwise cap hard at Max length.
          var headroom = cfg.holdUntilPause ? Math.max(6, cfg.maxLen * 0.5) : 0;
          return highlights.map(function (hh) {
            var start = hh.start;
            var end = Math.min(hh.end, start + cfg.maxLen + headroom);
            if (end - start < 1) { end = Math.min(hh.end, start + 2); }
            return {
              start: start, end: end, peakDb: null,
              reason: hh.reason || "", quote: hh.quote || "",
              words: firstWords(hh.quote || hh.reason, 8)
            };
          });
        });
      }

      // Loudness-based (acoustic emphasis). Transcribe first so each zoom can
      // release at the END of the sentence it's on (clean, no mid-sentence snap).
      // Best-effort: if Whisper isn't available, fall back to loudness pauses.
      setStatus("Transcribing for clean cut points…", "busy");
      return QCAudio.transcribeSegments({
        whisperPath: whisperPath(), ffmpegPath: ffmpegPath(),
        clips: res.clips, model: "small.en", onProgress: transcribeProgress("Transcribing")
      }).catch(function () { return []; }).then(function (segs) {
        setStatus("Finding emphatic moments", "busy");
        return QCAudio.detectSentenceZooms({
          ffmpegPath: ffmpegPath(), clips: res.clips,
          maxSec: cfg.maxLen, sensitivity: cfg.sensitivity,
          holdUntilPause: cfg.holdUntilPause, segments: segs
        }).then(function (moments) {
          // Label each moment with the first few words spoken there, so the
          // review list shows what we're zooming into (not just a timestamp).
          (moments || []).forEach(function (m) {
            if (!m.words) { m.words = firstWordsFromSegments(segs, m.start, m.end, 8); }
          });
          return moments;
        });
      });
    }).then(function (moments) {
      zoom.moments = moments;
      zoom.selected = moments.map(function () { return true; });
      z.scanBtn.disabled = false;
      if (moments.length === 0) {
        setStatus("No clear emphasis found. Try 'Many' moments or a longer take.", "ok");
        return;
      }
      zoomRender();
      z.reviewCard.classList.remove("hidden");
      setStatus("Review the punch-ins below (each shows the words it zooms into), then apply.", "ok");
    }).catch(function (err) {
      z.scanBtn.disabled = false;
      setStatus(err.message || String(err), "err");
    });
  }

  function zoomApply() {
    var cfg = zoomSettings();
    var chosen = zoom.moments.filter(function (_, i) { return zoom.selected[i]; });
    if (chosen.length === 0) { return; }
    z.applyBtn.disabled = true; z.cancelBtn.disabled = true;
    setStatus("Applying " + chosen.length + " punch-in(s)", "busy");

    var easeCode = cfg.easing === "linear" ? 0 : 1;
    // Back-to-back moments merge into one held, escalating layer with a single
    // release (no pop-out between adjacent zooms); spaced moments stay separate.
    var spec = QCAudio.buildZoomRuns(chosen, {
      amount: cfg.amount, style: cfg.style, rampSec: cfg.ramp, easeCode: easeCode
    });

    // Adjustment-layer zooms on the active sequence (Duplicate first for a copy).
    host('qcApplyZoomRuns("' + spec + '")').then(function (res) {
      z.cancelBtn.disabled = false;
      if (!res.ok) {
        if (res.needAL) {
          setStatus(res.error, "err");
        } else {
          throw new Error(res.error);
        }
        z.applyBtn.disabled = false;
        return;
      }
      z.reviewCard.classList.add("hidden");
      var msg = "Done — added " + res.applied + " punch-in(s) on V" + (res.track + 1) + ".";
      if (res.failed > 0) { msg += " (" + res.failed + " failed.)"; }
      setStatus(msg, "ok");
    }).catch(function (err) {
      z.applyBtn.disabled = false; z.cancelBtn.disabled = false;
      setStatus(err.message || String(err), "err");
    });
  }

  // Instead of auto-zooming, drop a timeline marker at each ticked moment so the
  // editor can navigate to it and add a manual zoom by hand. Non-destructive.
  function zoomMarkers() {
    var chosen = zoom.moments.filter(function (_, i) { return zoom.selected[i]; });
    if (chosen.length === 0) { setStatus("Tick at least one moment to mark.", "err"); return; }
    z.markerBtn.disabled = true;
    setStatus("Dropping " + chosen.length + " marker(s)", "busy");

    var spec = chosen.map(function (m) {
      var tag = (typeof m.peakDb === "number") ? (Math.round(m.peakDb) + "dB") : "AI";
      var why = (m.reason || m.quote || "").replace(/[;|\r\n]+/g, " ").trim();
      var note = (why ? why + " - " : "") + (m.end - m.start).toFixed(1) + "s - " + tag;
      note = note.replace(/[;|]/g, " ").slice(0, 90);
      return Number(m.start).toFixed(3) + "|" + note;
    }).join(";");

    host('qcAddZoomMarkers("' + jsxEscape(spec) + '",3)').then(function (res) {
      z.markerBtn.disabled = false;
      if (!res.ok) { setStatus(res.error || "Could not add markers.", "err"); return; }
      setStatus("Added " + res.count + " marker(s) at the punch-in points. Jump between them in the " +
        "Markers panel (or the timeline ruler) and add a zoom by hand where you want one.", "ok");
    }).catch(function (err) {
      z.markerBtn.disabled = false;
      setStatus(err.message || String(err), "err");
    });
  }

  function zoomClear() {
    z.clearBtn.disabled = true;
    setStatus("Removing zoom layers", "busy");
    host("qcClearZooms()").then(function (res) {
      z.clearBtn.disabled = false;
      if (!res.ok) { setStatus(res.error, "err"); return; }
      setStatus("Removed " + res.removed + " zoom layer(s).", "ok");
    }).catch(function (err) {
      z.clearBtn.disabled = false;
      setStatus(err.message || String(err), "err");
    });
  }

  z.scanBtn.addEventListener("click", zoomScan);
  z.applyBtn.addEventListener("click", zoomApply);
  z.markerBtn.addEventListener("click", zoomMarkers);
  z.clearBtn.addEventListener("click", zoomClear);
  z.cancelBtn.addEventListener("click", function () {
    z.reviewCard.classList.add("hidden");
    setStatus("Cancelled. Nothing was changed.");
  });
  z.amount.addEventListener("input", function () { zoomSyncLabels(); zoomSettings(); });
  z.duration.addEventListener("input", function () { zoomSyncLabels(); zoomSettings(); });
  z.ramp.addEventListener("input", function () { zoomSyncLabels(); zoomSettings(); });
  z.detect.addEventListener("change", zoomSettings);
  z.sensitivity.addEventListener("change", zoomSettings);
  z.holdPause.addEventListener("change", zoomSettings);
  z.easing.addEventListener("change", zoomSettings);
  z.style.addEventListener("change", function () { zoomStyleVisibility(); zoomSettings(); });
  bindDrawer(z.settings, z.settingsToggle);
  z.resetBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    z.detect.value = ZOOM_DEFAULTS.detect;
    z.amount.value = ZOOM_DEFAULTS.amount; z.duration.value = ZOOM_DEFAULTS.maxLen;
    z.sensitivity.value = ZOOM_DEFAULTS.sensitivity; z.style.value = ZOOM_DEFAULTS.style;
    z.easing.value = ZOOM_DEFAULTS.easing; z.ramp.value = ZOOM_DEFAULTS.ramp;
    z.holdPause.checked = ZOOM_DEFAULTS.holdUntilPause;
    zoomSyncLabels(); zoomStyleVisibility(); zoomSettings();
  });
  z.selAll.addEventListener("change", function () {
    var on = z.selAll.checked;
    zoom.selected = zoom.moments.map(function () { return on; });
    zoomRender();
  });

  /* ---------- Camera Pull (intro move) — captured from the user's own layer ---------- */
  var CP_KEY = "quietcut.camerapull.v1";
  var CP_DEFAULTS = { peak: 131, settle: 100, pull: 2.2, len: 5, ease: 4 };
  var cp = {
    toggle: document.getElementById("cpToggle"),
    body: document.getElementById("cpBody"),
    peak: document.getElementById("cpPeak"),
    peakVal: document.getElementById("cpPeakVal"),
    settle: document.getElementById("cpSettle"),
    settleVal: document.getElementById("cpSettleVal"),
    pull: document.getElementById("cpPull"),
    pullVal: document.getElementById("cpPullVal"),
    len: document.getElementById("cpLen"),
    lenVal: document.getElementById("cpLenVal"),
    ease: document.getElementById("cpEase"),
    applyBtn: document.getElementById("cpApplyBtn")
  };
  function cpFmtS(v) { return (parseFloat(v).toFixed(1).replace(/\.0$/, "")) + "s"; }
  function cpSyncLabels() {
    cp.peakVal.textContent = cp.peak.value + "%";
    cp.settleVal.textContent = cp.settle.value + "%";
    cp.pullVal.textContent = cpFmtS(cp.pull.value);
    cp.lenVal.textContent = cpFmtS(cp.len.value);
  }
  function cpLoad() {
    var v = CP_DEFAULTS;
    try { var st = localStorage.getItem(CP_KEY); if (st) { v = JSON.parse(st); } } catch (e) {}
    cp.peak.value = v.peak; cp.settle.value = v.settle; cp.pull.value = v.pull; cp.len.value = v.len;
    cp.ease.value = (v.ease != null) ? v.ease : CP_DEFAULTS.ease;
    cpSyncLabels();
  }
  function cpSave() {
    try {
      localStorage.setItem(CP_KEY, JSON.stringify({
        peak: parseFloat(cp.peak.value), settle: parseFloat(cp.settle.value),
        pull: parseFloat(cp.pull.value), len: parseFloat(cp.len.value), ease: cp.ease.value
      }));
    } catch (e) {}
  }
  cp.toggle.addEventListener("click", function () {
    var open = cp.body.style.display !== "none";
    cp.body.style.display = open ? "none" : "block";
    var chev = cp.toggle.querySelector(".chev");
    if (chev) { chev.style.transform = open ? "" : "rotate(90deg)"; }
  });
  [cp.peak, cp.settle, cp.pull, cp.len].forEach(function (el) {
    el.addEventListener("input", function () { cpSyncLabels(); cpSave(); });
  });
  cp.ease.addEventListener("change", cpSave);
  function cpApply() {
    var peak = parseFloat(cp.peak.value), settle = parseFloat(cp.settle.value);
    var pull = parseFloat(cp.pull.value), len = parseFloat(cp.len.value);
    var ease = parseInt(cp.ease.value, 10);
    cp.applyBtn.disabled = true;
    setStatus("Adding camera pull at the start…", "busy");
    host("qcApplyCameraPull(" + peak + "," + settle + "," + pull + "," + len + "," + ease + ")").then(function (res) {
      cp.applyBtn.disabled = false;
      if (!res.ok) { setStatus(res.error || "Could not add the camera pull.", "err"); return; }
      setStatus("Camera pull added on V" + (res.track + 1) + ". Play from the start to see it.", "ok");
    }).catch(function (err) {
      cp.applyBtn.disabled = false;
      setStatus(err.message || String(err), "err");
    });
  }
  cp.applyBtn.addEventListener("click", cpApply);

  /* ===================================================================
   * FILLERS TAB — transcribe, flag fillers + repetitions, cut via the
   * same razor/ripple-delete engine as silence removal.
   * =================================================================== */
  var FILLER_DEFAULTS = {
    doFillers: true,
    doRepeats: true,
    keepTight: true,
    quality: "small.en",
    list: "um\nuh\nerm\ner\nah\nlike\nyou know\ni mean\nso\nbasically\nactually\nliterally\nright"
  };
  var FILLER_KEY = "quietcut.fillers.v1";
  var fil = { hits: [], selected: [] };

  var fl = {
    scanBtn: document.getElementById("fScanBtn"),
    settings: document.getElementById("fSettings"),
    settingsToggle: document.getElementById("fSettingsToggle"),
    resetBtn: document.getElementById("fResetBtn"),
    doFillers: document.getElementById("fDoFillers"),
    doRepeats: document.getElementById("fDoRepeats"),
    keepTight: document.getElementById("fKeepTight"),
    quality: document.getElementById("fQuality"),
    list: document.getElementById("fList"),
    reviewCard: document.getElementById("fReviewCard"),
    summary: document.getElementById("fSummary"),
    selAll: document.getElementById("fSelAll"),
    list2: document.getElementById("fList2"),
    cancelBtn: document.getElementById("fCancelBtn"),
    applyBtn: document.getElementById("fApplyBtn")
  };

  function filLoadSettings() {
    var v = FILLER_DEFAULTS;
    try { var st = localStorage.getItem(FILLER_KEY); if (st) { v = JSON.parse(st); } } catch (e) {}
    fl.doFillers.checked = v.doFillers; fl.doRepeats.checked = v.doRepeats;
    fl.keepTight.checked = (v.keepTight !== false);
    fl.quality.value = v.quality; fl.list.value = v.list;
  }
  function filSettings() {
    var v = {
      doFillers: fl.doFillers.checked,
      doRepeats: fl.doRepeats.checked,
      keepTight: fl.keepTight.checked,
      quality: fl.quality.value,
      list: fl.list.value
    };
    try { localStorage.setItem(FILLER_KEY, JSON.stringify(v)); } catch (e) {}
    return v;
  }
  function parseFillerList(text) {
    return text.split(/[\n,]+/).map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
  }

  function filRender() {
    fl.list2.innerHTML = "";
    var on = 0, saved = 0;
    fil.hits.forEach(function (h, idx) {
      var row = document.createElement("div");
      row.className = "cut-row" + (fil.selected[idx] ? "" : " off");
      var cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = fil.selected[idx];
      cb.addEventListener("change", function () { fil.selected[idx] = cb.checked; filRender(); });

      var main = document.createElement("span");
      main.className = "range hitline";
      main.title = "Click to move the playhead here";
      if (h.before) {
        var b = document.createElement("span");
        b.className = "ctx"; b.textContent = h.before + " ";
        main.appendChild(b);
      }
      var hit = document.createElement("span");
      hit.className = "hit"; hit.textContent = "“" + h.label + "”";
      main.appendChild(hit);
      var badge = document.createElement("span");
      badge.className = "badge " + h.type;
      badge.textContent = h.type === "repeat" ? " repeat" : " filler";
      main.appendChild(badge);
      if (h.after) {
        var a = document.createElement("span");
        a.className = "ctx"; a.textContent = " " + h.after;
        main.appendChild(a);
      }
      main.addEventListener("click", function () { jumpToTime(h.start); });

      var meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = fmtTime(h.start) + (h.tight ? " · tight" : "");

      row.appendChild(cb); row.appendChild(main); row.appendChild(meta);
      fl.list2.appendChild(row);
      if (fil.selected[idx]) { on++; saved += (h.end - h.start); }
    });
    fl.summary.textContent = on + " of " + fil.hits.length + " cuts · saves " + saved.toFixed(1) + "s";
    fl.selAll.checked = on === fil.hits.length && on > 0;
    fl.applyBtn.disabled = on === 0;
  }

  function filScan() {
    if (!QCAudio.nodeAvailable()) {
      setStatus("Node.js isn't enabled — restart Premiere after running setup.ps1.", "err");
      return;
    }
    var cfg = filSettings();
    if (!cfg.doFillers && !cfg.doRepeats) {
      setStatus("Turn on fillers and/or repetitions first.", "err");
      return;
    }
    fl.scanBtn.disabled = true;
    fl.reviewCard.classList.add("hidden");
    setStatus("Reading audio clips", "busy");

    host("qcGetAudioClips()").then(function (res) {
      if (!res.ok) { throw new Error(res.error); }
      if (!res.clips || res.clips.length === 0) { throw new Error("No audio clips with media on the sequence."); }
      setStatus("Transcribing with Whisper (first run downloads the model)…", "busy");
      return QCAudio.transcribe({
        whisperPath: whisperPath(), ffmpegPath: ffmpegPath(),
        clips: res.clips, model: cfg.quality
      });
    }).then(function (words) {
      if (!words || words.length === 0) {
        throw new Error("No speech detected (or transcription produced no words).");
      }
      var hits = [];
      if (cfg.doFillers) { hits = hits.concat(QCAudio.detectFillers(words, parseFillerList(cfg.list))); }
      if (cfg.doRepeats) { hits = hits.concat(QCAudio.detectRepetitions(words)); }
      // Sort by time and drop exact-overlap duplicates (a word flagged twice).
      hits.sort(function (a, b) { return a.start - b.start; });
      var deduped = [];
      hits.forEach(function (h) {
        var last = deduped[deduped.length - 1];
        if (last && h.start < last.end - 0.001) { return; } // overlaps previous cut
        deduped.push(h);
      });

      fil.hits = deduped;
      // Pre-untick "tight" fillers (cutting them would sound rushed) when the
      // "keep tight fillers" option is on. Repetitions are always selected.
      fil.selected = deduped.map(function (h) {
        return !(cfg.keepTight && h.type === "filler" && h.tight);
      });
      fl.scanBtn.disabled = false;
      if (deduped.length === 0) {
        setStatus("Transcribed OK — no fillers or repetitions found.", "ok");
        return;
      }
      filRender();
      fl.reviewCard.classList.remove("hidden");
      setStatus("Review the words to cut, then apply.", "ok");
    }).catch(function (err) {
      fl.scanBtn.disabled = false;
      setStatus(err.message || String(err), "err");
    });
  }

  function filApply() {
    var chosen = fil.hits.filter(function (_, i) { return fil.selected[i]; });
    if (chosen.length === 0) { return; }
    fl.applyBtn.disabled = true; fl.cancelBtn.disabled = true;
    setStatus("Cutting " + chosen.length + " word(s)", "busy");

    var ranges = chosen.map(function (h) { return { start: h.start, end: h.end }; });
    host('qcApplySilenceCuts("' + QCAudio.rangesToString(ranges) + '")').then(function (res) {
      fl.cancelBtn.disabled = false;
      if (!res.ok) { throw new Error(res.error); }
      fl.reviewCard.classList.add("hidden");
      setStatus("Done — cut " + res.cuts + " word(s)." + skipNote(res), res.skipped ? "err" : "ok");
      refreshActiveName();
    }).catch(function (err) {
      fl.applyBtn.disabled = false; fl.cancelBtn.disabled = false;
      setStatus(err.message || String(err), "err");
    });
  }

  fl.scanBtn.addEventListener("click", filScan);
  fl.applyBtn.addEventListener("click", filApply);
  fl.cancelBtn.addEventListener("click", function () {
    fl.reviewCard.classList.add("hidden");
    setStatus("Cancelled. Nothing was changed.");
  });
  fl.doFillers.addEventListener("change", filSettings);
  fl.doRepeats.addEventListener("change", filSettings);
  fl.keepTight.addEventListener("change", filSettings);
  fl.quality.addEventListener("change", filSettings);
  fl.list.addEventListener("change", filSettings);
  bindDrawer(fl.settings, fl.settingsToggle);
  fl.resetBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    fl.doFillers.checked = FILLER_DEFAULTS.doFillers;
    fl.doRepeats.checked = FILLER_DEFAULTS.doRepeats;
    fl.keepTight.checked = FILLER_DEFAULTS.keepTight;
    fl.quality.value = FILLER_DEFAULTS.quality;
    fl.list.value = FILLER_DEFAULTS.list;
    filSettings();
  });
  fl.selAll.addEventListener("change", function () {
    var on = fl.selAll.checked;
    fil.selected = fil.hits.map(function () { return on; });
    filRender();
  });

  /* ===================================================================
   * HIGHLIGHTS TAB — transcribe, ask the local AI for the best moments.
   * =================================================================== */
  var HL_DEFAULTS = { count: 5, quality: "small.en" };
  var HL_KEY = "quietcut.highlights.v1";
  var hi = { items: [] };

  var h = {
    scanBtn: document.getElementById("hScanBtn"),
    settings: document.getElementById("hSettings"),
    settingsToggle: document.getElementById("hSettingsToggle"),
    resetBtn: document.getElementById("hResetBtn"),
    count: document.getElementById("hCount"),
    countVal: document.getElementById("hCountVal"),
    quality: document.getElementById("hQuality"),
    reviewCard: document.getElementById("hReviewCard"),
    summary: document.getElementById("hSummary"),
    list: document.getElementById("hList"),
    closeBtn: document.getElementById("hCloseBtn"),
    editBtn: document.getElementById("hEditBtn")
  };

  function hlSyncLabels() { h.countVal.textContent = h.count.value; }
  function hlLoadSettings() {
    var v = HL_DEFAULTS;
    try { var st = localStorage.getItem(HL_KEY); if (st) { v = JSON.parse(st); } } catch (e) {}
    h.count.value = v.count; h.quality.value = v.quality;
    hlSyncLabels();
  }
  function hlSettings() {
    var v = { count: parseInt(h.count.value, 10), quality: h.quality.value };
    if (isNaN(v.count)) { v.count = HL_DEFAULTS.count; }
    try { localStorage.setItem(HL_KEY, JSON.stringify(v)); } catch (e) {}
    return v;
  }

  function hlRender() {
    h.list.innerHTML = "";
    hi.items.forEach(function (it, idx) {
      var row = document.createElement("div");
      row.className = "cut-row";
      row.style.gridTemplateColumns = "1fr auto";
      row.style.cursor = "pointer";
      row.title = "Click to move the playhead here";

      var main = document.createElement("span");
      main.className = "range";
      var num = document.createElement("span");
      num.className = "hit"; num.textContent = (idx + 1) + ". ";
      var quote = document.createElement("span");
      quote.textContent = "“" + it.quote + "”";
      main.appendChild(num); main.appendChild(quote);
      if (it.reason) {
        var why = document.createElement("div");
        why.className = "ctx"; why.style.marginTop = "3px"; why.textContent = it.reason;
        main.appendChild(why);
      }

      var meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = fmtTime(it.start);

      row.appendChild(main); row.appendChild(meta);
      row.addEventListener("click", function () { jumpToTime(it.start); });
      h.list.appendChild(row);
    });
    h.summary.textContent = hi.items.length + " highlight(s) — click to preview";
    if (h.editBtn) { h.editBtn.classList.toggle("hidden", !hi.manual); }
  }

  function hlScan() {
    if (!QCAudio.nodeAvailable() || !QCAi.nodeAvailable()) {
      setStatus("Node.js isn't enabled — restart Premiere after running setup.ps1.", "err");
      return;
    }
    var cfg = hlSettings();
    h.scanBtn.disabled = true;
    h.reviewCard.classList.add("hidden");
    setStatus("Reading audio clips", "busy");

    host("qcGetAudioClips()").then(function (res) {
      if (!res.ok) { throw new Error(res.error); }
      if (!res.clips || res.clips.length === 0) { throw new Error("No audio clips with media on the sequence."); }
      setStatus("Transcribing the interview…", "busy");
      return QCAudio.transcribeSegments({
        whisperPath: whisperPath(), ffmpegPath: ffmpegPath(),
        clips: res.clips, model: cfg.quality,
        onProgress: transcribeProgress("Transcribing")
      });
    }).then(function (segments) {
      if (!segments || segments.length === 0) { throw new Error("No speech found to analyze."); }
      var b = brainGet();
      hi.manual = null;
      if (b.brain === "manual") {
        setStatus("Copy the prompt into claude.ai, then paste the reply.", "busy");
        var prompt = QCAi.buildHighlightPrompt(segments, cfg.count, aiContext());
        hi.manual = { prompt: prompt, segments: segments, reply: "" };
        return manualClaude(prompt, function (reply) {
          hi.manual.reply = reply;
          return QCAi.parseHighlights(reply, segments);
        });
      }
      setStatus(b.brain === "claude-api" ? "Asking Claude for the best parts…" : "Asking the local AI for the best parts… (first run loads the model)", "busy");
      return QCAi.findHighlights({
        brain: b.brain, apiKey: b.apiKey,
        ollamaExe: ollamaExe(), modelsDir: ollamaModelsDir(), model: LLM_MODEL,
        segments: segments, count: cfg.count, context: aiContext()
      });
    }).then(function (items) {
      hi.items = items || [];
      h.scanBtn.disabled = false;
      if (hi.items.length === 0) {
        setStatus("The AI didn't return clear highlights — try a higher transcription accuracy.", "ok");
        return;
      }
      hlRender();
      h.reviewCard.classList.remove("hidden");
      setStatus("Found " + hi.items.length + " highlight(s). Click any to preview.", "ok");
    }).catch(function (err) {
      h.scanBtn.disabled = false;
      setStatus(err.message || String(err), "err");
    });
  }

  h.scanBtn.addEventListener("click", hlScan);
  h.closeBtn.addEventListener("click", function () { h.reviewCard.classList.add("hidden"); });
  h.editBtn.addEventListener("click", function () {
    manualEdit(hi.manual, function (reply) { return QCAi.parseHighlights(reply, hi.manual.segments); })
      .then(function (items) {
        hi.items = items || [];
        if (hi.items.length === 0) { setStatus("That reply has no highlights — edit it again.", "ok"); return; }
        hlRender();
        h.reviewCard.classList.remove("hidden");
        setStatus("Updated from your edited reply.", "ok");
      }).catch(function (err) { setStatus(err.message || String(err), "err"); });
  });
  h.count.addEventListener("input", function () { hlSyncLabels(); hlSettings(); });
  h.quality.addEventListener("change", hlSettings);
  bindDrawer(h.settings, h.settingsToggle);
  h.resetBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    h.count.value = HL_DEFAULTS.count; h.quality.value = HL_DEFAULTS.quality;
    hlSyncLabels(); hlSettings();
  });

  /* ===================================================================
   * CLEANUP TAB — transcribe, ask the AI what to cut, review + apply.
   * =================================================================== */
  var CL_KEY = "quietcut.cleanup.v1";
  var cl = { cuts: [], selected: [] };
  var clEls = {
    scanBtn: document.getElementById("clScanBtn"),
    settings: document.getElementById("clSettings"),
    settingsToggle: document.getElementById("clSettingsToggle"),
    quality: document.getElementById("clQuality"),
    aggro: document.getElementById("clAggro"),
    reviewCard: document.getElementById("clReviewCard"),
    summary: document.getElementById("clSummary"),
    selAll: document.getElementById("clSelAll"),
    list: document.getElementById("clList"),
    applyBtn: document.getElementById("clApplyBtn"),
    cancelBtn: document.getElementById("clCancelBtn"),
    editBtn: document.getElementById("clEditBtn")
  };

  function clLoadSettings() {
    var v = {};
    try { v = JSON.parse(localStorage.getItem(CL_KEY)) || {}; } catch (e) {}
    if (v.quality) { clEls.quality.value = v.quality; }
    clEls.aggro.value = v.aggro || "balanced";
  }
  function clSave() {
    try { localStorage.setItem(CL_KEY, JSON.stringify({ quality: clEls.quality.value, aggro: clEls.aggro.value })); } catch (e) {}
  }
  clEls.quality.addEventListener("change", clSave);
  clEls.aggro.addEventListener("change", clSave);

  function clRender() {
    clEls.list.innerHTML = "";
    var on = 0, saved = 0;
    cl.cuts.forEach(function (c, idx) {
      var row = document.createElement("div");
      row.className = "cut-row" + (cl.selected[idx] ? "" : " off");
      var cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = cl.selected[idx];
      cb.addEventListener("change", function () { cl.selected[idx] = cb.checked; clRender(); });

      var main = document.createElement("span");
      main.className = "range hitline";
      main.title = "Click to move the playhead here";
      var quote = document.createElement("span");
      quote.className = "hit"; quote.textContent = "“" + c.quote + "”";
      main.appendChild(quote);
      var badge = document.createElement("span");
      badge.className = "badge repeat"; badge.textContent = " " + c.category;
      main.appendChild(badge);
      if (c.reason) {
        var why = document.createElement("div");
        why.className = "ctx"; why.style.marginTop = "3px"; why.textContent = c.reason;
        main.appendChild(why);
      }
      main.addEventListener("click", function () { jumpToTime(c.start); });

      var meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = fmtTime(c.start) + " · " + (c.end - c.start).toFixed(1) + "s";

      row.appendChild(cb); row.appendChild(main); row.appendChild(meta);
      clEls.list.appendChild(row);
      if (cl.selected[idx]) { on++; saved += (c.end - c.start); }
    });
    clEls.summary.textContent = on + " of " + cl.cuts.length + " cut(s) · ~" + saved.toFixed(1) + "s removed";
    clEls.selAll.checked = (cl.cuts.length > 0 && on === cl.cuts.length);
    if (clEls.editBtn) { clEls.editBtn.classList.toggle("hidden", !cl.manual); }
  }

  function clScan() {
    if (!QCAudio.nodeAvailable() || !QCAi.nodeAvailable()) {
      setStatus("Node.js isn't enabled — restart Premiere after running setup.ps1.", "err");
      return;
    }
    clEls.scanBtn.disabled = true;
    clEls.reviewCard.classList.add("hidden");
    var quality = clEls.quality.value || "small.en";
    var aggro = clEls.aggro.value || "balanced";
    setStatus("Reading audio clips", "busy");

    host("qcGetAudioClips()").then(function (res) {
      if (!res.ok) { throw new Error(res.error); }
      if (!res.clips || res.clips.length === 0) { throw new Error("No audio clips with media on the sequence."); }
      setStatus("Transcribing the sequence…", "busy");
      return QCAudio.transcribeSegments({
        whisperPath: whisperPath(), ffmpegPath: ffmpegPath(),
        clips: res.clips, model: quality,
        onProgress: transcribeProgress("Transcribing")
      });
    }).then(function (segments) {
      if (!segments || segments.length === 0) { throw new Error("No speech found to analyze."); }
      var b = brainGet();
      cl.manual = null;
      if (b.brain === "manual") {
        setStatus("Copy the prompt into claude.ai, then paste the reply.", "busy");
        var prompt = QCAi.buildTranscriptEditPrompt(segments, aggro, aiContext());
        cl.manual = { prompt: prompt, segments: segments, reply: "" };
        return manualClaude(prompt, function (reply) {
          cl.manual.reply = reply;
          return QCAi.parseTranscriptEdits(reply, segments);
        });
      }
      setStatus(b.brain === "claude-api" ? "Asking Claude what to cut…" : "Asking the local AI what to cut… (first run loads the model)", "busy");
      return QCAi.findTranscriptEdits({
        brain: b.brain, apiKey: b.apiKey,
        ollamaExe: ollamaExe(), modelsDir: ollamaModelsDir(), model: LLM_MODEL,
        segments: segments, aggressiveness: aggro, context: aiContext()
      });
    }).then(function (cuts) {
      cl.cuts = cuts || [];
      cl.selected = cl.cuts.map(function () { return true; });
      clEls.scanBtn.disabled = false;
      if (cl.cuts.length === 0) {
        setStatus("No cuts suggested — it reads as already tight (try Heavy, or Best accuracy).", "ok");
        return;
      }
      clRender();
      clEls.reviewCard.classList.remove("hidden");
      setStatus("Review the suggested cuts, then apply.", "ok");
    }).catch(function (err) {
      clEls.scanBtn.disabled = false;
      setStatus(err.message || String(err), "err");
    });
  }

  function clApply() {
    var chosen = cl.cuts.filter(function (_, i) { return cl.selected[i]; });
    if (chosen.length === 0) { return; }
    clEls.applyBtn.disabled = true; clEls.cancelBtn.disabled = true;
    setStatus("Cutting " + chosen.length + " section(s)", "busy");

    var ranges = chosen.map(function (c) { return { start: c.start, end: c.end }; });
    host('qcApplySilenceCuts("' + QCAudio.rangesToString(ranges) + '")').then(function (res) {
      clEls.applyBtn.disabled = false; clEls.cancelBtn.disabled = false;
      if (!res.ok) { throw new Error(res.error); }
      clEls.reviewCard.classList.add("hidden");
      setStatus("Done — cut " + res.cuts + " section(s)." + skipNote(res), res.skipped ? "err" : "ok");
      refreshActiveName();
    }).catch(function (err) {
      clEls.applyBtn.disabled = false; clEls.cancelBtn.disabled = false;
      setStatus(err.message || String(err), "err");
    });
  }

  clEls.scanBtn.addEventListener("click", clScan);
  clEls.applyBtn.addEventListener("click", clApply);
  clEls.editBtn.addEventListener("click", function () {
    manualEdit(cl.manual, function (reply) { return QCAi.parseTranscriptEdits(reply, cl.manual.segments); })
      .then(function (cuts) {
        cl.cuts = cuts || []; cl.selected = cl.cuts.map(function () { return true; });
        if (cl.cuts.length === 0) {
          clEls.reviewCard.classList.add("hidden");
          setStatus("That reply has no cuts — edit it again or rescan.", "ok");
          return;
        }
        clRender();
        clEls.reviewCard.classList.remove("hidden");
        setStatus("Updated from your edited reply — review and apply.", "ok");
      }).catch(function (err) { setStatus(err.message || String(err), "err"); });
  });
  clEls.cancelBtn.addEventListener("click", function () {
    clEls.reviewCard.classList.add("hidden");
    setStatus("Cancelled. Nothing was changed.");
  });
  clEls.selAll.addEventListener("change", function () {
    var onAll = clEls.selAll.checked;
    cl.selected = cl.cuts.map(function () { return onAll; });
    clRender();
  });
  bindDrawer(clEls.settings, clEls.settingsToggle);

  /* ===================================================================
   * QUICK CLEAN TAB — run several cut passes in one safe go.
   *
   * Correctness invariant (do not break): detect EVERY enabled pass against ONE
   * pristine read of the timeline, merge all selected cuts into a single
   * ascending, non-overlapping list (union rule), and apply in EXACTLY ONE
   * qcApplySilenceCuts call. Applying passes separately would let the first
   * ripple-delete shift the timeline so later passes cut the wrong frames with
   * no error shown. Zoom is non-destructive and runs LAST, on a fresh re-read.
   * =================================================================== */
  var QK_KEY = "quietcut.quick.v1";
  var qc = { items: [], speedWarn: "", cleanupErr: "" };
  var qcEls = {
    scanBtn: document.getElementById("qcScanBtn"),
    settings: document.getElementById("qcSettings"),
    settingsToggle: document.getElementById("qcSettingsToggle"),
    doSilence: document.getElementById("qcDoSilence"),
    doFillers: document.getElementById("qcDoFillers"),
    doCleanup: document.getElementById("qcDoCleanup"),
    doZoom: document.getElementById("qcDoZoom"),
    brainField: document.getElementById("qcBrainField"),
    quality: document.getElementById("qcQuality"),
    aggro: document.getElementById("qcAggro"),
    reviewCard: document.getElementById("qcReviewCard"),
    summary: document.getElementById("qcSummary"),
    selAll: document.getElementById("qcSelAll"),
    filters: document.getElementById("qcFilters"),
    list: document.getElementById("qcList"),
    steps: document.getElementById("qcSteps"),
    applyBtn: document.getElementById("qcApplyBtn"),
    cancelBtn: document.getElementById("qcCancelBtn")
  };
  var QC_SOURCES = {
    silence: { label: "silence", badge: "silence" },
    filler:  { label: "filler",  badge: "filler" },
    repeat:  { label: "repeat",  badge: "repeat" },
    cleanup: { label: "cleanup", badge: "cleanup" }
  };

  function qcSaveSettings() {
    try {
      localStorage.setItem(QK_KEY, JSON.stringify({
        doSilence: qcEls.doSilence.checked, doFillers: qcEls.doFillers.checked,
        doCleanup: qcEls.doCleanup.checked, doZoom: qcEls.doZoom.checked,
        quality: qcEls.quality.value, aggro: qcEls.aggro.value
      }));
    } catch (e) {}
  }
  function qcLoadSettings() {
    var v = {};
    try { v = JSON.parse(localStorage.getItem(QK_KEY)) || {}; } catch (e) {}
    if (v.doSilence != null) { qcEls.doSilence.checked = v.doSilence; }
    if (v.doFillers != null) { qcEls.doFillers.checked = v.doFillers; }
    if (v.doCleanup != null) { qcEls.doCleanup.checked = v.doCleanup; }
    if (v.doZoom != null) { qcEls.doZoom.checked = v.doZoom; }
    if (v.quality) { qcEls.quality.value = v.quality; }
    if (v.aggro) { qcEls.aggro.value = v.aggro; }
    qcSyncFields();
  }
  // Hide AI/transcription controls when no transcript-based step is selected.
  function qcSyncFields() {
    var needsBrain = qcEls.doCleanup.checked;
    qcEls.brainField.style.display = needsBrain ? "" : "none";
    qcEls.aggro.parentNode.style.display = needsBrain ? "" : "none"; // the .field row
  }

  function qcCountsBySource() {
    var c = {};
    qc.items.forEach(function (it) {
      c[it.source] = c[it.source] || { total: 0, on: 0 };
      c[it.source].total++; if (it.on) { c[it.source].on++; }
    });
    return c;
  }

  function qcRenderFilters() {
    qcEls.filters.innerHTML = "";
    var counts = qcCountsBySource();
    Object.keys(QC_SOURCES).forEach(function (src) {
      if (!counts[src]) { return; }
      var chip = document.createElement("span");
      chip.className = "chip" + (counts[src].on > 0 ? " on" : "");
      chip.textContent = QC_SOURCES[src].label + " " + counts[src].on + "/" + counts[src].total;
      chip.title = "Toggle all " + QC_SOURCES[src].label + " cuts";
      chip.addEventListener("click", function () {
        var anyOn = counts[src].on > 0;
        qc.items.forEach(function (it) { if (it.source === src) { it.on = !anyOn; } });
        qcRender();
      });
      qcEls.filters.appendChild(chip);
    });
  }

  function qcRender() {
    qcEls.list.innerHTML = "";
    var on = 0, saved = 0;
    qc.items.forEach(function (it, idx) {
      var row = document.createElement("div");
      row.className = "cut-row" + (it.on ? "" : " off");
      var cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = it.on;
      cb.addEventListener("change", function () { it.on = cb.checked; qcRender(); });

      var main = document.createElement("span");
      main.className = "range hitline";
      main.title = "Click to move the playhead here";
      var badge = document.createElement("span");
      badge.className = "badge " + QC_SOURCES[it.source].badge;
      badge.textContent = QC_SOURCES[it.source].label + " ";
      main.appendChild(badge);
      var lbl = document.createElement("span");
      lbl.className = "hit";
      lbl.textContent = it.source === "silence" ? (fmtTime(it.start) + " → " + fmtTime(it.end)) : ("“" + it.label + "”");
      main.appendChild(lbl);
      if (it.sub) {
        var sub = document.createElement("span");
        sub.className = "ctx"; sub.textContent = " " + it.sub;
        main.appendChild(sub);
      }
      main.addEventListener("click", function () { jumpToTime(it.start); });

      var meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = fmtTime(it.start) + " · " + (it.end - it.start).toFixed(1) + "s";

      row.appendChild(cb); row.appendChild(main); row.appendChild(meta);
      qcEls.list.appendChild(row);
      if (it.on) { on++; saved += (it.end - it.start); }
    });
    qcEls.summary.textContent = on + " of " + qc.items.length + " cut(s) · ~" + saved.toFixed(1) + "s";
    qcEls.selAll.checked = (qc.items.length > 0 && on === qc.items.length);
    qcRenderFilters();
  }

  function qcScan() {
    if (!QCAudio.nodeAvailable() || !QCAi.nodeAvailable()) {
      setStatus("Node.js isn't enabled — restart Premiere after running setup.ps1.", "err");
      return;
    }
    var doSil = qcEls.doSilence.checked, doFil = qcEls.doFillers.checked, doCln = qcEls.doCleanup.checked;
    if (!doSil && !doFil && !doCln) { setStatus("Pick at least one step to run.", "err"); return; }

    qcEls.scanBtn.disabled = true;
    qcEls.reviewCard.classList.add("hidden");
    qc.items = []; qc.speedWarn = ""; qc.cleanupErr = "";
    var quality = qcEls.quality.value || "small.en";
    setStatus("Reading audio clips", "busy");

    var clips = null;
    host("qcGetAudioClips()").then(function (res) {
      if (!res.ok) { throw new Error(res.error); }
      if (!res.clips || res.clips.length === 0) { throw new Error("No audio clips with media on the sequence."); }
      clips = res.clips;
      // Non-100% speed clips break the time mapping for every pass — warn (don't block).
      var bad = clips.filter(function (c) { return Math.abs((c.speed || 1) - 1) > 0.001; }).length;
      if (bad) { qc.speedWarn = " (warning: " + bad + " clip(s) aren't at 100% speed — cuts there may be off)"; }
      // One Whisper pass feeds both Fillers (words) and Cleanup (segments).
      if (doFil || doCln) {
        return QCAudio.transcribeBoth({
          whisperPath: whisperPath(), ffmpegPath: ffmpegPath(),
          clips: clips, model: quality, onProgress: transcribeProgress("Transcribing")
        });
      }
      return { words: [], segments: [] };
    }).then(function (t) {
      var items = [];
      var chain = Promise.resolve();

      if (doSil) {
        chain = chain.then(function () {
          setStatus("Finding silences…", "busy");
          var ss = silSettings();
          return QCAudio.detectSilences({
            ffmpegPath: ffmpegPath(), clips: clips,
            thresholdDb: ss.thresholdDb, minSilenceMs: ss.minSilenceMs, paddingMs: ss.paddingMs
          }).then(function (cuts) {
            cuts.forEach(function (c) { items.push({ start: c.start, end: c.end, source: "silence", label: "", sub: "", on: true }); });
          });
        });
      }

      if (doFil) {
        chain = chain.then(function () {
          setStatus("Finding fillers & repeats…", "busy");
          var fs = filSettings();
          var hits = [];
          if (fs.doFillers) { hits = hits.concat(QCAudio.detectFillers(t.words, parseFillerList(fs.list))); }
          if (fs.doRepeats) { hits = hits.concat(QCAudio.detectRepetitions(t.words)); }
          hits.forEach(function (h) {
            var keepOff = (fs.keepTight && h.type === "filler" && h.tight);
            items.push({
              start: h.start, end: h.end,
              source: (h.type === "repeat" ? "repeat" : "filler"),
              label: h.label, sub: h.tight ? "tight" : "", on: !keepOff
            });
          });
        });
      }

      if (doCln) {
        // AI step is the most failure-prone (brain down / manual cancelled) — isolate
        // it so silence + filler results still survive if it fails.
        chain = chain.then(function () {
          if (!t.segments || t.segments.length === 0) { return; }
          var aggro = qcEls.aggro.value || "balanced";
          var b = brainGet();
          var got;
          if (b.brain === "manual") {
            setStatus("Copy the prompt into claude.ai, then paste the reply.", "busy");
            got = manualClaude(QCAi.buildTranscriptEditPrompt(t.segments, aggro, aiContext()),
              function (reply) { return QCAi.parseTranscriptEdits(reply, t.segments); });
          } else {
            setStatus(b.brain === "claude-api" ? "Asking Claude what to cut…" : "Asking the local AI what to cut…", "busy");
            got = QCAi.findTranscriptEdits({
              brain: b.brain, apiKey: b.apiKey, ollamaExe: ollamaExe(), modelsDir: ollamaModelsDir(),
              model: LLM_MODEL, segments: t.segments, aggressiveness: aggro, context: aiContext()
            });
          }
          return got.then(function (cuts) {
            cuts.forEach(function (c) { items.push({ start: c.start, end: c.end, source: "cleanup", label: c.quote, sub: c.category, on: true }); });
          }).catch(function (e) {
            qc.cleanupErr = " · AI cleanup skipped: " + (e.message || String(e));
          });
        });
      }

      return chain.then(function () { return items; });
    }).then(function (items) {
      items.sort(function (a, b) { return a.start - b.start; });
      qc.items = items;
      qcEls.scanBtn.disabled = false;
      if (items.length === 0) {
        setStatus("Nothing found to cut with the selected steps." + qc.cleanupErr, qc.cleanupErr ? "err" : "ok");
        return;
      }
      qcRender();
      qcEls.reviewCard.classList.remove("hidden");
      setStatus("Review the combined cut list, then apply." + qc.speedWarn + qc.cleanupErr, qc.cleanupErr ? "err" : "ok");
    }).catch(function (err) {
      qcEls.scanBtn.disabled = false;
      setStatus(err.message || String(err), "err");
    });
  }

  function qcApply() {
    var chosen = qc.items.filter(function (it) { return it.on; });
    if (chosen.length === 0) { setStatus("Tick at least one cut to apply.", "err"); return; }
    // Union-merge across all sources so overlapping cuts never orphan a razor.
    var merged = QCAudio.mergeSelectedRanges(chosen);
    if (merged.length === 0) { setStatus("Nothing to cut after merging.", "err"); return; }

    qcEls.applyBtn.disabled = true; qcEls.cancelBtn.disabled = true;
    setStatus("Applying " + merged.length + " cut(s)", "busy");
    host('qcApplySilenceCuts("' + QCAudio.rangesToString(merged) + '")').then(function (res) {
      qcEls.applyBtn.disabled = false; qcEls.cancelBtn.disabled = false;
      if (!res.ok) { throw new Error(res.error); }
      qcEls.reviewCard.classList.add("hidden");
      return refreshActiveName().then(function () {
        if (qcEls.doZoom.checked) {
          // Zoom LAST, on the now-cut timeline: hand off to the Zoom tab and scan
          // fresh so moments line up with the rippled positions.
          setStatus("Cut " + res.cuts + " section(s)." + skipNote(res) + " Now finding zoom moments on the new edit…", "busy");
          tabFor("zoom");
          zoomScan();
        } else {
          setStatus("Done — cut " + res.cuts + " section(s)." + skipNote(res), res.skipped ? "err" : "ok");
        }
      });
    }).catch(function (err) {
      qcEls.applyBtn.disabled = false; qcEls.cancelBtn.disabled = false;
      setStatus(err.message || String(err), "err");
    });
  }

  qcEls.scanBtn.addEventListener("click", qcScan);
  qcEls.applyBtn.addEventListener("click", qcApply);
  qcEls.cancelBtn.addEventListener("click", function () {
    qcEls.reviewCard.classList.add("hidden");
    setStatus("Cancelled. Nothing was changed.");
  });
  qcEls.selAll.addEventListener("change", function () {
    var onAll = qcEls.selAll.checked;
    qc.items.forEach(function (it) { it.on = onAll; });
    qcRender();
  });
  [qcEls.doSilence, qcEls.doFillers, qcEls.doCleanup, qcEls.doZoom].forEach(function (cbx) {
    cbx.addEventListener("change", function () { qcSyncFields(); qcSaveSettings(); });
  });
  qcEls.quality.addEventListener("change", qcSaveSettings);
  qcEls.aggro.addEventListener("change", qcSaveSettings);
  bindDrawer(qcEls.settings, qcEls.settingsToggle);

  /* ===================================================================
   * VOX POP TAB — analyze many interviews, propose a montage plan.
   * =================================================================== */
  var VP_KEY = "quietcut.voxpop.v1";
  var vp = { items: [] };
  var vpEls = {
    scanBtn: document.getElementById("vpScanBtn"),
    settings: document.getElementById("vpSettings"),
    settingsToggle: document.getElementById("vpSettingsToggle"),
    quality: document.getElementById("vpQuality"),
    pad: document.getElementById("vpPad"),
    padVal: document.getElementById("vpPadVal"),
    reviewCard: document.getElementById("vpReviewCard"),
    summary: document.getElementById("vpSummary"),
    list: document.getElementById("vpList"),
    buildBtn: document.getElementById("vpBuildBtn"),
    closeBtn: document.getElementById("vpCloseBtn"),
    editBtn: document.getElementById("vpEditBtn")
  };

  function vpSaveSettings() {
    try {
      localStorage.setItem(VP_KEY, JSON.stringify({
        quality: vpEls.quality.value, pad: vpEls.pad.value
      }));
    } catch (e) {}
  }
  function vpSyncPad() { vpEls.padVal.textContent = Number(vpEls.pad.value).toFixed(2) + "s"; }
  function vpLoadSettings() {
    var v = {};
    try { v = JSON.parse(localStorage.getItem(VP_KEY)) || {}; } catch (e) {}
    if (v.quality) { vpEls.quality.value = v.quality; }
    vpEls.pad.value = (v.pad != null) ? v.pad : 0.2;
    vpSyncPad();
  }
  vpEls.quality.addEventListener("change", vpSaveSettings);
  vpEls.pad.addEventListener("input", function () { vpSyncPad(); vpSaveSettings(); });

  function vpRender() {
    vpEls.list.innerHTML = "";
    vp.items.forEach(function (it, idx) {
      var row = document.createElement("div");
      row.className = "cut-row";
      row.style.gridTemplateColumns = "1fr auto";
      row.style.cursor = "pointer";
      row.title = "Click to move the playhead here";

      var main = document.createElement("span");
      main.className = "range";
      var tag = document.createElement("span");
      tag.className = "badge " + (it.role === "question" ? "repeat" : "filler");
      tag.textContent = (it.role === "question" ? "QUESTION" : (idx) + ". " + it.label) + " ";
      var quote = document.createElement("span");
      quote.className = "hit"; quote.textContent = "“" + it.quote + "”";
      main.appendChild(tag); main.appendChild(quote);
      if (it.reason && it.role !== "question") {
        var why = document.createElement("div");
        why.className = "ctx"; why.style.marginTop = "3px"; why.textContent = it.reason;
        main.appendChild(why);
      }
      main.addEventListener("click", function () { jumpToTime(it.seqStart); });

      var meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = fmtTime(it.seqStart);

      row.appendChild(main); row.appendChild(meta);
      vpEls.list.appendChild(row);
    });
    var answers = vp.items.filter(function (i) { return i.role === "answer"; }).length;
    vpEls.summary.textContent = answers + " soundbite(s) + question — playback order";
    if (vpEls.editBtn) { vpEls.editBtn.classList.toggle("hidden", !vp.manual); }
  }

  function vpScan() {
    if (!QCAudio.nodeAvailable() || !QCAi.nodeAvailable()) {
      setStatus("Node.js isn't enabled — restart Premiere after running setup.ps1.", "err");
      return;
    }
    vpEls.scanBtn.disabled = true;
    vpEls.reviewCard.classList.add("hidden");
    var quality = vpEls.quality.value || "small.en";
    setStatus("Reading interview clips", "busy");

    host("qcGetVideoClips()").then(function (res) {
      if (!res.ok) { throw new Error(res.error); }
      if (!res.clips || res.clips.length < 2) {
        throw new Error("Put at least 2 interview clips on the sequence (one per person).");
      }
      var total = res.clips.length;
      return QCAudio.transcribePerClip({
        whisperPath: whisperPath(), ffmpegPath: ffmpegPath(), clips: res.clips, model: quality,
        onProgress: function (i, n) { setStatus("Transcribing interview " + (i + 1) + " of " + n + "…", "busy"); }
      });
    }).then(function (perClip) {
      var usable = perClip.filter(function (c) { return c.words && c.words.length > 0; });
      if (usable.length < 2) { throw new Error("Could not transcribe enough clips (need 2+ with speech)."); }

      var b = brainGet();
      vp.manual = null;
      if (b.brain === "manual") {
        setStatus("Copy the prompt into claude.ai, then paste the reply.", "busy");
        var prompt = QCAi.buildVoxPopPrompt(usable, aiContext());
        vp.manual = { prompt: prompt, clips: usable, reply: "" };
        return manualClaude(prompt, function (reply) {
          vp.manual.reply = reply;
          return QCAi.parseVoxPop(reply, usable);
        });
      }
      setStatus(b.brain === "claude-api" ? "Asking Claude to build the montage…" : "Asking the local AI to build the montage…", "busy");
      return QCAi.findVoxPop({
        brain: b.brain, apiKey: b.apiKey,
        ollamaExe: ollamaExe(), modelsDir: ollamaModelsDir(), model: LLM_MODEL,
        clips: usable, context: aiContext()
      });
    }).then(function (items) {
      vp.items = items || [];
      vpEls.scanBtn.disabled = false;
      if (vp.items.length === 0) { setStatus("The AI didn't return a usable plan — try Best accuracy or Claude.", "ok"); return; }
      vpRender();
      vpEls.reviewCard.classList.remove("hidden");
      setStatus("Montage plan ready — preview any line, then click Build Vox Pop edit.", "ok");
    }).catch(function (err) {
      vpEls.scanBtn.disabled = false;
      setStatus(err.message || String(err), "err");
    });
  }

  // Turn the approved plan into "clipIndex,srcStart,srcEnd;…" in playback order.
  function vpSpec() {
    return vp.items.filter(function (it) {
      return it && typeof it.clipIndex === "number" && it.srcEnd > it.srcStart;
    }).map(function (it) {
      return it.clipIndex + "," + it.srcStart.toFixed(3) + "," + it.srcEnd.toFixed(3);
    }).join(";");
  }

  function vpAssemble() {
    var spec = vpSpec();
    if (!spec) { setStatus("Nothing to assemble — run Analyze Interviews first.", "err"); return; }
    vpEls.buildBtn.disabled = true;
    setStatus("Building the Vox Pop sequence…", "busy");
    var pad = Number(vpEls.pad.value) || 0;
    host('qcBuildVoxPop("' + spec + '",' + pad + ')').then(function (res) {
      vpEls.buildBtn.disabled = false;
      if (!res.ok) { setStatus(res.error || "Could not build the edit.", "err"); return; }
      var msg = "Built “" + res.name + "” — " + res.placed + " clip(s) placed";
      if (res.skipped) { msg += ", " + res.skipped + " skipped"; }
      msg += ". It's now open in the timeline.";
      setStatus(msg, "ok");
      refreshActiveName();
    }).catch(function (err) {
      vpEls.buildBtn.disabled = false;
      setStatus(err.message || String(err), "err");
    });
  }

  vpEls.scanBtn.addEventListener("click", vpScan);
  vpEls.buildBtn.addEventListener("click", vpAssemble);
  vpEls.closeBtn.addEventListener("click", function () { vpEls.reviewCard.classList.add("hidden"); });
  vpEls.editBtn.addEventListener("click", function () {
    manualEdit(vp.manual, function (reply) { return QCAi.parseVoxPop(reply, vp.manual.clips); })
      .then(function (items) {
        vp.items = items || [];
        if (vp.items.length === 0) { setStatus("That reply has no usable plan — edit it again.", "ok"); return; }
        vpRender();
        vpEls.reviewCard.classList.remove("hidden");
        setStatus("Updated from your edited reply — preview, then build.", "ok");
      }).catch(function (err) { setStatus(err.message || String(err), "err"); });
  });
  bindDrawer(vpEls.settings, vpEls.settingsToggle);

  /* ===================================================================
   * STORY TAB — documentary narrative assembled from interview footage.
   * Reuses the word-level per-clip transcription and the qcBuildVoxPop
   * assembler; only the AI's brief (build a narrative arc) and the
   * reorderable review differ from Vox Pop.
   * =================================================================== */
  var ST_KEY = "quietcut.story.v1";
  var st = { items: [], selected: [], manual: null };
  var stEls = {
    scanBtn: document.getElementById("stScanBtn"),
    settings: document.getElementById("stSettings"),
    settingsToggle: document.getElementById("stSettingsToggle"),
    pace: document.getElementById("stPace"),
    quality: document.getElementById("stQuality"),
    pad: document.getElementById("stPad"),
    padVal: document.getElementById("stPadVal"),
    reviewCard: document.getElementById("stReviewCard"),
    summary: document.getElementById("stSummary"),
    list: document.getElementById("stList"),
    buildBtn: document.getElementById("stBuildBtn"),
    closeBtn: document.getElementById("stCloseBtn"),
    editBtn: document.getElementById("stEditBtn")
  };

  function stSyncPad() { stEls.padVal.textContent = Number(stEls.pad.value).toFixed(2) + "s"; }
  function stLoad() {
    var v = {};
    try { v = JSON.parse(localStorage.getItem(ST_KEY)) || {}; } catch (e) {}
    if (v.pace) { stEls.pace.value = v.pace; }
    if (v.quality) { stEls.quality.value = v.quality; }
    stEls.pad.value = (v.pad != null) ? v.pad : 0.2;
    stSyncPad();
  }
  function stSave() {
    try { localStorage.setItem(ST_KEY, JSON.stringify({ pace: stEls.pace.value, quality: stEls.quality.value, pad: stEls.pad.value })); } catch (e) {}
  }
  stEls.pace.addEventListener("change", stSave);
  stEls.quality.addEventListener("change", stSave);
  stEls.pad.addEventListener("input", function () { stSyncPad(); stSave(); });

  function stMkBtn(label, title, onClick) {
    var b = document.createElement("button");
    b.className = "zoom-ctrl"; b.type = "button"; b.textContent = label; b.title = title;
    b.addEventListener("click", onClick);
    return b;
  }
  // Reorder a beat within the narrative (swap with its neighbour).
  function stMove(i, dir) {
    var j = i + dir;
    if (j < 0 || j >= st.items.length) { return; }
    var ti = st.items[i]; st.items[i] = st.items[j]; st.items[j] = ti;
    var ts = st.selected[i]; st.selected[i] = st.selected[j]; st.selected[j] = ts;
    stRender();
  }

  function stRender() {
    stEls.list.innerHTML = "";
    var on = 0, secs = 0;
    st.items.forEach(function (it, idx) {
      var row = document.createElement("div");
      row.className = "cut-row" + (st.selected[idx] ? "" : " off");

      var cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = st.selected[idx];
      cb.addEventListener("change", function () { st.selected[idx] = cb.checked; stRender(); });

      var mid = document.createElement("div");
      mid.style.cursor = "pointer";
      mid.title = "Click to preview this moment in the original";
      mid.addEventListener("click", function () { jumpToTime(it.seqStart); });
      var head = document.createElement("span");
      head.className = "range";
      var num = document.createElement("b"); num.textContent = (idx + 1) + ". ";
      head.appendChild(num);
      if (it.speaker) {
        var spk = document.createElement("span");
        spk.className = "badge speaker"; spk.textContent = it.speaker + " ";
        head.appendChild(spk);
      }
      if (it.section) {
        var badge = document.createElement("span");
        badge.className = "badge section"; badge.textContent = it.section + " ";
        head.appendChild(badge);
      }
      mid.appendChild(head);
      var q = document.createElement("div");
      q.className = "qline"; q.textContent = "“" + it.quote + "”";
      mid.appendChild(q);

      var ctrls = document.createElement("span");
      ctrls.className = "ctrls";
      var meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = (it.srcEnd - it.srcStart).toFixed(1) + "s";
      ctrls.appendChild(meta);
      ctrls.appendChild(stMkBtn("▲", "Move earlier in the story", function () { stMove(idx, -1); }));
      ctrls.appendChild(stMkBtn("▼", "Move later in the story", function () { stMove(idx, 1); }));

      row.appendChild(cb); row.appendChild(mid); row.appendChild(ctrls);
      stEls.list.appendChild(row);
      if (st.selected[idx]) { on++; secs += (it.srcEnd - it.srcStart); }
    });
    stEls.summary.textContent = on + " of " + st.items.length + " beats · ~" + secs.toFixed(0) + "s";
    if (stEls.editBtn) { stEls.editBtn.classList.toggle("hidden", !st.manual); }
  }

  function stShow(items) {
    st.items = items || [];
    st.selected = st.items.map(function () { return true; });
    if (st.items.length === 0) {
      stEls.reviewCard.classList.add("hidden");
      setStatus("The AI didn't return a usable story — try Best accuracy or Claude.", "ok");
      return;
    }
    stRender();
    stEls.reviewCard.classList.remove("hidden");
    setStatus("Story ready — reorder (▲▼) or deselect beats, preview any, then Build.", "ok");
  }

  function stBrainExtract(usable) {
    var b = brainGet();
    st.manual = null;
    if (b.brain === "manual") {
      setStatus("Copy the prompt into claude.ai, then paste the reply.", "busy");
      var prompt = QCAi.buildStoryPrompt(usable, aiContext(), stEls.pace.value);
      st.manual = { prompt: prompt, clips: usable, reply: "" };
      return manualClaude(prompt, function (reply) {
        st.manual.reply = reply;
        return QCAi.parseStory(reply, usable);
      });
    }
    setStatus(b.brain === "claude-api" ? "Asking Claude to shape the story…" : "Asking the local AI to shape the story…", "busy");
    return QCAi.findStory({
      brain: b.brain, apiKey: b.apiKey,
      ollamaExe: ollamaExe(), modelsDir: ollamaModelsDir(), model: LLM_MODEL,
      clips: usable, context: aiContext(), pace: stEls.pace.value
    });
  }

  function stScan() {
    if (!QCAudio.nodeAvailable() || !QCAi.nodeAvailable()) {
      setStatus("Node.js isn't enabled — restart Premiere after running setup.ps1.", "err");
      return;
    }
    stEls.scanBtn.disabled = true;
    stEls.reviewCard.classList.add("hidden");
    var quality = stEls.quality.value || "small.en";
    setStatus("Reading interview clips", "busy");

    host("qcGetVideoClips()").then(function (res) {
      if (!res.ok) { throw new Error(res.error); }
      if (!res.clips || res.clips.length === 0) { throw new Error("Put your interview recording on the sequence."); }
      return QCAudio.transcribePerClip({
        whisperPath: whisperPath(), ffmpegPath: ffmpegPath(), clips: res.clips, model: quality,
        onProgress: function (i, n) { setStatus(n > 1 ? ("Transcribing clip " + (i + 1) + " of " + n + "…") : "Transcribing…", "busy"); }
      });
    }).then(function (perClip) {
      var usable = perClip.filter(function (c) { return c.words && c.words.length > 0; });
      if (usable.length === 0) { throw new Error("No speech found to build a story from."); }
      return stBrainExtract(usable);
    }).then(function (items) {
      stEls.scanBtn.disabled = false;
      stShow(items);
    }).catch(function (err) {
      stEls.scanBtn.disabled = false;
      setStatus(err.message || String(err), "err");
    });
  }

  // "clipIndex,srcStart,srcEnd;..." for the selected beats in narrative order.
  function stSpec() {
    return st.items.filter(function (it, i) {
      return st.selected[i] && it && typeof it.clipIndex === "number" && it.srcEnd > it.srcStart;
    }).map(function (it) {
      return it.clipIndex + "," + it.srcStart.toFixed(3) + "," + it.srcEnd.toFixed(3);
    }).join(";");
  }

  function stAssemble() {
    var spec = stSpec();
    if (!spec) { setStatus("Select at least one beat to build the story.", "err"); return; }
    stEls.buildBtn.disabled = true;
    setStatus("Building the story sequence…", "busy");
    var pad = Number(stEls.pad.value) || 0;
    host('qcBuildVoxPop("' + spec + '",' + pad + ',"Story")').then(function (res) {
      stEls.buildBtn.disabled = false;
      if (!res.ok) { setStatus(res.error || "Could not build the story.", "err"); return; }
      var msg = "Built “" + res.name + "” — " + res.placed + " beat(s) placed";
      if (res.skipped) { msg += ", " + res.skipped + " skipped"; }
      msg += ". It's open in the timeline.";
      setStatus(msg, "ok");
      refreshActiveName();
    }).catch(function (err) {
      stEls.buildBtn.disabled = false;
      setStatus(err.message || String(err), "err");
    });
  }

  stEls.scanBtn.addEventListener("click", stScan);
  stEls.buildBtn.addEventListener("click", stAssemble);
  stEls.closeBtn.addEventListener("click", function () { stEls.reviewCard.classList.add("hidden"); });
  stEls.editBtn.addEventListener("click", function () {
    manualEdit(st.manual, function (reply) { return QCAi.parseStory(reply, st.manual.clips); })
      .then(function (items) {
        if (!items || items.length === 0) { setStatus("That reply has no beats — edit it again.", "ok"); return; }
        stShow(items);
      }).catch(function (err) { setStatus(err.message || String(err), "err"); });
  });
  bindDrawer(stEls.settings, stEls.settingsToggle);

  /* ===================================================================
   * CAPTIONS TAB — transcribe, fix wrong words, then burn a styled karaoke
   * overlay (ffmpeg) or add a plain native caption track.
   * =================================================================== */
  var CAP_KEY = "quietcut.captions.v1";
  var cap = { words: [], lines: [] };
  var capEls = {
    scanBtn: document.getElementById("capScanBtn"),
    settings: document.getElementById("capSettings"),
    settingsToggle: document.getElementById("capSettingsToggle"),
    quality: document.getElementById("capQuality"),
    words: document.getElementById("capWords"),
    wordsVal: document.getElementById("capWordsVal"),
    font: document.getElementById("capFont"),
    size: document.getElementById("capSize"),
    sizeVal: document.getElementById("capSizeVal"),
    bold: document.getElementById("capBold"),
    active: document.getElementById("capActive"),
    base: document.getElementById("capBase"),
    mode: document.getElementById("capMode"),
    box: document.getElementById("capBox"),
    pos: document.getElementById("capPos"),
    container: document.getElementById("capContainer"),
    reviewCard: document.getElementById("capReviewCard"),
    summary: document.getElementById("capSummary"),
    list: document.getElementById("capList"),
    burnBtn: document.getElementById("capBurnBtn"),
    srtBtn: document.getElementById("capSrtBtn")
  };

  function capSync() {
    capEls.wordsVal.textContent = capEls.words.value;
    capEls.sizeVal.textContent = capEls.size.value;
  }
  function capLoad() {
    var v = {};
    try { v = JSON.parse(localStorage.getItem(CAP_KEY)) || {}; } catch (e) {}
    if (v.quality) { capEls.quality.value = v.quality; }
    capEls.words.value = v.words || 4;
    capEls.font.value = v.font || "Arial";
    capEls.size.value = v.size || 52;
    capEls.bold.checked = (v.bold !== false);
    capEls.active.value = v.active || "#ffffff";
    capEls.base.value = v.base || "#c9c9c9";
    capEls.mode.value = v.mode || "box";
    capEls.box.value = v.box || "#101010";
    capEls.pos.value = v.pos || "bottom";
    capEls.container.value = v.container || "prores";
    capSync();
  }
  function capSave() {
    try {
      localStorage.setItem(CAP_KEY, JSON.stringify({
        quality: capEls.quality.value, words: capEls.words.value, font: capEls.font.value,
        size: capEls.size.value, bold: capEls.bold.checked, active: capEls.active.value,
        base: capEls.base.value, mode: capEls.mode.value, box: capEls.box.value,
        pos: capEls.pos.value, container: capEls.container.value
      }));
    } catch (e) {}
  }
  function capStyle() {
    return {
      font: capEls.font.value || "Arial",
      size: parseInt(capEls.size.value, 10) || 52,
      bold: capEls.bold.checked,
      activeColor: capEls.active.value,
      baseColor: capEls.base.value,
      boxMode: capEls.mode.value,
      boxColor: capEls.box.value,
      outlineColor: capEls.box.value,
      position: capEls.pos.value
    };
  }

  function capRender() {
    capEls.list.innerHTML = "";
    cap.lines.forEach(function (ln) {
      var row = document.createElement("div");
      row.className = "cut-row";
      row.style.gridTemplateColumns = "1fr auto";
      var inp = document.createElement("input");
      inp.type = "text"; inp.value = ln.text;
      inp.style.cssText = "width:100%;background:var(--panel-2);color:var(--text);border:1px solid var(--line);border-radius:4px;padding:5px 7px;font-family:inherit;font-size:12px;";
      inp.addEventListener("input", function () { ln.text = inp.value; ln.edited = true; });
      var meta = document.createElement("span");
      meta.className = "meta"; meta.style.cursor = "pointer"; meta.title = "Click to preview";
      meta.textContent = fmtTime(ln.start);
      meta.addEventListener("click", function () { jumpToTime(ln.start); });
      row.appendChild(inp); row.appendChild(meta);
      capEls.list.appendChild(row);
    });
    capEls.summary.textContent = cap.lines.length + " line(s) — fix wrong words, then burn or add a track";
  }

  function capScan() {
    if (!QCAudio.nodeAvailable() || !QCCaptions.nodeAvailable()) {
      setStatus("Node.js isn't enabled — restart Premiere after running setup.ps1.", "err");
      return;
    }
    capEls.scanBtn.disabled = true;
    capEls.reviewCard.classList.add("hidden");
    var quality = capEls.quality.value || "small.en";
    setStatus("Reading audio clips", "busy");
    host("qcGetAudioClips()").then(function (res) {
      if (!res.ok) { throw new Error(res.error); }
      if (!res.clips || !res.clips.length) { throw new Error("No audio clips with media on the sequence."); }
      setStatus("Transcribing the sequence…", "busy");
      return QCAudio.transcribe({
        whisperPath: whisperPath(), ffmpegPath: ffmpegPath(), clips: res.clips, model: quality
      });
    }).then(function (words) {
      capEls.scanBtn.disabled = false;
      if (!words || !words.length) { setStatus("No speech found to caption.", "ok"); return; }
      cap.words = words;
      cap.lines = QCCaptions.groupWordsToLines(words, { maxWords: parseInt(capEls.words.value, 10) || 4 });
      capRender();
      capEls.reviewCard.classList.remove("hidden");
      setStatus("Transcribed " + cap.lines.length + " line(s). Fix any wrong words, then burn or add a track.", "ok");
    }).catch(function (err) {
      capEls.scanBtn.disabled = false;
      setStatus(err.message || String(err), "err");
    });
  }

  function capBurn() {
    if (!cap.lines.length) { setStatus("Transcribe first.", "err"); return; }
    capEls.burnBtn.disabled = true; capEls.srtBtn.disabled = true;
    setStatus("Reading sequence size…", "busy");
    host("qcSequenceInfo()").then(function (info) {
      if (!info.ok) { throw new Error(info.error); }
      setStatus("Rendering caption overlay (this can take a moment)…", "busy");
      return QCCaptions.renderOverlay({
        ffmpegPath: ffmpegPath(), lines: cap.lines, style: capStyle(),
        W: info.width, H: info.height, fps: info.fps, durationSec: info.durationSec,
        container: capEls.container.value
      });
    }).then(function (overlayPath) {
      setStatus("Importing the overlay…", "busy");
      return host('qcImportAndPlace("' + jsxEscape(overlayPath) + '")');
    }).then(function (res) {
      capEls.burnBtn.disabled = false; capEls.srtBtn.disabled = false;
      if (!res.ok) { setStatus(res.error || "Could not place the overlay.", "err"); return; }
      setStatus("Captions added on V" + (res.track + 1) + ". To restyle or fix a word, edit and burn again.", "ok");
      refreshActiveName();
    }).catch(function (err) {
      capEls.burnBtn.disabled = false; capEls.srtBtn.disabled = false;
      setStatus(err.message || String(err), "err");
    });
  }

  function capSrt() {
    if (!cap.lines.length) { setStatus("Transcribe first.", "err"); return; }
    capEls.burnBtn.disabled = true; capEls.srtBtn.disabled = true;
    setStatus("Creating caption track…", "busy");
    var srtPath;
    try { srtPath = QCCaptions.writeTemp("NaifuCaptions.srt", QCCaptions.buildSrt(cap.lines)); }
    catch (e) {
      capEls.burnBtn.disabled = false; capEls.srtBtn.disabled = false;
      setStatus("Could not write the SRT: " + e.message, "err"); return;
    }
    host('qcAddCaptionTrack("' + jsxEscape(srtPath) + '")').then(function (res) {
      capEls.burnBtn.disabled = false; capEls.srtBtn.disabled = false;
      if (!res.ok) { setStatus(res.error || "Could not create the caption track.", "err"); return; }
      setStatus("Plain caption track added — edit the text in Premiere's Captions/Text panel.", "ok");
    }).catch(function (err) {
      capEls.burnBtn.disabled = false; capEls.srtBtn.disabled = false;
      setStatus(err.message || String(err), "err");
    });
  }

  capEls.scanBtn.addEventListener("click", capScan);
  capEls.burnBtn.addEventListener("click", capBurn);
  capEls.srtBtn.addEventListener("click", capSrt);
  capEls.words.addEventListener("input", function () {
    capSync(); capSave();
    if (cap.words.length) {
      cap.lines = QCCaptions.groupWordsToLines(cap.words, { maxWords: parseInt(capEls.words.value, 10) || 4 });
      capRender();
    }
  });
  capEls.size.addEventListener("input", function () { capSync(); capSave(); });
  [capEls.quality, capEls.font, capEls.bold, capEls.active, capEls.base, capEls.mode, capEls.box, capEls.pos, capEls.container]
    .forEach(function (el) { el.addEventListener("change", capSave); });
  bindDrawer(capEls.settings, capEls.settingsToggle);

  /* ===================================================================
   * HOOK TAB — short clips already cut from a podcast for social. Find the
   * juiciest line inside each and MARK it (span markers) so the editor makes
   * the cut by hand. Nothing on the timeline is changed except added markers.
   * =================================================================== */
  var HK_KEY = "quietcut.hook.v1";
  var hk = { items: [], selected: [], manual: null };
  var hkEls = {
    scanBtn: document.getElementById("hkScanBtn"),
    settings: document.getElementById("hkSettings"),
    settingsToggle: document.getElementById("hkSettingsToggle"),
    brain: document.getElementById("hkBrain"),
    perClip: document.getElementById("hkPerClip"),
    quality: document.getElementById("hkQuality"),
    color: document.getElementById("hkColor"),
    reviewCard: document.getElementById("hkReviewCard"),
    summary: document.getElementById("hkSummary"),
    list: document.getElementById("hkList"),
    markBtn: document.getElementById("hkMarkBtn"),
    closeBtn: document.getElementById("hkCloseBtn"),
    editBtn: document.getElementById("hkEditBtn")
  };

  // Hook has its OWN brain (default Claude manual): picking a scroll-stopper is
  // taste, and the local model is noticeably weaker at it than Claude.
  function hkLoad() {
    var v = {};
    try { v = JSON.parse(localStorage.getItem(HK_KEY)) || {}; } catch (e) {}
    hkEls.brain.value = v.brain || "manual";
    if (v.perClip) { hkEls.perClip.value = v.perClip; }
    if (v.quality) { hkEls.quality.value = v.quality; }
    if (v.color != null) { hkEls.color.value = v.color; }
  }
  function hkSave() {
    try {
      localStorage.setItem(HK_KEY, JSON.stringify({
        brain: hkEls.brain.value, perClip: hkEls.perClip.value,
        quality: hkEls.quality.value, color: hkEls.color.value
      }));
    } catch (e) {}
  }
  [hkEls.brain, hkEls.perClip, hkEls.quality, hkEls.color].forEach(function (el) {
    el.addEventListener("change", hkSave);
  });

  function hkRender() {
    hkEls.list.innerHTML = "";
    var on = 0;
    hk.items.forEach(function (it, idx) {
      var row = document.createElement("div");
      row.className = "cut-row" + (hk.selected[idx] ? "" : " off");

      var cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = hk.selected[idx];
      cb.addEventListener("change", function () { hk.selected[idx] = cb.checked; hkRender(); });

      var mid = document.createElement("div");
      mid.style.cursor = "pointer";
      mid.title = "Click to move the playhead to this hook";
      mid.addEventListener("click", function () { jumpToTime(it.seqStart); });

      var head = document.createElement("span");
      head.className = "range";
      var who = document.createElement("span");
      who.className = "badge speaker";
      who.textContent = (it.name || it.label) + " ";
      head.appendChild(who);
      if (it.type) {
        var ty = document.createElement("span");
        ty.className = "badge section"; ty.textContent = it.type + " ";
        head.appendChild(ty);
      }
      if (it.strength) {
        var str = document.createElement("span");
        // 8+ = would stop a scroll · 5-7 = serviceable · <5 = the AI is telling
        // you this clip has no real hook, so make that read differently.
        str.className = "badge " + (it.strength >= 8 ? "repeat" : "filler");
        str.textContent = it.strength + "/10 ";
        str.title = it.strength >= 8 ? "Strong — passes the hook tests"
          : (it.strength >= 5 ? "Serviceable, but a bit generic" : "The AI says this clip has no real hook in it");
        head.appendChild(str);
      }
      // The AI's quoted words didn't match the indices it gave; we snapped the
      // range to the words it actually meant. Worth knowing before you cut.
      if (it.corrected) {
        var fix = document.createElement("span");
        fix.className = "badge";
        fix.textContent = "↺ realigned ";
        fix.title = "The AI's word indices didn't match the line it quoted — the range was snapped to the quoted words.";
        head.appendChild(fix);
      }
      // Lifting the clip's own opening to the front would play the same line
      // twice — call it out loudly; these are left unticked.
      if (it.nearStart) {
        var warn = document.createElement("span");
        warn.className = "badge repeat";
        warn.textContent = "⚠ opens the clip ";
        warn.title = "This is the clip's opening line — moving it to the top would repeat the same sentence back to back.";
        head.appendChild(warn);
      }
      mid.appendChild(head);

      var q = document.createElement("div");
      q.className = "qline"; q.textContent = "“" + it.quote + "”";
      mid.appendChild(q);
      if (it.reason) {
        var why = document.createElement("div");
        why.className = "ctx"; why.style.marginTop = "3px"; why.textContent = it.reason;
        mid.appendChild(why);
      }

      var ctrls = document.createElement("span");
      ctrls.className = "ctrls";
      var meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = fmtTime(it.seqStart) + " · " + (it.seqEnd - it.seqStart).toFixed(1) + "s";
      ctrls.appendChild(meta);

      row.appendChild(cb); row.appendChild(mid); row.appendChild(ctrls);
      hkEls.list.appendChild(row);
      if (hk.selected[idx]) { on++; }
    });
    var clips = {};
    hk.items.forEach(function (it) { clips[it.clipIndex] = true; });
    hkEls.summary.textContent = on + " of " + hk.items.length + " hooks ticked · " +
      Object.keys(clips).length + " clip(s)";
    if (hkEls.editBtn) { hkEls.editBtn.classList.toggle("hidden", !hk.manual); }
  }

  function hkShow(items) {
    hk.items = items || [];
    // Tick the best USABLE candidate per clip; extras and any flagged
    // "opens the clip" pick stay unticked (items are already sorted that way).
    var seen = {};
    hk.selected = hk.items.map(function (it) {
      if (seen[it.clipIndex] || it.nearStart) { return false; }
      seen[it.clipIndex] = true; return true;
    });
    if (hk.items.length === 0) {
      hkEls.reviewCard.classList.add("hidden");
      setStatus("The AI didn't find a usable hook — try Best accuracy, or Claude if you're on the local brain.", "ok");
      return;
    }
    hkRender();
    hkEls.reviewCard.classList.remove("hidden");
    var flagged = hk.items.filter(function (it) { return it.nearStart; }).length;
    var fixed = hk.items.filter(function (it) { return it.corrected; }).length;
    var weak = hk.items.filter(function (it) { return it.strength && it.strength < 5; }).length;
    var msg = "Found " + hk.items.length + " hook(s) — click one to preview it, tick what you want, then Mark.";
    if (flagged) {
      msg += " " + flagged + " picked the clip's own opening (⚠) — left unticked, since moving those to the " +
        "front would play the same line twice.";
    }
    if (fixed) { msg += " " + fixed + " range(s) realigned to the words the AI actually quoted."; }
    if (weak) { msg += " " + weak + " scored under 5 — the AI is saying those clips have no real hook."; }
    setStatus(msg, flagged ? "err" : "ok");
  }

  function hkExtract(usable) {
    var brain = (hkEls.brain && hkEls.brain.value) || "manual";
    hk.manual = null;
    if (brain === "manual") {
      setStatus("Copy the prompt into claude.ai, then paste the reply.", "busy");
      var prompt = QCAi.buildHookPrompt(usable, aiContext(), hkEls.perClip.value);
      hk.manual = { prompt: prompt, clips: usable, reply: "" };
      return manualClaude(prompt, function (reply) {
        hk.manual.reply = reply;
        return QCAi.parseHooks(reply, usable);
      });
    }
    setStatus(brain === "claude-api" ? "Asking Claude for the hooks…" : "Asking the local AI for the hooks…", "busy");
    return QCAi.findHooks({
      brain: brain, apiKey: brainGet().apiKey, // shared key, only used on claude-api
      ollamaExe: ollamaExe(), modelsDir: ollamaModelsDir(), model: LLM_MODEL,
      clips: usable, context: aiContext(), perClip: hkEls.perClip.value
    });
  }

  function hkScan() {
    if (!QCAudio.nodeAvailable() || !QCAi.nodeAvailable()) {
      setStatus("Node.js isn't enabled — restart Premiere after running setup.ps1.", "err");
      return;
    }
    hkEls.scanBtn.disabled = true;
    hkEls.reviewCard.classList.add("hidden");
    var quality = hkEls.quality.value || "small.en";
    setStatus("Reading the clips on this sequence", "busy");

    host("qcGetVideoClips()").then(function (res) {
      if (!res.ok) { throw new Error(res.error); }
      if (!res.clips || res.clips.length === 0) {
        throw new Error("Put your short clips on the sequence first (one clip per short).");
      }
      return QCAudio.transcribePerClip({
        whisperPath: whisperPath(), ffmpegPath: ffmpegPath(), clips: res.clips, model: quality,
        onProgress: function (i, n) { setStatus(n > 1 ? ("Transcribing clip " + (i + 1) + " of " + n + "…") : "Transcribing…", "busy"); }
      });
    }).then(function (perClip) {
      var usable = perClip.filter(function (c) { return c.words && c.words.length > 0; });
      if (usable.length === 0) { throw new Error("No speech found in these clips."); }
      return hkExtract(usable);
    }).then(function (items) {
      hkEls.scanBtn.disabled = false;
      hkShow(items);
    }).catch(function (err) {
      hkEls.scanBtn.disabled = false;
      setStatus(err.message || String(err), "err");
    });
  }

  // "start,end|note;…" for the ticked hooks — note carries the quote so the
  // marker comment tells you what's there without reopening the panel.
  function hkSpec() {
    return hk.items.filter(function (it, i) {
      return hk.selected[i] && it.seqEnd > it.seqStart;
    }).map(function (it) {
      var bits = [];
      if (it.strength) { bits.push(it.strength + "/10"); }
      if (it.type) { bits.push(it.type); }
      var note = (bits.length ? bits.join(" ") + " - " : "") + "'" + it.quote + "'" +
        (it.reason ? " - " + it.reason : "");
      note = note.replace(/[;|,\r\n]+/g, " ").trim().slice(0, 220);
      return it.seqStart.toFixed(3) + "," + it.seqEnd.toFixed(3) + "|" + note;
    }).join(";");
  }

  function hkMark() {
    var spec = hkSpec();
    if (!spec) { setStatus("Tick at least one hook to mark.", "err"); return; }
    hkEls.markBtn.disabled = true;
    setStatus("Dropping hook markers", "busy");
    var color = parseInt(hkEls.color.value, 10);
    if (isNaN(color)) { color = 1; }
    host('qcAddRangeMarkers("' + jsxEscape(spec) + '",' + color + ',"Hook")').then(function (res) {
      hkEls.markBtn.disabled = false;
      if (!res.ok) { setStatus(res.error || "Could not add markers.", "err"); return; }
      // Two markers per hook: "Hook N" at the in, "Hook N out" at the out.
      var msg = "Marked " + res.count + " hook(s) — “Hook N” at the in point and “Hook N out” at the out, " +
        "so you can jump between them and make the cut.";
      if (res.spans === res.count && res.count) {
        msg += " The in marker also spans the range on the ruler.";
      }
      setStatus(msg, "ok");
    }).catch(function (err) {
      hkEls.markBtn.disabled = false;
      setStatus(err.message || String(err), "err");
    });
  }

  hkEls.scanBtn.addEventListener("click", hkScan);
  hkEls.markBtn.addEventListener("click", hkMark);
  hkEls.closeBtn.addEventListener("click", function () { hkEls.reviewCard.classList.add("hidden"); });
  hkEls.editBtn.addEventListener("click", function () {
    manualEdit(hk.manual, function (reply) { return QCAi.parseHooks(reply, hk.manual.clips); })
      .then(function (items) {
        if (!items || items.length === 0) { setStatus("That reply has no hooks — edit it again.", "ok"); return; }
        hkShow(items);
      }).catch(function (err) { setStatus(err.message || String(err), "err"); });
  });
  bindDrawer(hkEls.settings, hkEls.settingsToggle);

  /* ===================================================================
   * SETUP TAB — one-time engine install. Everything here is filesystem-only
   * until the user clicks Download; a complete install never hits the network,
   * and the engines live outside the extension so an update can't wipe them.
   * =================================================================== */
  var enEls = {
    tab: document.getElementById("setupTab"),
    list: document.getElementById("enList"),
    installBtn: document.getElementById("enInstallBtn"),
    recheckBtn: document.getElementById("enRecheckBtn"),
    where: document.getElementById("enWhere"),
    hint: document.getElementById("enHint")
  };

  function enFmtSize(mb) {
    return (mb >= 1024) ? (mb / 1024).toFixed(1) + " GB" : mb + " MB";
  }

  function enRender() {
    var st = QCEngines.status();
    enEls.list.innerHTML = "";
    var missing = 0, missingMb = 0;

    st.forEach(function (s) {
      var row = document.createElement("div");
      row.className = "cut-row" + (s.ok ? "" : " off");
      row.style.gridTemplateColumns = "auto 1fr auto";

      var mark = document.createElement("span");
      mark.className = "badge " + (s.ok ? "" : "repeat");
      mark.textContent = s.ok ? "✓" : "—";

      var mid = document.createElement("div");
      var head = document.createElement("span");
      head.className = "range";
      head.textContent = s.label + " ";
      if (s.optional && !s.ok) {
        var opt = document.createElement("span");
        opt.className = "badge"; opt.textContent = "optional ";
        head.appendChild(opt);
      }
      if (s.legacy) {
        var leg = document.createElement("span");
        leg.className = "badge filler"; leg.textContent = "Intel build ";
        leg.title = "No current macOS build is published; this is the last one released (Intel — runs under Rosetta 2 on Apple Silicon).";
        head.appendChild(leg);
      }
      if (s.inRepo) {
        var dev = document.createElement("span");
        dev.className = "badge"; dev.textContent = "from repo bin/ ";
        dev.title = "Found in this checkout's bin/ folder — nothing to download.";
        head.appendChild(dev);
      }
      mid.appendChild(head);

      var why = document.createElement("div");
      why.className = "ctx"; why.style.marginTop = "3px";
      why.textContent = s.ok ? s.path : s.why;
      mid.appendChild(why);

      // Download size and installed size differ a lot (Whisper is a 1.4 GB
      // archive that unpacks to ~4.4 GB), and some engines fetch more on first
      // real use — say all of it rather than quoting the flattering number.
      if (!s.ok) {
        var sizes = document.createElement("div");
        sizes.className = "ctx"; sizes.style.marginTop = "2px";
        var txt = enFmtSize(s.sizeMb) + " download · " + enFmtSize(s.diskMb) + " on disk";
        if (s.lazyNote) { txt += " · then " + s.lazyNote; }
        sizes.textContent = txt;
        mid.appendChild(sizes);
      }

      var meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = s.ok ? "installed" : enFmtSize(s.sizeMb);

      row.appendChild(mark); row.appendChild(mid); row.appendChild(meta);
      enEls.list.appendChild(row);

      if (!s.ok) { missing++; missingMb += s.sizeMb; }
    });

    enEls.where.textContent = "Kept in: " + userRoot();
    enEls.installBtn.disabled = (missing === 0);
    enEls.installBtn.textContent = missing
      ? ("Download " + missing + " missing component(s) — " + enFmtSize(missingMb))
      : "Everything is installed";
    // The tab only earns a place in the bar when there's something to do.
    if (enEls.tab) { enEls.tab.classList.toggle("suggest", missing > 0); }
    return st;
  }

  function enInstallAll() {
    var todo = QCEngines.status().filter(function (s) { return !s.ok; });
    if (todo.length === 0) { setStatus("Everything's already installed — nothing to download.", "ok"); return; }
    enEls.installBtn.disabled = true;
    enEls.recheckBtn.disabled = true;

    var chain = Promise.resolve(), done = 0, failures = [];
    todo.forEach(function (s) {
      chain = chain.then(function () {
        return QCEngines.install(s.name, function (p) {
          var head = "Installing " + s.label + " (" + (done + 1) + " of " + todo.length + ") — ";
          if (p.phase === "download") { setStatus(head + "downloading " + (p.pct || 0) + "%", "busy"); }
          else if (p.phase === "extract") { setStatus(head + "unpacking… (this can take a minute)", "busy"); }
        }).then(function () { done++; enRender(); })
          .catch(function (e) {
            // One failure shouldn't abandon the rest.
            failures.push(s.label + ": " + (e.message || e));
          });
      });
    });

    chain.then(function () {
      enEls.installBtn.disabled = false;
      enEls.recheckBtn.disabled = false;
      enRender();
      if (failures.length === 0) {
        setStatus("Done — " + done + " component(s) installed. This was one time only; Naifu won't " +
          "download them again.", "ok");
      } else {
        setStatus(done + " installed, " + failures.length + " failed. " + failures.join(" · "), "err");
      }
    });
  }

  if (enEls.installBtn) { enEls.installBtn.addEventListener("click", enInstallAll); }
  if (enEls.recheckBtn) {
    enEls.recheckBtn.addEventListener("click", function () {
      enRender();
      setStatus(QCEngines.ready() ? "All required components are present." : "Some components are still missing.",
        QCEngines.ready() ? "ok" : "err");
    });
  }

  /* ===================================================================
   * SPEAKER TAB — pull name / company / title from the transcript, then
   * open a Google search for the person's LinkedIn. Fields are editable
   * because the AI (and Whisper) can mishear names and companies.
   * =================================================================== */
  var SP_KEY = "quietcut.speaker.v1";
  var sp = { people: [], manual: null };
  var spEls = {
    scanBtn: document.getElementById("spScanBtn"),
    settings: document.getElementById("spSettings"),
    settingsToggle: document.getElementById("spSettingsToggle"),
    brain: document.getElementById("spBrain"),
    quality: document.getElementById("spQuality"),
    reviewCard: document.getElementById("spReviewCard"),
    summary: document.getElementById("spSummary"),
    list: document.getElementById("spList"),
    editBtn: document.getElementById("spEditBtn")
  };

  // Speaker has its OWN brain setting (default local/qwen), independent of the
  // shared brain — name/title extraction is light work that shouldn't hit Claude.
  function spLoad() {
    var v = {};
    try { v = JSON.parse(localStorage.getItem(SP_KEY)) || {}; } catch (e) {}
    if (v.quality) { spEls.quality.value = v.quality; }
    spEls.brain.value = v.brain || "local";
  }
  function spSave() {
    try { localStorage.setItem(SP_KEY, JSON.stringify({ quality: spEls.quality.value, brain: spEls.brain.value })); } catch (e) {}
  }
  spEls.quality.addEventListener("change", spSave);
  spEls.brain.addEventListener("change", spSave);

  // Build a Google query that surfaces the person's LinkedIn.
  function linkedinSearchUrl(p) {
    var terms = [];
    if (p.name) { terms.push('"' + p.name + '"'); }
    if (p.company) { terms.push(p.company); }
    if (p.title) { terms.push(p.title); }
    terms.push("LinkedIn");
    return "https://www.google.com/search?q=" + encodeURIComponent(terms.join(" "));
  }

  function spRender() {
    spEls.list.innerHTML = "";
    sp.people.forEach(function (p) {
      var card = document.createElement("div");
      card.className = "person";

      function mkField(labelText, key, holder) {
        var wrap = document.createElement("div");
        var lab = document.createElement("label"); lab.textContent = labelText;
        var inp = document.createElement("input");
        inp.type = "text"; inp.value = p[key] || ""; inp.placeholder = holder || "";
        inp.addEventListener("input", function () { p[key] = inp.value; });
        wrap.appendChild(lab); wrap.appendChild(inp);
        return wrap;
      }

      card.appendChild(mkField("Name", "name", "Full name"));
      var two = document.createElement("div"); two.className = "two";
      two.appendChild(mkField("Title / designation", "title", "e.g. Head of Design"));
      two.appendChild(mkField("Company", "company", "e.g. Acme"));
      card.appendChild(two);

      var btn = document.createElement("button");
      btn.className = "primary"; btn.type = "button";
      btn.textContent = "Find on LinkedIn";
      btn.addEventListener("click", function () {
        if (!p.name && !p.company) { setStatus("Add at least a name or company to search.", "err"); return; }
        var url = linkedinSearchUrl(p);
        var ok = openExternal(url);
        setStatus(ok
          ? "Opened a LinkedIn search for " + (p.name || p.company) + " in your browser."
          : "Couldn't open a browser — search this manually: " + url, ok ? "ok" : "err");
      });
      card.appendChild(btn);

      spEls.list.appendChild(card);
    });
    spEls.summary.textContent = sp.people.length + " person(s) — edit if needed, then Find on LinkedIn";
    if (spEls.editBtn) { spEls.editBtn.classList.toggle("hidden", !sp.manual); }
  }

  function spShow(people) {
    sp.people = people || [];
    if (sp.people.length === 0) {
      spEls.reviewCard.classList.add("hidden");
      setStatus("Couldn't find a name/company/title — try Best accuracy, or check the speaker introduces themselves.", "ok");
      return;
    }
    spRender();
    spEls.reviewCard.classList.remove("hidden");
    setStatus("Found " + sp.people.length + " person(s). Edit if needed, then Find on LinkedIn.", "ok");
  }

  // Ask the Speaker tab's own brain (default local/qwen) to pull people from a
  // set of transcript segments.
  function spExtract(segments) {
    var brain = (spEls.brain && spEls.brain.value) || "local";
    sp.manual = null;
    if (brain === "manual") {
      setStatus("Copy the prompt into claude.ai, then paste the reply.", "busy");
      var prompt = QCAi.buildSpeakerPrompt(segments, aiContext());
      sp.manual = { prompt: prompt, reply: "" };
      return manualClaude(prompt, function (reply) {
        sp.manual.reply = reply;
        return QCAi.parseSpeakers(reply);
      });
    }
    setStatus(brain === "claude-api" ? "Asking Claude who's speaking…" : "Reading names with the local AI (qwen)…", "busy");
    return QCAi.findSpeakers({
      brain: brain, apiKey: brainGet().apiKey, // reuse the shared key only if switched to API
      ollamaExe: ollamaExe(), modelsDir: ollamaModelsDir(), model: LLM_MODEL,
      segments: segments, context: aiContext()
    });
  }
  function spHasName(people) {
    return !!(people && people.some(function (p) { return p.name; }));
  }

  function spScan() {
    if (!QCAudio.nodeAvailable() || !QCAi.nodeAvailable()) {
      setStatus("Node.js isn't enabled — restart Premiere after running setup.ps1.", "err");
      return;
    }
    spEls.scanBtn.disabled = true;
    spEls.reviewCard.classList.add("hidden");
    sp.manual = null;
    var quality = spEls.quality.value || "small.en";
    var INTRO_SEC = 10; // people almost always introduce themselves up front
    var clips;
    setStatus("Reading audio clips", "busy");

    host("qcGetAudioClips()").then(function (res) {
      if (!res.ok) { throw new Error(res.error); }
      if (!res.clips || res.clips.length === 0) { throw new Error("No audio clips with media on the sequence."); }
      clips = res.clips;
      // Phase 1: transcribe just the first ~10s (the intro) to save time.
      setStatus("Transcribing the first " + INTRO_SEC + "s…", "busy");
      return QCAudio.transcribeSegments({
        whisperPath: whisperPath(), ffmpegPath: ffmpegPath(),
        clips: clips, model: quality, limitSec: INTRO_SEC
      });
    }).then(function (introSegs) {
      // If the intro had speech, try to read the speaker from it first.
      if (introSegs && introSegs.length > 0) { return spExtract(introSegs); }
      return null;
    }).then(function (people) {
      if (spHasName(people)) { spEls.scanBtn.disabled = false; spShow(people); return; }
      // Phase 2 (fallback): the intro didn't name anyone — transcribe the whole
      // sequence and try again.
      setStatus("No name in the intro — transcribing the whole sequence…", "busy");
      return QCAudio.transcribeSegments({
        whisperPath: whisperPath(), ffmpegPath: ffmpegPath(),
        clips: clips, model: quality, onProgress: transcribeProgress("Transcribing")
      }).then(function (allSegs) {
        if (!allSegs || allSegs.length === 0) { throw new Error("No speech found to analyze."); }
        return spExtract(allSegs);
      }).then(function (people2) {
        spEls.scanBtn.disabled = false;
        spShow(people2);
      });
    }).catch(function (err) {
      spEls.scanBtn.disabled = false;
      setStatus(err.message || String(err), "err");
    });
  }

  spEls.scanBtn.addEventListener("click", spScan);
  spEls.editBtn.addEventListener("click", function () {
    manualEdit(sp.manual, function (reply) { return QCAi.parseSpeakers(reply); })
      .then(function (people) {
        if (!people || people.length === 0) { setStatus("That reply has no people — edit it again.", "ok"); return; }
        spShow(people);
      }).catch(function (err) { setStatus(err.message || String(err), "err"); });
  });
  bindDrawer(spEls.settings, spEls.settingsToggle);

  /* ---------- init ---------- */
  silLoadSettings();
  zoomLoadSettings();
  filLoadSettings();
  hlLoadSettings();
  clLoadSettings();
  qcLoadSettings();
  vpLoadSettings();
  cpLoad();
  capLoad();
  spLoad();
  stLoad();
  hkLoad();
  brainInit();
  contextInit();
  // First-run model download: when a local scan needs qwen and it isn't installed,
  // Ollama fetches it once; show the progress so a big one-time download is clear.
  QCAi.onPullProgress(function (status, pct) {
    var msg = "First-time setup: downloading the local AI model (one time, ~4.7 GB)";
    if (pct != null) { msg += " — " + pct + "%"; }
    else if (status) { msg += " — " + status; }
    setStatus(msg + "…", "busy");
  });
  refreshActiveName();
  host("ping()").then(function (res) {
    if (!res.ok) {
      // ping() only reads app.name, so a failure means the host engine didn't
      // load — not just "no sequence". Point the user at the fix.
      setStatus(res.error || RELOAD_HINT, "err");
      return;
    }
    if (!QCAudio.nodeAvailable()) {
      setStatus("Connected, but Node.js is off — silence, fillers, zoom-by-AI and transcript features won't run. Run setup.ps1 and restart Premiere.", "err");
      return;
    }
    // Engine check is a plain filesystem look — no network, no download, every
    // run. Only if something is genuinely missing do we say anything about it.
    enRender();
    var missing = QCEngines.status().filter(function (s) { return !s.ok && !s.optional; });
    if (missing.length) {
      setStatus("Ready, but " + missing.length + " component(s) still need a one-time download — " +
        "open the Setup tab.", "err");
      tabFor("setup");
      return;
    }

    setStatus("Ready — connected to " + (res.app || "Premiere") + ". Open a sequence to begin.");
    // Warm the local model in the background so the first local-AI call (Speaker,
    // Cleanup, etc.) is instant instead of waiting on a cold model load. Skipped
    // entirely when Ollama isn't installed, so it can't trigger a download.
    if (QCEngines.have("ollama")) {
      QCAi.preloadModel({ ollamaExe: ollamaExe(), modelsDir: ollamaModelsDir(), model: LLM_MODEL });
    }
  });
})();
