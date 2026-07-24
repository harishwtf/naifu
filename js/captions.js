/*
 * Naifu - captions (karaoke overlay + plain SRT).
 *
 * Premiere's scripting can't create styled, word-highlighted captions (no caption
 * styling API, no native active-word mode). So — like Captions/Submagic/CapCut —
 * we RENDER the styled captions ourselves and lay them over the video:
 *   words (Whisper) -> caption lines -> ASS subtitle (per-word active highlight)
 *   -> transparent overlay via the bundled ffmpeg (libass + ProRes 4444 alpha)
 *   -> imported + placed on a top track by the host.
 * We also emit a plain .srt for a native (editable, unstyled) Premiere caption
 * track. All offline; no new dependencies.
 */
var QCCaptions = (function () {
  "use strict";

  var nodeRequire =
    (typeof require === "function") ? require :
    (typeof cep_node !== "undefined" && cep_node.require) ? cep_node.require : null;

  function nodeAvailable() { return !!nodeRequire; }

  /* ---------- time formatting ---------- */
  function pad(n, w) { n = String(n); while (n.length < w) { n = "0" + n; } return n; }
  function assTime(sec) {
    if (sec < 0) { sec = 0; }
    var h = Math.floor(sec / 3600); sec -= h * 3600;
    var m = Math.floor(sec / 60); sec -= m * 60;
    var s = Math.floor(sec);
    var cs = Math.round((sec - s) * 100);
    if (cs >= 100) { cs = 0; s += 1; }
    return h + ":" + pad(m, 2) + ":" + pad(s, 2) + "." + pad(cs, 2);
  }
  function srtTime(sec) {
    if (sec < 0) { sec = 0; }
    var h = Math.floor(sec / 3600); sec -= h * 3600;
    var m = Math.floor(sec / 60); sec -= m * 60;
    var s = Math.floor(sec);
    var ms = Math.round((sec - s) * 1000);
    if (ms >= 1000) { ms = 0; s += 1; }
    return pad(h, 2) + ":" + pad(m, 2) + ":" + pad(s, 2) + "," + pad(ms, 3);
  }

  /* ---------- group words -> caption lines ---------- */
  /**
   * @param {Array} words  [{text,start,end}] sequence time
   * @param {object} opts   maxWords, maxChars, maxGap (split on a pause this long)
   * @returns {Array} lines [{words, start, end, text, edited:false}]
   */
  function groupWordsToLines(words, opts) {
    opts = opts || {};
    var maxWords = opts.maxWords || 4;
    var maxChars = opts.maxChars || 32;
    var maxGap = (opts.maxGap != null) ? opts.maxGap : 0.7;
    var lines = [], cur = [];
    function flush() {
      if (!cur.length) { return; }
      var text = cur.map(function (w) { return w.text; }).join(" ");
      lines.push({ words: cur, start: cur[0].start, end: cur[cur.length - 1].end, text: text, edited: false });
      cur = [];
    }
    for (var i = 0; i < words.length; i++) {
      var t = String(words[i].text).trim();
      if (!t) { continue; }
      if (cur.length) {
        var gap = words[i].start - cur[cur.length - 1].end;
        var chars = cur.map(function (x) { return x.text; }).join(" ").length;
        if (cur.length >= maxWords || gap > maxGap || (chars + 1 + t.length) > maxChars) { flush(); }
      }
      cur.push({ text: t, start: words[i].start, end: words[i].end });
    }
    flush();
    return lines;
  }

  /* ---------- colors + escaping ---------- */
  // #RRGGBB -> ASS &HAABBGGRR (alpha 00 = opaque). alphaHex is ASS alpha (00 opaque, FF clear).
  function hexToAss(hex, alphaHex) {
    hex = String(hex || "#FFFFFF").replace("#", "");
    if (hex.length === 3) { hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]; }
    var r = hex.substr(0, 2), g = hex.substr(2, 2), b = hex.substr(4, 2);
    return ("&H" + (alphaHex || "00") + b + g + r).toUpperCase();
  }
  function assEsc(t) {
    return String(t).replace(/\{/g, "(").replace(/\}/g, ")").replace(/\r?\n/g, " ");
  }

  // The per-word timings for a line: real Whisper words, or — if the user edited
  // the text — evenly distribute the line's [start,end] across the new tokens.
  function lineWords(line) {
    if (line.words && line.words.length && !line.edited) { return line.words; }
    var toks = String(line.text).trim().split(/\s+/).filter(function (s) { return s.length; });
    if (!toks.length) { return []; }
    var span = (line.end - line.start) / toks.length;
    return toks.map(function (tk, i) {
      return { text: tk, start: line.start + i * span, end: line.start + (i + 1) * span };
    });
  }

  /* ---------- build ASS (per-word active-word highlight) ---------- */
  /**
   * style: { font, size, bold, activeColor, baseColor, boxMode('box'|'hug'),
   *          boxColor, boxAlpha, outlineColor, outlineWidth, position, marginV, activeScale }
   */
  function buildAss(lines, style, W, H) {
    style = style || {};
    var font = style.font || "Arial";
    var size = style.size || 52;
    var bold = (style.bold === false) ? 0 : -1;
    var base = hexToAss(style.baseColor || "#C9C9C9");
    var active = hexToAss(style.activeColor || "#FFFFFF");
    var outline = hexToAss(style.outlineColor || "#101010");
    var borderStyle = (style.boxMode === "hug") ? 1 : 3;            // 3 = opaque box, 1 = outline
    var back = hexToAss(style.boxColor || "#000000", (style.boxAlpha != null ? style.boxAlpha : "40"));
    var outlineW = (style.outlineWidth != null) ? style.outlineWidth : (borderStyle === 3 ? 10 : 4);
    var align = style.position === "center" ? 5 : (style.position === "top" ? 8 : 2);
    var marginV = style.marginV || Math.round(H * 0.12);
    var activeScale = style.activeScale || 100;

    var head = [
      "[Script Info]",
      "ScriptType: v4.00+",
      "PlayResX: " + W,
      "PlayResY: " + H,
      "WrapStyle: 2",
      "ScaledBorderAndShadow: yes",
      "",
      "[V4+ Styles]",
      "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
      "Style: Default," + font + "," + size + "," + base + "," + base + "," + outline + "," + back + "," +
        bold + ",0,0,0,100,100,0,0," + borderStyle + "," + outlineW + ",0," + align + ",60,60," + marginV + ",1",
      "",
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"
    ];

    var activeTag = "{\\1c" + active + (activeScale !== 100 ? ("\\fscx" + activeScale + "\\fscy" + activeScale) : "") + "}";
    var baseTag = "{\\1c" + base + (activeScale !== 100 ? "\\fscx100\\fscy100" : "") + "}";

    var events = [];
    for (var li = 0; li < lines.length; li++) {
      var ws = lineWords(lines[li]);
      for (var wi = 0; wi < ws.length; wi++) {
        var st = ws[wi].start;
        var en = (wi + 1 < ws.length) ? ws[wi + 1].start : lines[li].end; // active until next word
        if (en <= st) { en = ws[wi].end; }
        var parts = [];
        for (var k = 0; k < ws.length; k++) {
          var word = assEsc(ws[k].text);
          parts.push(k === wi ? (activeTag + word + baseTag) : word);
        }
        events.push("Dialogue: 0," + assTime(st) + "," + assTime(en) + ",Default,,0,0,0,," + baseTag + parts.join(" "));
      }
    }
    return head.join("\n") + "\n" + events.join("\n") + "\n";
  }

  /* ---------- plain SRT (line-level) ---------- */
  function buildSrt(lines) {
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      out.push(String(i + 1));
      out.push(srtTime(lines[i].start) + " --> " + srtTime(lines[i].end));
      out.push(String(lines[i].text).trim());
      out.push("");
    }
    return out.join("\n");
  }

  /* ---------- temp files ---------- */
  function tmpDir() {
    var path = nodeRequire("path"), os = nodeRequire("os"), fs = nodeRequire("fs");
    var dir = path.join(os.tmpdir(), "quietcut-cap");
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    return dir;
  }
  function writeTemp(name, content) {
    var path = nodeRequire("path"), fs = nodeRequire("fs");
    var p = path.join(tmpDir(), name);
    fs.writeFileSync(p, content, "utf8");
    return p;
  }

  /* ---------- render transparent overlay via ffmpeg + libass ---------- */
  /**
   * cfg: ffmpegPath, lines, style, W, H, fps, durationSec, container('prores'|'qtrle'|'webm')
   * Returns Promise<overlayPath>. Runs ffmpeg with cwd = temp dir so the ass
   * filter gets a bare filename (avoids Windows colon-escaping pain).
   */
  function renderOverlay(cfg) {
    return new Promise(function (resolve, reject) {
      var fs = nodeRequire("fs"), path = nodeRequire("path");
      var dir = tmpDir();
      try { writeTemp("cap.ass", buildAss(cfg.lines, cfg.style, cfg.W, cfg.H)); }
      catch (e) { reject(new Error("Could not build the caption file: " + e.message)); return; }

      var fps = cfg.fps || 30, dur = cfg.durationSec || 5;
      var size = cfg.W + "x" + cfg.H;
      var container = cfg.container || "prores";
      var outName, args;
      var src = "color=c=black@0.0:s=" + size + ":r=" + fps + ":d=" + dur.toFixed(3);
      var common = ["-hide_banner", "-y", "-f", "lavfi", "-i", src, "-vf", "ass=cap.ass"];
      if (container === "qtrle") {
        outName = "NaifuCaptions.mov";
        args = common.concat(["-c:v", "qtrle", "-pix_fmt", "argb", outName]);
      } else if (container === "webm") {
        outName = "NaifuCaptions.webm";
        args = common.concat(["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", outName]);
      } else {
        outName = "NaifuCaptions.mov";
        args = common.concat(["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", outName]);
      }
      var outPath = path.join(dir, outName);
      try { fs.unlinkSync(outPath); } catch (e) {} // clear a stale render

      var execFile = nodeRequire("child_process").execFile;
      execFile(cfg.ffmpegPath, args, { cwd: dir, maxBuffer: 1024 * 1024 * 64 }, function (err) {
        if (err && err.code === "ENOENT") { reject(new Error("FFmpeg isn't installed. Run setup.ps1, then restart Premiere.")); return; }
        if (!fs.existsSync(outPath)) { reject(new Error("Caption render produced no file (check the font name and try again).")); return; }
        resolve(outPath);
      });
    });
  }

  return {
    nodeAvailable: nodeAvailable,
    groupWordsToLines: groupWordsToLines,
    buildAss: buildAss,
    buildSrt: buildSrt,
    writeTemp: writeTemp,
    renderOverlay: renderOverlay
  };
})();
