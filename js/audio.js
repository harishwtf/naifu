/*
 * Naifu - audio analysis (Phase 1).
 *
 * Runs FFmpeg's `silencedetect` filter on each audio clip's source media (via
 * CEP's built-in Node.js), then maps the detected silences back onto the
 * sequence timeline. No Premiere export and no preset needed — we read the
 * original media file directly off the timeline clips.
 */
var QCAudio = (function () {
  "use strict";

  // Reach Node regardless of CEP's context mode.
  var nodeRequire =
    (typeof require === "function") ? require :
    (typeof cep_node !== "undefined" && cep_node.require) ? cep_node.require :
    null;

  function nodeAvailable() {
    return !!nodeRequire;
  }

  // Plain-English message when a bundled tool isn't where we expect it. These
  // are the most common "it doesn't work" cases for a fresh install, so the
  // wording tells the user exactly what to do rather than dumping a path.
  var MISSING_HELP = {
    ffmpeg: "FFmpeg isn't installed yet. Run setup.ps1 in the Naifu folder, then restart Premiere.",
    whisper: "The speech engine (Faster-Whisper) isn't installed yet. See the README for the one-time download into bin\\, then restart Premiere."
  };
  function binMissing(kind) {
    return new Error(MISSING_HELP[kind] || (kind + " is missing."));
  }

  /**
   * execFile can fail two ways: an error handed to the callback, or a
   * SYNCHRONOUS throw (spawn EINVAL / UNKNOWN) when the target isn't a runnable
   * executable at all — which is exactly what a corrupt or Gatekeeper-blocked
   * binary does. Funnel both into the callback so one error path covers it.
   */
  function runProc(exe, args, opts, cb) {
    var execFile = nodeRequire("child_process").execFile;
    try { execFile(exe, args, opts, cb); }
    catch (e) { cb(e, "", ""); }
  }

  /**
   * Turn a failed child process into a message that says what actually went
   * wrong. Without this, every engine failure ends up reported as "no speech
   * found", which sends people hunting for an audio problem that isn't there.
   * The macOS cases (wrong CPU architecture, Gatekeeper, non-executable) are
   * called out by name because they're the common ones and their raw errors
   * are cryptic.
   */
  function procError(label, exe, err, stderr) {
    var tail = String(stderr || "").trim().split("\n").slice(-6).join("\n").slice(-600);
    var msg;

    // Windows reports exit codes as unsigned; -2 arrives as 4294967294.
    var code = (err && typeof err.code === "number") ? err.code : null;
    if (code !== null && code > 2147483647) { code -= 4294967296; }

    if (err && (err.code === "EINVAL" || err.code === "UNKNOWN" || err.code === "ENOEXEC")) {
      msg = label + " couldn't be launched — the file is there but the system refused to run it. " +
        "It may be damaged, blocked, or built for a different platform. On macOS try:  " +
        "xattr -cr \"" + exe + "\" && codesign -s - \"" + exe + "\"  — otherwise delete it and let the " +
        "Setup tab download it again.";
    } else if (err && err.code === "EACCES") {
      msg = label + " isn't executable. On macOS run:  chmod +x \"" + exe + "\"  then clear Gatekeeper with:  " +
        "xattr -cr \"" + exe + "\" && codesign -s - \"" + exe + "\"";
    } else if (err && (err.code === "EBADARCH" || /bad cpu type/i.test(tail))) {
      msg = label + " is built for a different CPU than this Mac. If it's an Intel build on Apple Silicon, " +
        "install Rosetta 2:  softwareupdate --install-rosetta --agree-to-license";
    } else if (err && (err.signal === "SIGKILL" || err.signal === "SIGABRT")) {
      msg = label + " was killed on launch (" + err.signal + ") — usually macOS Gatekeeper blocking an unsigned " +
        "binary. Fix with:  xattr -cr \"" + exe + "\" && codesign -s - \"" + exe + "\"";
    } else if (code !== null) {
      msg = label + " failed (exit code " + code + ").";
    } else if (err) {
      msg = label + " failed to run: " + (err.message || String(err));
    } else {
      msg = label + " produced no usable output.";
    }
    if (tail) { msg += "\n\n" + label + " said:\n" + tail; }
    return new Error(msg);
  }

  /** Run ffmpeg once and hand back its stderr (silencedetect writes there). */
  function runFfmpeg(ffmpegPath, args) {
    return new Promise(function (resolve, reject) {
      // silencedetect output can be long; give it room.
      runProc(ffmpegPath, args, { maxBuffer: 1024 * 1024 * 64 }, function (err, stdout, stderr) {
        // ffmpeg exits 0 here and prints analysis to stderr. A real spawn error
        // (e.g. binary missing) shows up as `err.code === 'ENOENT'`.
        if (err && err.code === "ENOENT") { reject(binMissing("ffmpeg")); return; }
        resolve(stderr || "");
      });
    });
  }

  /**
   * Parse silence_start / silence_end pairs from ffmpeg stderr.
   * Times are relative to the trimmed input (because we seek with -ss before -i),
   * i.e. 0 = the clip's in-point.
   */
  function parseSilences(stderr, clipSourceDuration) {
    var silences = [];
    var lines = stderr.split(/\r?\n/);
    var pendingStart = null;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var mStart = line.match(/silence_start:\s*(-?[\d.]+)/);
      if (mStart) {
        pendingStart = parseFloat(mStart[1]);
        continue;
      }
      var mEnd = line.match(/silence_end:\s*(-?[\d.]+)/);
      if (mEnd && pendingStart !== null) {
        silences.push([Math.max(0, pendingStart), parseFloat(mEnd[1])]);
        pendingStart = null;
      }
    }
    // Silence that runs to the end of the clip has no silence_end line.
    if (pendingStart !== null) {
      silences.push([Math.max(0, pendingStart), clipSourceDuration]);
    }
    return silences;
  }

  /** Merge overlapping/adjacent ranges (after mapping to sequence time). */
  function mergeRanges(ranges) {
    if (ranges.length === 0) { return []; }
    ranges.sort(function (a, b) { return a.start - b.start; });
    var out = [ranges[0]];
    for (var i = 1; i < ranges.length; i++) {
      var last = out[out.length - 1];
      if (ranges[i].start <= last.end + 0.001) {
        last.end = Math.max(last.end, ranges[i].end);
      } else {
        out.push(ranges[i]);
      }
    }
    return out;
  }

  /**
   * Detect silences across all audio clips and return sequence-time cut ranges.
   *
   * @param {object} cfg
   *   ffmpegPath {string}
   *   clips {Array}   from host qcGetAudioClips()
   *   thresholdDb {number}  e.g. -30
   *   minSilenceMs {number} e.g. 500
   *   paddingMs {number}    e.g. 100  (kept as speech, not cut)
   * @returns {Promise<Array<{start,end,duration}>>} sequence-time, padded, merged
   */
  function detectSilences(cfg) {
    var thr = cfg.thresholdDb;
    var minSil = cfg.minSilenceMs / 1000;
    var pad = cfg.paddingMs / 1000;

    var jobs = cfg.clips.map(function (clip) {
      var sourceDur = clip.outSec - clip.inSec;
      if (sourceDur <= 0) { return Promise.resolve([]); }

      var args = [
        "-hide_banner",
        "-ss", String(clip.inSec),
        "-i", clip.mediaPath,
        "-t", String(sourceDur),
        "-vn",
        "-af", "silencedetect=noise=" + thr + "dB:d=" + minSil,
        "-f", "null",
        "-"
      ];

      return runFfmpeg(cfg.ffmpegPath, args).then(function (stderr) {
        var raw = parseSilences(stderr, sourceDur);
        var mapped = [];
        for (var i = 0; i < raw.length; i++) {
          // clip-local time -> sequence time (assumes 100% speed; see README)
          var seqStart = clip.startSec + raw[i][0];
          var seqEnd = clip.startSec + raw[i][1];

          // Leave `pad` of breath on each side so cuts don't clip speech.
          var cutStart = seqStart + pad;
          var cutEnd = seqEnd - pad;
          if (cutEnd - cutStart > 0.02) { // ignore slivers shorter than ~1 frame
            mapped.push({ start: cutStart, end: cutEnd });
          }
        }
        return mapped;
      });
    });

    return Promise.all(jobs).then(function (perClip) {
      var all = [];
      for (var i = 0; i < perClip.length; i++) {
        all = all.concat(perClip[i]);
      }
      var merged = mergeRanges(all);
      for (var j = 0; j < merged.length; j++) {
        merged[j].duration = merged[j].end - merged[j].start;
      }
      return merged;
    });
  }

  /**
   * Measure each clip's mean loudness (dB) over its used source range, using
   * FFmpeg's volumedetect. Used for "smart" zoom placement: louder segment =
   * more likely an emphatic / important moment. Clips with no audio come back
   * very low (~-91 dB) and naturally rank last.
   *
   * @param {object} cfg  ffmpegPath {string}, clips {Array} (from qcGetVideoClips)
   * @returns {Promise<Array<number>>} mean dB per clip, in input order.
   */
  function measureLoudness(cfg) {
    var jobs = cfg.clips.map(function (clip) {
      var sourceDur = clip.outSec - clip.inSec;
      if (sourceDur <= 0 || !clip.mediaPath) { return Promise.resolve(-99); }

      var args = [
        "-hide_banner",
        "-ss", String(clip.inSec),
        "-i", clip.mediaPath,
        "-t", String(sourceDur),
        "-vn",
        "-af", "volumedetect",
        "-f", "null",
        "-"
      ];

      return runFfmpeg(cfg.ffmpegPath, args).then(function (stderr) {
        var m = stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
        return m ? parseFloat(m[1]) : -99;
      }).catch(function () { return -99; });
    });

    return Promise.all(jobs);
  }

  /** Build the "s,e;s,e" string the host expects, from selected ranges. */
  function rangesToString(ranges) {
    return ranges.map(function (r) {
      return r.start.toFixed(3) + "," + r.end.toFixed(3);
    }).join(";");
  }

  /* ---------- zoom moment detection (loudness over time) ---------- */

  /**
   * Get a windowed RMS-loudness series for one clip's source range, in
   * sequence time. Resamples to 48k and reports one RMS value per ~0.2s window.
   * Returns [{ t: sequenceSeconds, rms: dB }].
   */
  function loudnessSeries(ffmpegPath, clip, windowSec) {
    var sourceDur = clip.outSec - clip.inSec;
    if (sourceDur <= 0 || !clip.mediaPath) { return Promise.resolve([]); }
    var n = Math.max(1, Math.round(48000 * windowSec));

    var args = [
      "-hide_banner",
      "-ss", String(clip.inSec),
      "-i", clip.mediaPath,
      "-t", String(sourceDur),
      "-vn",
      "-af", "aresample=48000,asetnsamples=n=" + n + ":p=0," +
             "astats=reset=1:metadata=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
      "-f", "null",
      "-"
    ];

    return runFfmpeg(ffmpegPath, args).then(function (stderr) {
      var series = [];
      var lines = stderr.split(/\r?\n/);
      var pendingT = null;
      for (var i = 0; i < lines.length; i++) {
        var mt = lines[i].match(/pts_time:([\d.]+)/);
        if (mt) { pendingT = parseFloat(mt[1]); continue; }
        var mr = lines[i].match(/RMS_level=(-?[\d.]+|-?inf|nan)/i);
        if (mr && pendingT !== null) {
          var v = parseFloat(mr[1]);
          if (!isFinite(v)) { v = -120; }
          series.push({ t: clip.startSec + pendingT, rms: v });
          pendingT = null;
        }
      }
      return series;
    }).catch(function () { return []; });
  }

  /**
   * Find emphatic moments and hold each zoom until the next natural pause, so a
   * punch-in lasts a whole sentence/phrase rather than a couple of words. Both
   * the emphasis (loud windows) and the pauses (quiet windows) come from the
   * same loudness scan.
   *
   * @param {object} cfg
   *   ffmpegPath {string}, clips {Array} (audio clips, from qcGetAudioClips),
   *   sensitivity {'low'|'med'|'high'}  how far above average counts as emphasis,
   *   maxSec {number}  cap on how long one zoom may run if no pause is found.
   * @returns {Promise<Array<{start,end,peakDb}>>}
   */
  /**
   * The cleanest "the thought finished" anchor for a zoom-out: the END of the
   * first Whisper sentence segment that lands at/after start+minLen AND is a
   * real boundary — i.e. there's a >= gapMin pause before the next sentence
   * starts (or it's the last sentence). Returns sequence-time seconds, or null
   * if there's no transcript / no qualifying boundary. Segments are sequence-time
   * and sorted by start.
   */
  function sentenceRelease(segs, start, minLen, gapMin) {
    if (!segs || !segs.length) { return null; }
    for (var i = 0; i < segs.length; i++) {
      if (segs[i].end < start + minLen) { continue; }     // sentence ends too soon
      var gap = (i + 1 < segs.length) ? (segs[i + 1].start - segs[i].end) : Infinity;
      if (gap >= gapMin) { return segs[i].end; }           // confirmed boundary
    }
    return null;
  }

  function detectSentenceZooms(cfg) {
    var windowSec = 0.2;
    // Sensitivity controls BOTH how loud counts as emphasis and how much normal
    // breathing room to leave between zooms (so they don't run back-to-back).
    var marginDb = cfg.sensitivity === "high" ? 2 : (cfg.sensitivity === "low" ? 6 : 4);
    var minGap   = cfg.sensitivity === "high" ? 3 : (cfg.sensitivity === "low" ? 8 : 5);
    var maxSec = cfg.maxSec || 10;
    // When true (default), the natural pause decides the zoom-out even past the
    // target length, so a sentence finishes instead of snapping out at the cap.
    var holdUntilPause = cfg.holdUntilPause !== false;
    var minZoomSec = 2.5;                    // hold at least this long — no stubs
    var lead = 0.15;                         // start just before the emphasis
    var pauseDrop = 7;                       // dB below average = a pause
    var pauseWindows = Math.max(1, Math.round(0.4 / windowSec)); // real pause ~0.4s

    var jobs = cfg.clips.map(function (c) { return loudnessSeries(cfg.ffmpegPath, c, windowSec); });

    return Promise.all(jobs).then(function (allSeries) {
      var zooms = [];
      cfg.clips.forEach(function (c, idx) {
        var series = allSeries[idx];
        if (series.length === 0) { return; }

        var sum = 0, i;
        for (i = 0; i < series.length; i++) { sum += series[i].rms; }
        var mean = sum / series.length;
        var empThresh = mean + marginDb;     // loud enough to be emphasis
        var pauseThresh = mean - pauseDrop;  // quiet enough to be a pause

        var lastEnd = -Infinity;
        var j = 0;
        while (j < series.length) {
          // Need emphasis AND enough gap since the previous zoom.
          if (series[j].rms < empThresh || series[j].t < lastEnd + minGap) { j++; continue; }

          var start = series[j].t - lead;
          if (start < c.startSec) { start = c.startSec; }

          // Where does the point END? Prefer the END of the Whisper sentence the
          // zoom is on (confirmed by a real >=0.35s gap before the next sentence) —
          // that's the most reliable "the thought finished" anchor and stops the
          // mid-sentence snap-outs a raw loudness dip causes. Fall back to a
          // loudness pause only when there's no transcript boundary to use.
          var cand = sentenceRelease(cfg.segments, start, minZoomSec, 0.35);
          if (cand === null) {
            var run = 0, k = j + 1;
            while (k < series.length) {
              if (series[k].rms < pauseThresh) {
                run++;
                if (run >= pauseWindows) {
                  var c0 = series[k - run + 1].t;
                  if (c0 >= start + minZoomSec) { cand = c0; break; }
                  run = 0; // too early — keep holding through this pause
                }
              } else { run = 0; }
              k++;
            }
          }

          // Decide the zoom-out point. Flexible mode honours the natural pause
          // even a bit past the target (headroom) so a sentence finishes; a
          // pause-less stretch still ends at the target so it can't run away.
          // Strict mode treats the target as a hard cap (old behaviour).
          var end;
          if (holdUntilPause) {
            var headroom = Math.max(6, maxSec * 0.5);
            end = (cand !== null && cand <= start + maxSec + headroom) ? cand : (start + maxSec);
          } else {
            end = (cand !== null && cand <= start + maxSec) ? cand : (start + maxSec);
          }
          if (end > c.endSec) { end = c.endSec; }

          if (end - start >= minZoomSec - 0.2) {
            zooms.push({ start: start, end: end, peakDb: series[j].rms });
            lastEnd = end;
            while (j < series.length && series[j].t < end) { j++; }
          } else {
            j++;
          }
        }
      });
      zooms.sort(function (a, b) { return a.start - b.start; });
      return zooms;
    });
  }

  /* ---------- transcription (Whisper) + filler/repetition detection ---------- */

  /**
   * Extract one clip's used range to a 16k mono WAV (what Whisper wants).
   * `maxDur` (optional) caps the extracted duration in clip-local seconds — used
   * to transcribe only the first part of a clip (e.g. the intro) to save time.
   */
  function extractWav(ffmpegPath, clip, outWav, maxDur) {
    var dur = clip.outSec - clip.inSec;
    if (typeof maxDur === "number" && maxDur > 0 && maxDur < dur) { dur = maxDur; }
    var args = [
      "-hide_banner", "-y",
      "-ss", String(clip.inSec), "-i", clip.mediaPath, "-t", String(dur),
      "-vn", "-ac", "1", "-ar", "16000", outWav
    ];
    return new Promise(function (resolve, reject) {
      var fs = nodeRequire("fs");
      runProc(ffmpegPath, args, { maxBuffer: 1024 * 1024 * 16 }, function (err, stdout, stderr) {
        if (err && err.code === "ENOENT") { reject(binMissing("ffmpeg")); return; }
        if (err) { reject(procError("FFmpeg", ffmpegPath, err, stderr)); return; }
        // FFmpeg can exit 0 having written nothing — offline/unreadable media, or
        // a clip with no audio track. Catch it here instead of letting it surface
        // later as the misleading "no speech found".
        var size = 0;
        try { size = fs.statSync(outWav).size; } catch (e) {}
        if (size < 1024) {
          reject(new Error("FFmpeg read no audio from this clip — check the media is online and has an audio " +
            "track.\n" + (clip.mediaPath || "(no media path)")));
          return;
        }
        resolve(outWav);
      });
    });
  }

  /**
   * Run the standalone Whisper on a WAV, producing <name>.json in outDir.
   *
   * Verifies the JSON actually landed. Whisper exits non-zero on harmless
   * warnings so the exit code alone can't be trusted — but "no JSON on disk"
   * always means the engine failed, and that must never be reported as silence.
   */
  function runWhisper(whisperPath, wavPath, model, outDir) {
    var args = [
      wavPath, "-m", model, "-l", "en",
      "--output_format", "json", "--output_dir", outDir,
      "--word_timestamps", "True"
    ];
    var fs = nodeRequire("fs");
    var base = String(wavPath).split(/[\\/]/).pop().replace(/\.wav$/i, "");
    var jsonPath = String(outDir).replace(/[\\/]+$/, "") + "/" + base + ".json";
    return new Promise(function (resolve, reject) {
      // No timeout: first run downloads the speech model and can take a while.
      runProc(whisperPath, args, { maxBuffer: 1024 * 1024 * 64 }, function (err, stdout, stderr) {
        if (err && err.code === "ENOENT") { reject(binMissing("whisper")); return; }
        var wrote = false;
        try { wrote = fs.statSync(jsonPath).size > 0; } catch (e) {}
        if (wrote) { resolve(jsonPath); return; }
        reject(procError("The speech engine (Whisper)", whisperPath, err,
          (stderr || "") + "\n" + (stdout || "")));
      });
    });
  }

  /**
   * Launch each engine with a harmless flag to prove it can actually run, and
   * report the real reason if it can't (Rosetta, Gatekeeper, permissions).
   * Beats discovering it as a vague failure halfway through a transcription.
   */
  function testEngines(cfg) {
    function probe(label, exe, args) {
      return new Promise(function (resolve) {
        if (!exe) { resolve({ label: label, ok: false, detail: "No path configured." }); return; }
        runProc(exe, args, { maxBuffer: 1024 * 1024 * 8, timeout: 60000 }, function (err, stdout, stderr) {
          var out = ((stdout || "") + "\n" + (stderr || "")).trim();
          if (err && err.code === "ENOENT") {
            resolve({ label: label, ok: false, detail: "Not found at " + exe });
            return;
          }
          // Any banner at all means it launched — exit code doesn't matter here.
          if (out) {
            resolve({ label: label, ok: true, detail: out.split("\n")[0].slice(0, 140) });
            return;
          }
          resolve({ label: label, ok: false, detail: procError(label, exe, err, stderr).message });
        });
      });
    }
    return Promise.all([
      probe("FFmpeg", cfg.ffmpegPath, ["-version"]),
      probe("Whisper", cfg.whisperPath, ["--help"])
    ]);
  }

  /**
   * Transcribe all audio clips and return a flat, time-sorted word list mapped
   * to sequence time: [{ text, start, end }]. Clips are done one at a time
   * (Whisper is heavy).
   *
   * @param {object} cfg  whisperPath, ffmpegPath, clips, model
   */
  function transcribe(cfg) {
    var fs = nodeRequire("fs");
    var path = nodeRequire("path");
    var os = nodeRequire("os");
    var tmp = path.join(os.tmpdir(), "quietcut-stt");
    try { fs.mkdirSync(tmp, { recursive: true }); } catch (e) {}

    var words = [];
    var chain = Promise.resolve();
    cfg.clips.forEach(function (clip, idx) {
      chain = chain.then(function () {
        if (!clip.mediaPath || (clip.outSec - clip.inSec) <= 0) { return; }
        var wav = path.join(tmp, "clip" + idx + ".wav");
        var jsonPath = path.join(tmp, "clip" + idx + ".json");
        return extractWav(cfg.ffmpegPath, clip, wav)
          .then(function () { return runWhisper(cfg.whisperPath, wav, cfg.model, tmp); })
          .then(function () {
            var raw;
            try { raw = fs.readFileSync(jsonPath, "utf8"); } catch (e) { return; }
            var data; try { data = JSON.parse(raw); } catch (e) { return; }
            var segs = data.segments || [];
            for (var s = 0; s < segs.length; s++) {
              var ws = segs[s].words || [];
              for (var w = 0; w < ws.length; w++) {
                var tw = ws[w];
                var txt = (tw.word != null) ? tw.word : tw.text;
                if (txt == null || tw.start == null || tw.end == null) { continue; }
                // clip-local time -> sequence time (assumes 100% speed)
                words.push({ text: txt, start: clip.startSec + tw.start, end: clip.startSec + tw.end });
              }
            }
          });
      });
    });
    return chain.then(function () {
      words.sort(function (a, b) { return a.start - b.start; });
      return words;
    });
  }

  /**
   * Transcribe to sentence-level SEGMENTS (not words), mapped to sequence time:
   * [{ text, start, end }]. Used by the Highlights brain so it reads coherent
   * sentences. Same Whisper run as transcribe(), just reads `segments`.
   */
  function transcribeSegments(cfg) {
    var fs = nodeRequire("fs");
    var path = nodeRequire("path");
    var os = nodeRequire("os");
    var tmp = path.join(os.tmpdir(), "quietcut-stt");
    try { fs.mkdirSync(tmp, { recursive: true }); } catch (e) {}

    var segs = [];
    var chain = Promise.resolve();
    cfg.clips.forEach(function (clip, idx) {
      chain = chain.then(function () {
        if (cfg.onProgress) { cfg.onProgress(idx, cfg.clips.length); }
        if (!clip.mediaPath || (clip.outSec - clip.inSec) <= 0) { return; }
        // Optional cap: transcribe only up to `limitSec` of SEQUENCE time (the
        // Speaker tab reads just the intro first). Clips entirely past the window
        // are skipped; a clip straddling it is trimmed to the boundary.
        var maxDur;
        if (cfg.limitSec) {
          var ss = (typeof clip.startSec === "number") ? clip.startSec : 0;
          if (ss >= cfg.limitSec) { return; }
          maxDur = cfg.limitSec - ss;
        }
        var wav = path.join(tmp, "seg" + idx + ".wav");
        var jsonPath = path.join(tmp, "seg" + idx + ".json");
        return extractWav(cfg.ffmpegPath, clip, wav, maxDur)
          .then(function () { return runWhisper(cfg.whisperPath, wav, cfg.model, tmp); })
          .then(function () {
            var raw;
            try { raw = fs.readFileSync(jsonPath, "utf8"); } catch (e) { return; }
            var data; try { data = JSON.parse(raw); } catch (e) { return; }
            var list = data.segments || [];
            for (var s = 0; s < list.length; s++) {
              var seg = list[s];
              if (seg.text == null || seg.start == null || seg.end == null) { continue; }
              var txt = String(seg.text).trim();
              if (!txt) { continue; }
              segs.push({ text: txt, start: clip.startSec + seg.start, end: clip.startSec + seg.end });
            }
          });
      });
    });
    return chain.then(function () {
      segs.sort(function (a, b) { return a.start - b.start; });
      return segs;
    });
  }

  /**
   * Transcribe a set of clips, keeping each clip's transcript SEPARATE (for the
   * Vox Pop builder, where each clip is one interview). Returns one entry per
   * clip: { clip, segments: [...], words: [{text, srcStart, srcEnd, seqStart, seqEnd}] }.
   * `words` carries per-WORD timestamps so the AI can pick a precise, tightly
   * trimmed sub-segment (not just whole sentences). srcStart/End = time in the
   * source file; seqStart/End = time on the sequence.
   *
   * @param {object} cfg  whisperPath, ffmpegPath, model, clips (from qcGetVideoClips),
   *                      onProgress?(doneIndex, total)
   */
  function transcribePerClip(cfg) {
    var fs = nodeRequire("fs");
    var path = nodeRequire("path");
    var os = nodeRequire("os");
    var tmp = path.join(os.tmpdir(), "quietcut-stt");
    try { fs.mkdirSync(tmp, { recursive: true }); } catch (e) {}

    var results = cfg.clips.map(function () { return null; });
    var chain = Promise.resolve();
    cfg.clips.forEach(function (clip, idx) {
      chain = chain.then(function () {
        if (cfg.onProgress) { cfg.onProgress(idx, cfg.clips.length); }
        if (!clip.mediaPath || (clip.outSec - clip.inSec) <= 0) {
          results[idx] = { clip: clip, segments: [], words: [] };
          return;
        }
        var wav = path.join(tmp, "vp" + idx + ".wav");
        var jsonPath = path.join(tmp, "vp" + idx + ".json");
        return extractWav(cfg.ffmpegPath, clip, wav)
          .then(function () { return runWhisper(cfg.whisperPath, wav, cfg.model, tmp); })
          .then(function () {
            var segs = [], words = [];
            var raw;
            try { raw = fs.readFileSync(jsonPath, "utf8"); } catch (e) { results[idx] = { clip: clip, segments: [], words: [] }; return; }
            var data; try { data = JSON.parse(raw); } catch (e) { results[idx] = { clip: clip, segments: [], words: [] }; return; }
            (data.segments || []).forEach(function (s) {
              if (s.text != null && s.start != null && s.end != null) {
                var txt = String(s.text).trim();
                if (txt) {
                  segs.push({
                    text: txt,
                    srcStart: clip.inSec + s.start, srcEnd: clip.inSec + s.end,
                    seqStart: clip.startSec + s.start, seqEnd: clip.startSec + s.end
                  });
                }
              }
              // Per-word stamps so the AI can trim a soundbite to the exact words.
              (s.words || []).forEach(function (w) {
                var wt = (w.word != null) ? w.word : w.text;
                if (wt == null || w.start == null || w.end == null) { return; }
                wt = String(wt).trim();
                if (!wt) { return; }
                words.push({
                  text: wt,
                  srcStart: clip.inSec + w.start, srcEnd: clip.inSec + w.end,
                  seqStart: clip.startSec + w.start, seqEnd: clip.startSec + w.end
                });
              });
            });
            results[idx] = { clip: clip, segments: segs, words: words };
          });
      });
    });
    return chain.then(function () { return results; });
  }

  /** Normalize a word for matching: lowercase, letters/apostrophes only. */
  function normWord(t) {
    return String(t).toLowerCase().replace(/[^a-z']/g, "");
  }

  /** Grab up to n words before si and after ei, for review context. */
  function wordContext(words, si, ei, n) {
    var before = [], after = [], x;
    for (x = Math.max(0, si - n); x < si; x++) { before.push(String(words[x].text).trim()); }
    for (x = ei + 1; x <= Math.min(words.length - 1, ei + n); x++) { after.push(String(words[x].text).trim()); }
    return { before: before.join(" "), after: after.join(" ") };
  }

  /**
   * Flag filler words/phrases from a list. Supports single words ("um") and
   * multi-word phrases ("you know").
   *
   * Each hit is tagged `tight` when removing it would leave less than
   * `tightThresh` of pause between the surrounding words (i.e. the next word
   * starts almost immediately) — cutting those sounds rushed, so the UI keeps
   * them by default. The gap left after a cut equals (pause before) + (pause
   * after) the filler, since the cut closes the filler's own span.
   *
   * Returns [{start,end,label,type:'filler',tight:bool}].
   */
  function detectFillers(words, fillerList, tightThresh) {
    if (tightThresh == null) { tightThresh = 0.15; }

    var singles = {}, phrases = [];
    fillerList.forEach(function (f) {
      var parts = String(f).toLowerCase().trim().split(/\s+/);
      parts = parts.filter(function (p) { return p.length > 0; });
      if (parts.length === 1) { singles[normWord(parts[0])] = true; }
      else if (parts.length > 1) { phrases.push(parts.map(normWord)); }
    });

    function isTight(si, ei) {
      var before = si > 0 ? (words[si].start - words[si - 1].end) : Infinity;
      var after = ei < words.length - 1 ? (words[ei + 1].start - words[ei].end) : Infinity;
      var gapLeftAfterCut = before + after;
      return isFinite(gapLeftAfterCut) && gapLeftAfterCut < tightThresh;
    }

    var hits = [];
    for (var i = 0; i < words.length; i++) {
      var nw = normWord(words[i].text);
      if (!nw) { continue; }
      var matched = false;
      // Try multi-word phrases first (longer match wins).
      for (var p = 0; p < phrases.length; p++) {
        var ph = phrases[p], ok = true;
        for (var k = 0; k < ph.length; k++) {
          if (i + k >= words.length || normWord(words[i + k].text) !== ph[k]) { ok = false; break; }
        }
        if (ok) {
          var ei = i + ph.length - 1;
          var ctxP = wordContext(words, i, ei, 3);
          hits.push({ start: words[i].start, end: words[ei].end, label: ph.join(" "), type: "filler", tight: isTight(i, ei), before: ctxP.before, after: ctxP.after });
          i = ei;
          matched = true;
          break;
        }
      }
      if (!matched && singles[nw]) {
        var ctxS = wordContext(words, i, i, 3);
        hits.push({ start: words[i].start, end: words[i].end, label: words[i].text.trim(), type: "filler", tight: isTight(i, i), before: ctxS.before, after: ctxS.after });
      }
    }
    return hits;
  }

  /**
   * Flag stutters: consecutive repeats of the same word ("yeah yeah yeah").
   * Keeps the LAST occurrence (it leads into the rest of the sentence) and
   * marks the earlier ones for removal.
   */
  function detectRepetitions(words) {
    var hits = [];
    var i = 0;
    while (i < words.length) {
      var nw = normWord(words[i].text);
      if (!nw) { i++; continue; }
      var j = i + 1;
      while (j < words.length && normWord(words[j].text) === nw) { j++; }
      if (j - i >= 2) {
        for (var k = i; k < j - 1; k++) {
          var ctx = wordContext(words, k, k, 3);
          hits.push({ start: words[k].start, end: words[k].end, label: words[k].text.trim(), type: "repeat", before: ctx.before, after: ctx.after });
        }
      }
      i = j;
    }
    return hits;
  }

  /**
   * Transcribe each clip ONCE and return BOTH word-level and segment-level
   * lists, mapped to sequence time: { words:[{text,start,end}],
   * segments:[{text,start,end}] }. Quick Clean uses this so Fillers (words) and
   * Cleanup (segments) share a single Whisper pass instead of transcribing
   * twice — the Whisper JSON already carries segments AND their nested words.
   *
   * @param {object} cfg  whisperPath, ffmpegPath, clips, model, onProgress?
   */
  function transcribeBoth(cfg) {
    var fs = nodeRequire("fs");
    var path = nodeRequire("path");
    var os = nodeRequire("os");
    var tmp = path.join(os.tmpdir(), "quietcut-stt");
    try { fs.mkdirSync(tmp, { recursive: true }); } catch (e) {}

    var words = [], segments = [];
    var chain = Promise.resolve();
    cfg.clips.forEach(function (clip, idx) {
      chain = chain.then(function () {
        if (cfg.onProgress) { cfg.onProgress(idx, cfg.clips.length); }
        if (!clip.mediaPath || (clip.outSec - clip.inSec) <= 0) { return; }
        var wav = path.join(tmp, "both" + idx + ".wav");
        var jsonPath = path.join(tmp, "both" + idx + ".json");
        return extractWav(cfg.ffmpegPath, clip, wav)
          .then(function () { return runWhisper(cfg.whisperPath, wav, cfg.model, tmp); })
          .then(function () {
            var raw; try { raw = fs.readFileSync(jsonPath, "utf8"); } catch (e) { return; }
            var data; try { data = JSON.parse(raw); } catch (e) { return; }
            var segs = data.segments || [];
            for (var s = 0; s < segs.length; s++) {
              var seg = segs[s];
              if (seg.text != null && seg.start != null && seg.end != null) {
                var st = String(seg.text).trim();
                if (st) { segments.push({ text: st, start: clip.startSec + seg.start, end: clip.startSec + seg.end }); }
              }
              var ws = seg.words || [];
              for (var w = 0; w < ws.length; w++) {
                var tw = ws[w];
                var txt = (tw.word != null) ? tw.word : tw.text;
                if (txt == null || tw.start == null || tw.end == null) { continue; }
                words.push({ text: txt, start: clip.startSec + tw.start, end: clip.startSec + tw.end });
              }
            }
          });
      });
    });
    return chain.then(function () {
      words.sort(function (a, b) { return a.start - b.start; });
      segments.sort(function (a, b) { return a.start - b.start; });
      return { words: words, segments: segments };
    });
  }

  /**
   * Union-merge selected cut items into an ascending, non-overlapping range
   * list the host can apply in ONE qcApplySilenceCuts call. Overlapping or
   * adjacent cuts from different sources (e.g. a filler sitting inside an AI
   * "rambling" span) are WIDENED into a single contiguous cut — never dropped —
   * so the host never orphans a razor pair. Sub-frame slivers (<0.02s) are
   * dropped so no degenerate zero-width cut reaches Premiere. Items need only
   * {start,end}.
   */
  function mergeSelectedRanges(items) {
    var rs = items.map(function (it) { return { start: it.start, end: it.end }; });
    var merged = mergeRanges(rs); // sort ascending + union overlaps (0.001s epsilon)
    return merged.filter(function (r) { return (r.end - r.start) >= 0.02; });
  }

  /**
   * Group zoom moments into RUNS (back-to-back moments merge) and build a
   * keyframe spec for qcApplyZoomRuns. Within a run the scale HOLDS and pushes
   * a little FURTHER on each beat, then releases once at the end — instead of
   * popping out to 100% and back in between adjacent zooms. Spaced-out moments
   * stay separate (one run each = the old behaviour). Returns
   * "easeCode,t:v,t:v;..." with one run per ';'.
   *
   * opts: amount, style('ramp'|'static'), rampSec, easeCode(0|1),
   *       mergeGap (merge when the gap between moments is under this, seconds),
   *       escalation (extra % per extra beat), escCap (max %).
   */
  function buildZoomRuns(moments, opts) {
    opts = opts || {};
    var amount = opts.amount || 110;
    var isRamp = (opts.style !== "static");
    var rampSec = (opts.rampSec != null) ? opts.rampSec : 0.5;
    var easeCode = (opts.easeCode === 0) ? 0 : 1;
    var mergeGap = (opts.mergeGap != null) ? opts.mergeGap : 1.5;
    var esc = (opts.escalation != null) ? opts.escalation : 8;
    var escCap = (opts.escCap != null) ? opts.escCap : Math.min(150, amount + 30);

    var ms = moments.slice().sort(function (a, b) { return a.start - b.start; });
    if (!ms.length) { return ""; }

    var runs = [], cur = [ms[0]];
    for (var i = 1; i < ms.length; i++) {
      if (ms[i].start - cur[cur.length - 1].end < mergeGap) { cur.push(ms[i]); }
      else { runs.push(cur); cur = [ms[i]]; }
    }
    runs.push(cur);

    function ser(kfs) {
      var out = [], last = -Infinity;
      for (var k = 0; k < kfs.length; k++) {
        var t = kfs[k].t;
        if (t <= last) { t = last + 0.01; }   // keep keyframe times strictly increasing
        last = t;
        out.push(t.toFixed(3) + ":" + kfs[k].v.toFixed(1));
      }
      return easeCode + "," + out.join(",");
    }

    var specRuns = [];
    for (var r = 0; r < runs.length; r++) {
      var run = runs[r];
      var runStart = run[0].start, runEnd = run[run.length - 1].end;
      var ramp = Math.min(rampSec, (runEnd - runStart) / 2);
      if (!(ramp > 0.05)) { ramp = 0.05; }
      var kfs = [], level = amount;
      if (isRamp) {
        kfs.push({ t: runStart, v: 100 });
        kfs.push({ t: runStart + ramp, v: amount });
      } else {
        kfs.push({ t: runStart, v: amount });            // hold opens at amount
      }
      for (var b = 1; b < run.length; b++) {
        var bt = run[b].start;
        if (isRamp) { kfs.push({ t: bt - ramp, v: level }); } // hold until just before the beat
        level = Math.min(escCap, level + esc);
        kfs.push({ t: bt, v: level });                        // push further on the beat
      }
      if (isRamp) {
        kfs.push({ t: runEnd - ramp, v: level });
        kfs.push({ t: runEnd, v: 100 });                      // single release at the end
      } else {
        kfs.push({ t: runEnd, v: level });
      }
      specRuns.push(ser(kfs));
    }
    return specRuns.join(";");
  }

  /** Build "t1,t2,amount,style,ramp,ease;..." for the host zoom-layer call. */
  function zoomsToString(moments, amount, styleCode, rampSec, easeCode) {
    return moments.map(function (m) {
      return m.start.toFixed(3) + "," + m.end.toFixed(3) + "," + amount + "," +
             styleCode + "," + rampSec + "," + easeCode;
    }).join(";");
  }

  return {
    nodeAvailable: nodeAvailable,
    detectSilences: detectSilences,
    measureLoudness: measureLoudness,
    detectSentenceZooms: detectSentenceZooms,
    transcribe: transcribe,
    transcribeSegments: transcribeSegments,
    transcribePerClip: transcribePerClip,
    transcribeBoth: transcribeBoth,
    testEngines: testEngines,
    // Exposed so the engine-failure paths can be exercised directly.
    extractWav: extractWav,
    runWhisper: runWhisper,
    detectFillers: detectFillers,
    detectRepetitions: detectRepetitions,
    mergeSelectedRanges: mergeSelectedRanges,
    rangesToString: rangesToString,
    zoomsToString: zoomsToString,
    buildZoomRuns: buildZoomRuns
  };
})();
