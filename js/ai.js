/*
 * Naifu - local AI brain (Phase 4: Highlights / "best parts").
 *
 * Talks to a local Ollama server (started on demand from the bundled portable
 * ollama.exe) and asks a language model to read the interview transcript and
 * pick the strongest moments. This is content-based, so it works regardless of
 * mic type/movement — unlike loudness. A future "Sign in with Claude" brain
 * will swap in here behind the same findHighlights() interface.
 */
var QCAi = (function () {
  "use strict";

  var nodeRequire =
    (typeof require === "function") ? require :
    (typeof cep_node !== "undefined" && cep_node.require) ? cep_node.require :
    null;

  var HOST = "127.0.0.1";
  var PORT = 11434;

  function nodeAvailable() { return !!nodeRequire; }

  function httpGet(path) {
    return new Promise(function (resolve, reject) {
      var http = nodeRequire("http");
      var req = http.get({ host: HOST, port: PORT, path: path, timeout: 2500 }, function (res) {
        var b = ""; res.on("data", function (c) { b += c; }); res.on("end", function () { resolve({ status: res.statusCode, body: b }); });
      });
      req.on("error", reject);
      req.on("timeout", function () { req.destroy(); reject(new Error("timeout")); });
    });
  }

  function serverUp() {
    return httpGet("/api/tags").then(function () { return true; }).catch(function () { return false; });
  }

  /** Make sure the Ollama server is running; start it from ollamaExe if not. */
  function ensureServer(ollamaExe, modelsDir) {
    return serverUp().then(function (up) {
      if (up) { return true; }
      var cp = nodeRequire("child_process");
      var env = {};
      for (var k in process.env) { env[k] = process.env[k]; }
      env.OLLAMA_MODELS = modelsDir;
      env.OLLAMA_HOST = HOST + ":" + PORT;
      try {
        var child = cp.spawn(ollamaExe, ["serve"], { detached: true, stdio: "ignore", env: env });
        child.unref();
      } catch (e) {
        if (e && e.code === "ENOENT") {
          throw new Error("The local AI (Ollama) isn't installed. See the README to add it, or switch the brain to Claude (manual · claude.ai) — no install needed.");
        }
        throw new Error("Could not start the local AI (Ollama): " + e.message);
      }
      // Poll until it answers (first start loads libs; allow ~25s).
      return new Promise(function (resolve, reject) {
        var tries = 0;
        (function poll() {
          serverUp().then(function (u) {
            if (u) { resolve(true); return; }
            if (++tries > 25) { reject(new Error("Local AI server did not start in time.")); return; }
            setTimeout(poll, 1000);
          });
        })();
      });
    });
  }

  /** Pull a JSON object out of a model response (tolerates prose/code fences). */
  function extractJson(text) {
    if (!text) { return null; }
    try { return JSON.parse(text); } catch (e) {}
    var s = text.indexOf("{"), e2 = text.lastIndexOf("}");
    if (s >= 0 && e2 > s) {
      try { return JSON.parse(text.slice(s, e2 + 1)); } catch (e) {}
    }
    return null;
  }

  /** Call Claude via the Anthropic API (raw HTTPS). Returns the text response. */
  function generateClaudeApi(prompt, apiKey) {
    return new Promise(function (resolve, reject) {
      var https = nodeRequire("https");
      var payload = JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }]
      });
      var req = https.request({
        hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-length": Buffer.byteLength(payload)
        }
      }, function (res) {
        var b = ""; res.on("data", function (c) { b += c; });
        res.on("end", function () {
          var j;
          try { j = JSON.parse(b); } catch (e) { reject(new Error("Claude API: unreadable response.")); return; }
          if (j.type === "error" || j.error) {
            reject(new Error("Claude API: " + ((j.error && j.error.message) || "request failed (check your key).")));
            return;
          }
          var txt = "";
          if (j.content) {
            for (var i = 0; i < j.content.length; i++) {
              if (j.content[i].type === "text") { txt = j.content[i].text; break; }
            }
          }
          resolve(txt);
        });
      });
      req.on("error", function (e) { reject(new Error("Claude API: " + e.message)); });
      req.write(payload); req.end();
    });
  }

  /**
   * Warm a model into memory so the first real call is instant — fired when the
   * panel opens. Best-effort and silent: resolves false on any problem. An empty
   * prompt makes Ollama load the model without generating; keep_alive holds it.
   */
  function preloadModel(cfg) {
    if (!nodeAvailable()) { return Promise.resolve(false); }
    return ensureServer(cfg.ollamaExe, cfg.modelsDir).then(function () {
      return new Promise(function (resolve) {
        var http = nodeRequire("http");
        var payload = JSON.stringify({ model: cfg.model, prompt: "", keep_alive: "30m" });
        var req = http.request({
          host: HOST, port: PORT, path: "/api/generate", method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
        }, function (res) {
          res.on("data", function () {}); res.on("end", function () { resolve(true); });
        });
        req.on("error", function () { resolve(false); });
        req.write(payload); req.end();
      });
    }).catch(function () { return false; });
  }

  /** One-shot generate with JSON output forced. */
  function generate(model, prompt) {
    return new Promise(function (resolve, reject) {
      var http = nodeRequire("http");
      var payload = JSON.stringify({
        model: model, prompt: prompt, stream: false, format: "json",
        options: { temperature: 0.2 }
      });
      var req = http.request({
        host: HOST, port: PORT, path: "/api/generate", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
      }, function (res) {
        var b = ""; res.on("data", function (c) { b += c; });
        res.on("end", function () {
          try { resolve(JSON.parse(b).response || ""); }
          catch (e) { reject(new Error("Local AI returned an unreadable response.")); }
        });
      });
      req.on("error", reject);
      req.write(payload); req.end();
    });
  }

  /* ---------- on-demand model download (so we don't ship 5 GB of weights) ---------- */

  // The panel reports pull progress through this (set once by main.js).
  var pullProgressCb = null;
  function onPullProgress(fn) { pullProgressCb = fn; }

  /** Is `model` already downloaded? Asks Ollama's /api/tags. */
  function modelPresent(model) {
    return httpGet("/api/tags").then(function (r) {
      try {
        var list = JSON.parse(r.body).models || [];
        var base = String(model).split(":")[0];
        for (var i = 0; i < list.length; i++) {
          var nm = list[i].name || list[i].model || "";
          if (nm === model || nm.split(":")[0] === base) { return true; }
        }
      } catch (e) {}
      return false;
    }).catch(function () { return false; });
  }

  /** Download `model` via Ollama, streaming {status, percent} to onProgress. */
  function pullModel(model, onProgress) {
    return new Promise(function (resolve, reject) {
      var http = nodeRequire("http");
      var payload = JSON.stringify({ model: model, stream: true });
      var req = http.request({
        host: HOST, port: PORT, path: "/api/pull", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
      }, function (res) {
        var buf = "";
        res.on("data", function (c) {
          buf += c;
          var lines = buf.split("\n"); buf = lines.pop();
          for (var i = 0; i < lines.length; i++) {
            if (!lines[i].trim()) { continue; }
            try {
              var o = JSON.parse(lines[i]);
              if (o.error) { reject(new Error(o.error)); return; }
              if (onProgress) {
                var pct = (o.total && o.completed) ? Math.round(o.completed / o.total * 100) : null;
                onProgress(o.status || "", pct);
              }
            } catch (e) {}
          }
        });
        res.on("end", function () { resolve(true); });
      });
      req.on("error", reject);
      req.write(payload); req.end();
    });
  }

  /**
   * Run a local generation, downloading the model first if it isn't installed
   * (the model is fetched on first use, not bundled). Shared by every local brain.
   */
  function runLocal(cfg, prompt) {
    return ensureServer(cfg.ollamaExe, cfg.modelsDir)
      .then(function () { return modelPresent(cfg.model); })
      .then(function (present) {
        if (present) { return true; }
        if (pullProgressCb) { pullProgressCb("starting the download", null); }
        return pullModel(cfg.model, pullProgressCb);
      })
      .then(function () { return generate(cfg.model, prompt); });
  }

  /**
   * Optional free-text context the editor typed (brand, topic, who's speaking).
   * Woven near the top of any AI prompt so the model judges with it in mind.
   * Returns "" when blank so prompts are unchanged if no context is given.
   */
  function contextBlock(context) {
    context = (context == null) ? "" : String(context).trim();
    if (!context) { return ""; }
    return "IMPORTANT CONTEXT FROM THE EDITOR (weigh this heavily when deciding what to keep, cut, or feature):\n" +
      context + "\n\n";
  }

  function buildHighlightPrompt(segs, count, context) {
    var lines = segs.map(function (s, i) {
      return "[" + i + "] (" + s.start.toFixed(1) + "s) " + s.text;
    });
    return "You are an expert video editor reviewing an interview transcript. " +
      "Each line is a timestamped segment formatted as: [index] (time) text.\n\n" +
      contextBlock(context) +
      lines.join("\n") + "\n\n" +
      "Pick the " + count + " most compelling, self-contained, quotable highlights — " +
      "moments a viewer would clip and share. Prefer complete thoughts; ignore filler and rambling. " +
      'Respond ONLY as JSON in this exact shape: ' +
      '{"highlights":[{"from":<startIndex>,"to":<endIndex>,"reason":"<short reason>"}]} ' +
      "where from and to are segment indices (inclusive) chosen from the list above.";
  }

  function parseHighlights(respText, segs) {
    var data = extractJson(respText);
    if (!data) { throw new Error("The AI returned unreadable output."); }
    var hs = data.highlights || [];
    var out = [];
    hs.forEach(function (h) {
      var from = parseInt(h.from, 10), to = parseInt(h.to, 10);
      if (isNaN(from) || isNaN(to)) { return; }
      from = Math.max(0, Math.min(segs.length - 1, from));
      to = Math.max(from, Math.min(segs.length - 1, to));
      var quote = "";
      for (var i = from; i <= to; i++) { quote += segs[i].text + " "; }
      out.push({ start: segs[from].start, end: segs[to].end, quote: quote.trim(), reason: String(h.reason || "") });
    });
    out.sort(function (a, b) { return a.start - b.start; });
    return out;
  }

  /**
   * Ask the chosen brain for the best moments in a transcript.
   *
   * @param {object} cfg
   *   segments [{text,start,end}], count,
   *   brain: 'local' | 'claude-api',
   *   apiKey (for claude-api), ollamaExe/modelsDir/model (for local)
   * @returns {Promise<Array<{start,end,quote,reason}>>}
   */
  function findHighlights(cfg) {
    var prompt = buildHighlightPrompt(cfg.segments, cfg.count || 5, cfg.context);
    var gen;
    if (cfg.brain === "claude-api") {
      if (!cfg.apiKey) {
        return Promise.reject(new Error("Enter your Claude API key in Settings (or switch the brain to Local)."));
      }
      gen = generateClaudeApi(prompt, cfg.apiKey);
    } else {
      gen = runLocal(cfg, prompt);
    }
    return gen.then(function (resp) { return parseHighlights(resp, cfg.segments); });
  }

  /* ---------- Cleanup (AI transcript edit: what to cut) ---------- */

  function buildTranscriptEditPrompt(segs, aggressiveness, context) {
    var lines = segs.map(function (s, i) { return "[" + i + "] " + s.text; });
    var aggro;
    if (aggressiveness === "light") {
      aggro = "Be conservative: only suggest cuts you are confident remove pure dead weight. When in doubt, keep it.";
    } else if (aggressiveness === "heavy") {
      aggro = "Tighten aggressively for maximum pace: cut anything that isn't pulling its weight — but never remove unique information or a genuinely good line.";
    } else {
      aggro = "Aim for a clean, tight edit while preserving the speaker's voice and every real point.";
    }
    return "You are a meticulous video editor tightening a talking-head/interview edit. " +
      "Below is the transcript, one numbered segment per line.\n\n" +
      contextBlock(context) +
      lines.join("\n") + "\n\n" +
      "Identify segments (or runs of consecutive segments) that should be CUT to make it tighter and stronger — " +
      "false starts and restarts, filler rambling, repeated or redundant points, tangents that go nowhere, " +
      "misspeaks the speaker corrects right after, and dead weight that adds no information. " +
      "Never cut something that carries a unique point, key information, or a strong line. " + aggro + "\n\n" +
      'Respond ONLY as JSON: {"cuts":[{"from":<startIndex>,"to":<endIndex>,' +
      '"category":"<false-start|repetition|rambling|tangent|misspeak|dead-weight>","reason":"<short why>"}]} ' +
      "where from/to are segment indices (inclusive) from the list above. Order by index, and do not overlap ranges.";
  }

  function parseTranscriptEdits(reply, segs) {
    var data = extractJson(reply);
    if (!data) { throw new Error("The AI returned unreadable output."); }
    var cuts = data.cuts || [];
    var out = [];
    cuts.forEach(function (c) {
      var from = parseInt(c.from, 10), to = parseInt(c.to, 10);
      if (isNaN(from)) { return; }
      if (isNaN(to)) { to = from; }
      from = Math.max(0, Math.min(segs.length - 1, from));
      to = Math.max(from, Math.min(segs.length - 1, to));
      var quote = "";
      for (var i = from; i <= to; i++) { quote += segs[i].text + " "; }
      out.push({
        start: segs[from].start, end: segs[to].end, quote: quote.trim(),
        category: String(c.category || "cut"), reason: String(c.reason || "")
      });
    });
    out.sort(function (a, b) { return a.start - b.start; });
    // Drop overlaps (keep the earlier one) so the razor ranges stay clean.
    var dedup = [];
    out.forEach(function (c) {
      var last = dedup[dedup.length - 1];
      if (last && c.start < last.end - 0.001) { return; }
      dedup.push(c);
    });
    return dedup;
  }

  function findTranscriptEdits(cfg) {
    var prompt = buildTranscriptEditPrompt(cfg.segments, cfg.aggressiveness, cfg.context);
    var gen;
    if (cfg.brain === "claude-api") {
      if (!cfg.apiKey) { return Promise.reject(new Error("Enter your Claude API key (or use the manual brain).")); }
      gen = generateClaudeApi(prompt, cfg.apiKey);
    } else {
      gen = runLocal(cfg, prompt);
    }
    return gen.then(function (resp) { return parseTranscriptEdits(resp, cfg.segments); });
  }

  /* ---------- Vox Pop (multi-interview compilation) ---------- */

  function buildVoxPopPrompt(clips, context) {
    var parts = clips.map(function (c, ci) {
      var ws = (c.words || []).map(function (w, wi) { return "[" + wi + "]" + w.text; });
      return "CLIP " + ci + ":\n" + (ws.length ? ws.join(" ") : "(no speech)");
    });
    return "You are editing an engaging street-interview montage. Below are " + clips.length +
      " interviews. In each, an interviewer asks the same question, then the person answers. " +
      "Each clip's transcript is shown as numbered WORDS in the form [index]word.\n\n" +
      contextBlock(context) +
      parts.join("\n\n") + "\n\n" +
      "Do three things:\n" +
      "1. Identify the shared QUESTION and pick ONE clip + word range where it is said most clearly (used once as the intro).\n" +
      "2. For EACH clip, pick the single juiciest, most quotable ANSWER — choose the EXACT word range to keep, trimmed tight: start on the first word of the line and end on the last, dropping filler, false starts, and trailing 'um's at the edges. It can be a short phrase, not a whole sentence.\n" +
      "3. Order the chosen answers into an engaging storyline (e.g. save the best/funniest for last).\n\n" +
      'Respond ONLY as JSON: {"question":{"clip":N,"from":S,"to":E},' +
      '"soundbites":[{"clip":N,"from":S,"to":E,"reason":"<short why>"}]} ' +
      "where clip is the CLIP number and from/to are WORD indices (inclusive) within that clip. " +
      "The soundbites array MUST be in final playback order.";
  }

  /**
   * Map an AI-chosen WORD range [from,to] within a clip to precise src/seq times
   * and the trimmed quote. Shared by Vox Pop and Story. Returns null if unusable.
   */
  function wordRangeToTimes(clip, from, to) {
    var ws = (clip && clip.words) || [];
    if (ws.length === 0) { return null; }
    from = parseInt(from, 10); to = parseInt(to, 10);
    if (isNaN(from)) { from = 0; }
    if (isNaN(to)) { to = from; }
    from = Math.max(0, Math.min(ws.length - 1, from));
    to = Math.max(from, Math.min(ws.length - 1, to));
    var quote = "";
    for (var i = from; i <= to; i++) { quote += ws[i].text + " "; }
    return {
      seqStart: ws[from].seqStart, seqEnd: ws[to].seqEnd,
      srcStart: ws[from].srcStart, srcEnd: ws[to].srcEnd,
      quote: quote.trim()
    };
  }

  function parseVoxPop(reply, clips) {
    var data = extractJson(reply);
    if (!data) { throw new Error("The AI returned unreadable output."); }

    function toItem(ci, from, to, role, reason) {
      ci = parseInt(ci, 10);
      if (isNaN(ci) || ci < 0 || ci >= clips.length) { return null; }
      var t = wordRangeToTimes(clips[ci], from, to);
      if (!t) { return null; }
      return {
        role: role, reason: String(reason || ""),
        clipIndex: ci, label: "Clip " + (ci + 1),
        seqStart: t.seqStart, seqEnd: t.seqEnd,
        srcStart: t.srcStart, srcEnd: t.srcEnd,
        quote: t.quote
      };
    }

    var items = [];
    if (data.question) {
      var q = toItem(data.question.clip, data.question.from, data.question.to, "question", "Shared question");
      if (q) { items.push(q); }
    }
    (data.soundbites || []).forEach(function (sb) {
      var it = toItem(sb.clip, sb.from, sb.to, "answer", sb.reason);
      if (it) { items.push(it); }
    });
    return items;
  }

  function findVoxPop(cfg) {
    var prompt = buildVoxPopPrompt(cfg.clips, cfg.context);
    var gen;
    if (cfg.brain === "claude-api") {
      if (!cfg.apiKey) { return Promise.reject(new Error("Enter your Claude API key (or use the manual brain).")); }
      gen = generateClaudeApi(prompt, cfg.apiKey);
    } else {
      gen = runLocal(cfg, prompt);
    }
    return gen.then(function (resp) { return parseVoxPop(resp, cfg.clips); });
  }

  /* ---------- Story / Documentary (narrative assembled from interview(s)) ---------- */

  function buildStoryPrompt(clips, context, pace) {
    var sawName = false;
    var parts = clips.map(function (c, ci) {
      var name = (c && c.clip && c.clip.name) ? String(c.clip.name).trim() : "";
      if (name) { sawName = true; }
      var ws = (c.words || []).map(function (w, wi) { return "[" + wi + "]" + w.text; });
      var head = "CLIP " + ci + (name ? " [" + name + "]" : "") + ":";
      return head + "\n" + (ws.length ? ws.join(" ") : "(no speech)");
    });
    var speakerNote = sawName
      ? "Each CLIP shows a LABEL in [brackets] — its name on the timeline; treat it as the SPEAKER of that clip. Clips with the SAME label are the same person; clips with DIFFERENT labels are different people. Use this to attribute lines correctly and shape the story — group a person's thread, or build a back-and-forth between speakers.\n\n"
      : "";
    var amount;
    if (pace === "tight") {
      amount = "Keep it TIGHT — only the few strongest beats that carry the story; cut hard.";
    } else if (pace === "thorough") {
      amount = "Be THOROUGH — tell the full arc with supporting detail, but never dead weight.";
    } else {
      amount = "Aim for a well-paced short film — the key beats, no filler.";
    }
    return "You are a documentary editor assembling a narrative from raw interview footage. Below are " +
      clips.length + " interview clip(s); each transcript is shown as numbered WORDS in the form [index]word.\n\n" +
      speakerNote +
      contextBlock(context) +
      parts.join("\n\n") + "\n\n" +
      "From the SUBJECT'S words, build a compelling story. Selection rules:\n" +
      "- Drop the interviewer's questions, filler, false starts, tangents, and repeated points.\n" +
      "- Pick the strongest, most quotable moments and TRIM each to the exact words, tight at both edges.\n" +
      "- Order them into a narrative arc — hook, context, key beats / turning point, a resonant close. You MAY reorder freely; recording order does not matter, the STORY does.\n" +
      amount + "\n\n" +
      "Do NOT ask questions or request more information — you have everything you need in the transcript above. Commit to your best editorial judgment and answer in a single turn.\n\n" +
      "OUTPUT — THIS IS CRITICAL. Reply with ONE JSON object and NOTHING else: no preamble, no explanation, no notes, no questions, and do NOT write the story out in prose. Your entire reply must start with { and end with }. Use exactly this shape:\n" +
      '{"beats":[{"clip":N,"from":S,"to":E,"section":"hook|context|point|turn|payoff","reason":"short why"}]}\n' +
      "clip = the CLIP number; from/to = WORD indices (inclusive) within that clip; the beats array is in final narrative (playback) order. Return only the JSON.";
  }

  function parseStory(reply, clips) {
    var data = extractJson(reply);
    if (!data) { throw new Error("The AI returned unreadable output."); }
    // Accept {beats:[...]} or, leniently, a bare [...] array of beats.
    var beats = data.beats || (Array.isArray(data) ? data : []);
    var items = [];
    beats.forEach(function (b) {
      var ci = parseInt(b.clip, 10);
      if (isNaN(ci) || ci < 0 || ci >= clips.length) { return; }
      var t = wordRangeToTimes(clips[ci], b.from, b.to);
      if (!t) { return; }
      var speaker = (clips[ci] && clips[ci].clip && clips[ci].clip.name) ? String(clips[ci].clip.name).trim() : "";
      items.push({
        role: "beat", section: String(b.section || ""), reason: String(b.reason || ""),
        speaker: speaker,
        clipIndex: ci, label: "Clip " + (ci + 1),
        seqStart: t.seqStart, seqEnd: t.seqEnd, srcStart: t.srcStart, srcEnd: t.srcEnd,
        quote: t.quote
      });
    });
    return items;
  }

  function findStory(cfg) {
    var prompt = buildStoryPrompt(cfg.clips, cfg.context, cfg.pace);
    var gen;
    if (cfg.brain === "claude-api") {
      if (!cfg.apiKey) { return Promise.reject(new Error("Enter your Claude API key (or use the manual brain).")); }
      gen = generateClaudeApi(prompt, cfg.apiKey);
    } else {
      gen = runLocal(cfg, prompt);
    }
    return gen.then(function (resp) { return parseStory(resp, cfg.clips); });
  }

  /* ---------- Hooks (juiciest moment inside each social short) ---------- */

  /**
   * How far into a clip the hook must start. The chosen line gets lifted to the
   * TOP of the short, so if it's the clip's own opening the viewer hears the same
   * sentence twice back to back. Everything before this word index is off limits.
   */
  var HOOK_HEAD_SEC = 5;
  function hookMinIndex(clip, headSec) {
    var ws = (clip && clip.words) || [];
    if (ws.length === 0) { return 0; }
    var head = (headSec == null) ? HOOK_HEAD_SEC : headSec;
    var t0 = ws[0].srcStart, i = 0;
    while (i < ws.length && (ws[i].srcStart - t0) < head) { i++; }
    // Never let the rule swallow the clip — leave at least two thirds in play.
    var cap = Math.floor(ws.length / 3);
    return (i > cap) ? cap : i;
  }

  /**
   * The editor already cut short clips out of a podcast; each one needs a hook.
   * Ask for the single most scroll-stopping line INSIDE each clip, as an exact
   * word range, so the panel can mark it on the timeline for a manual cut.
   */
  function buildHookPrompt(clips, context, perClip) {
    var n = parseInt(perClip, 10);
    if (isNaN(n) || n < 1) { n = 1; }
    var parts = clips.map(function (c, ci) {
      var name = (c && c.clip && c.clip.name) ? String(c.clip.name).trim() : "";
      var dur = (c && c.clip && c.clip.outSec > c.clip.inSec)
        ? " (" + (c.clip.outSec - c.clip.inSec).toFixed(1) + "s)" : "";
      var min = hookMinIndex(c);
      var gate = min > 0 ? " — OPENING IS OFF LIMITS: your range must START at word [" + min + "] or later" : "";
      var ws = (c.words || []).map(function (w, wi) { return "[" + wi + "]" + w.text; });
      return "CLIP " + ci + (name ? " [" + name + "]" : "") + dur + gate + ":\n" +
        (ws.length ? ws.join(" ") : "(no speech)");
    });
    var howMany = (n === 1)
      ? "For EACH clip, pick the ONE strongest hook."
      : "For EACH clip, pick up to " + n + " candidate hooks, BEST FIRST.";
    return "You are a social-media editor preparing short clips cut from a podcast for Reels / Shorts / TikTok. " +
      "Each clip below is one short; its transcript is shown as numbered WORDS in the form [index]word.\n\n" +
      contextBlock(context) +
      parts.join("\n\n") + "\n\n" +
      "A HOOK is the single juiciest line in the clip. The editor will LIFT it out and paste it at the very " +
      "TOP of the short, before everything else — so it has two jobs: stop the scroll in about 2 seconds, " +
      "and make the viewer stay for the WHOLE clip. Viewers decide in 1–3 seconds, and the retention curve " +
      "drops hardest right at the start, so a hook that needs a slow build has already lost.\n\n" +

      "NEVER PICK THE CLIP'S OPENING LINE. This is the most important rule. The hook is moved to the front, so if " +
      "you choose the first thing said, the viewer hears the same sentence twice in a row and it's unusable. Each " +
      "clip above tells you the earliest word index you may start at — obey it, and skip the whole opening thought, " +
      "not just the first few words. Take your hook from the BODY of the clip.\n\n" +

      "THE PATTERNS THAT WORK — pick the line that best fits one of these:\n" +
      "1. CONTRADICTION / pattern interrupt — a statement that violates what the viewer expects. \"I made more money after I stopped posting daily.\"\n" +
      "2. HARD NUMBER — a specific figure with stakes attached. \"I lost eight hundred thousand dollars in one afternoon.\" Numbers read as proof; vague scale reads as noise.\n" +
      "3. CONFESSION / high stakes — an admission with a real cost, risk or consequence named out loud. \"I nearly went bankrupt hiding this from my co-founder.\"\n" +
      "4. NARROW CURIOSITY GAP — opens ONE specific question the rest of the clip answers. \"Nobody on my team noticed for three days.\" A gap only works if it's specific and closable; a broad gap (\"everyone's doing it wrong\") fails, because the viewer can't tell what they'd even find out.\n" +
      "5. HOT TAKE / punchline — a blunt, quotable, argue-with-me opinion, or a genuinely funny line.\n\n" +

      "TEST EVERY CANDIDATE AGAINST ALL SIX — if it fails one, it is not your pick:\n" +
      "a) SHORT: lands in about 2–3 seconds spoken. Roughly 5–15 words. A paragraph is not a hook.\n" +
      "b) SPECIFIC: contains something concrete — a number, a name, a place, a price, a vivid image. Abstractions (\"it was a really challenging journey\", \"mindset is everything\") are the single most common failure. Prefer the line with the concrete detail in it, even if a vaguer line sounds grander.\n" +
      "c) STANDS ALONE COLD: understandable by someone who has heard NOTHING before it. Reject anything starting with a dangling reference — \"that's when it happened\", \"and he told me\", \"this is the part\" — because the viewer has no idea what \"that\", \"he\" or \"this\" is. If you can't tell who or what is being talked about from the words alone, it fails.\n" +
      "d) NO HEDGING: cut candidates built on \"I think maybe\", \"sort of\", \"you know\", \"I guess\". Hedged language kills authority. Prefer the flat declarative version of the same idea.\n" +
      "e) STAKES BEFORE JARGON: consequences named in plain words. A line that opens with industry jargon or an acronym burns the viewer's attention before any value lands.\n" +
      "f) THE CLIP ACTUALLY DELIVERS IT: the promise must be paid off by what's in this clip. A hook the clip doesn't answer is a bait-and-switch and performs worse than a weaker honest one.\n\n" +

      "Do NOT spoil the payoff: if the juiciest line is the final punchline or the resolution, prefer the provocative " +
      "setup that makes people wait for it — a spoiled ending kills the watch-through.\n\n" +

      "AUTOMATIC REJECTS: the clip's opening line; the interviewer's question; greetings and pleasantries; " +
      "throat-clearing (\"so basically…\", \"I think that…\", \"yeah so\"); slow setup and backstory; " +
      "generic motivational lines with no evidence in them; anything that only lands if you heard the earlier context.\n\n" +

      "Rules:\n" +
      "- " + howMany + "\n" +
      "- Your range must start at or after that clip's stated minimum word index. A hook that starts the clip is rejected.\n" +
      "- Choose the EXACT word range: start on the first word of the line and end on the last, trimmed tight — no leading \"and so\", no trailing \"um\".\n" +
      "- Use only words that actually appear in that clip's list, and never span across clips.\n" +
      "- Copy the exact words of your chosen range into the \"text\" field, so the editor can verify the range lines up.\n" +
      "- Before you commit, scan the WHOLE clip. The best line is usually buried in the middle, not near either end.\n\n" +

      "SCORING — use the full range honestly, most clips are a 5–7:\n" +
      "  9–10 = passes all six tests and would genuinely stop a scroll cold.\n" +
      "  7–8  = strong, one test is only partly met.\n" +
      "  5–6  = serviceable but generic or a little vague.\n" +
      "  1–4  = this clip has no real hook in it. SAY SO. A truthful 3 is far more useful to the editor than an inflated 8 — they will trust the score and skip the clip.\n\n" +

      "Do NOT ask questions or request more information — you have everything you need above. Commit to your best editorial judgment and answer in a single turn.\n\n" +
      "OUTPUT — THIS IS CRITICAL. Reply with ONE JSON object and NOTHING else: no preamble, no explanation, no notes, no questions. " +
      "Your entire reply must start with { and end with }. Use exactly this shape:\n" +
      '{"hooks":[{"clip":N,"from":S,"to":E,"text":"the exact words of your range",' +
      '"strength":1-10,"type":"contradiction|number|confession|curiosity|hot-take|funny",' +
      '"reason":"which pattern it is and why it holds them"}]}\n' +
      "clip = the CLIP number; from/to = WORD indices (inclusive) within that clip. Return only the JSON.";
  }

  /** Strip case/punctuation so transcript words and quoted words compare equal. */
  function normWord(s) {
    return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9']+/g, "");
  }

  /**
   * The model quotes the words it meant AND gives indices; when they disagree,
   * the indices are the thing that's wrong (an off-by-N marks the wrong words on
   * the timeline, silently). Trust the text: find that word sequence in the clip
   * and correct the range. Returns {from, to, corrected}.
   */
  function alignHookText(clip, from, to, text) {
    var ws = (clip && clip.words) || [];
    var want = String(text == null ? "" : text).split(/\s+/).map(normWord).filter(Boolean);
    if (ws.length === 0 || want.length < 2) { return { from: from, to: to, corrected: false }; }

    var have = [];
    for (var i = 0; i < ws.length; i++) { have.push(normWord(ws[i].text)); }

    // Already right? (compare what the given range actually covers)
    var cur = have.slice(from, to + 1).join(" ");
    if (cur === want.join(" ")) { return { from: from, to: to, corrected: false }; }

    // Exact sequence match anywhere in the clip.
    var hits = [];
    for (var s = 0; s + want.length <= have.length; s++) {
      var ok = true;
      for (var k = 0; k < want.length; k++) {
        if (have[s + k] !== want[k]) { ok = false; break; }
      }
      if (ok) { hits.push(s); }
    }
    // Repeated phrase: prefer the occurrence nearest the model's own guess.
    if (hits.length) {
      var best = hits[0];
      for (var h = 1; h < hits.length; h++) {
        if (Math.abs(hits[h] - from) < Math.abs(best - from)) { best = hits[h]; }
      }
      return { from: best, to: best + want.length - 1, corrected: true };
    }

    // Whisper may have heard a word differently — accept the window with the
    // most matching tokens in order, as long as it's clearly the right spot.
    var bestStart = -1, bestScore = 0;
    for (var s2 = 0; s2 + want.length <= have.length; s2++) {
      var score = 0;
      for (var k2 = 0; k2 < want.length; k2++) {
        if (have[s2 + k2] === want[k2]) { score++; }
      }
      if (score > bestScore) { bestScore = score; bestStart = s2; }
    }
    if (bestStart >= 0 && bestScore >= Math.ceil(want.length * 0.7)) {
      return { from: bestStart, to: bestStart + want.length - 1, corrected: true };
    }
    return { from: from, to: to, corrected: false };
  }

  function parseHooks(reply, clips) {
    var data = extractJson(reply);
    if (!data) { throw new Error("The AI returned unreadable output."); }
    // Accept {hooks:[...]} or, leniently, a bare [...] array.
    var hs = data.hooks || (Array.isArray(data) ? data : []);
    var out = [];
    hs.forEach(function (h) {
      var ci = parseInt(h.clip, 10);
      if (isNaN(ci) || ci < 0 || ci >= clips.length) { return; }
      // Indices decide what gets marked, but the model's own quote is the better
      // witness — realign first so an off-by-N doesn't mark the wrong words.
      var a = alignHookText(clips[ci], parseInt(h.from, 10), parseInt(h.to, 10), h.text);
      var t = wordRangeToTimes(clips[ci], a.from, a.to);
      if (!t) { return; }
      var strength = parseInt(h.strength, 10);
      if (isNaN(strength)) { strength = 0; }
      strength = Math.max(0, Math.min(10, strength));
      var name = (clips[ci] && clips[ci].clip && clips[ci].clip.name) ? String(clips[ci].clip.name).trim() : "";
      // The model can ignore the "not the opening" rule — check it ourselves.
      // Flagged rather than dropped, so a clip is never left with no candidate;
      // the panel shows the warning and leaves it unticked.
      var nearStart = !isNaN(a.from) && a.from < hookMinIndex(clips[ci]);
      out.push({
        clipIndex: ci, label: "Clip " + (ci + 1), name: name,
        strength: strength, type: String(h.type || ""), reason: String(h.reason || ""),
        nearStart: nearStart, corrected: a.corrected,
        seqStart: t.seqStart, seqEnd: t.seqEnd, srcStart: t.srcStart, srcEnd: t.srcEnd,
        quote: t.quote
      });
    });
    // Group by clip (timeline order); usable candidates first, then strength.
    out.sort(function (a, b) {
      return (a.clipIndex - b.clipIndex) ||
        ((a.nearStart ? 1 : 0) - (b.nearStart ? 1 : 0)) ||
        (b.strength - a.strength) || (a.seqStart - b.seqStart);
    });
    return out;
  }

  function findHooks(cfg) {
    var prompt = buildHookPrompt(cfg.clips, cfg.context, cfg.perClip);
    var gen;
    if (cfg.brain === "claude-api") {
      if (!cfg.apiKey) { return Promise.reject(new Error("Enter your Claude API key (or use the manual brain).")); }
      gen = generateClaudeApi(prompt, cfg.apiKey);
    } else {
      gen = runLocal(cfg, prompt);
    }
    return gen.then(function (resp) { return parseHooks(resp, cfg.clips); });
  }

  /* ---------- Speaker details (name / company / title for LinkedIn lookup) ---------- */

  function buildSpeakerPrompt(segs, context) {
    var lines = segs.map(function (s, i) { return "[" + i + "] " + s.text; });
    return "You are analyzing an interview / talking-head transcript to identify the people who speak. " +
      "People usually introduce themselves (e.g. \"I'm Jane Doe, Head of Design at Acme\") or are introduced by an interviewer.\n\n" +
      contextBlock(context) +
      lines.join("\n") + "\n\n" +
      "Identify each distinct real person who speaks or is introduced. For each, extract their full NAME, " +
      "their COMPANY / organization, and their job TITLE / designation — using ONLY what the transcript supports. " +
      "If a field isn't stated, use an empty string; never guess or invent it. Skip the interviewer if they don't give their own details.\n\n" +
      'Respond ONLY as JSON: {"people":[{"name":"<full name>","company":"<company>","title":"<job title>"}]} ' +
      "in the order they first appear.";
  }

  function parseSpeakers(reply) {
    var data = extractJson(reply);
    if (!data) { throw new Error("The AI returned unreadable output."); }
    var ppl = data.people || [];
    var out = [];
    ppl.forEach(function (p) {
      var name = String((p && p.name) || "").trim();
      var company = String((p && p.company) || "").trim();
      var title = String((p && p.title) || "").trim();
      if (!name && !company && !title) { return; }
      out.push({ name: name, company: company, title: title });
    });
    return out;
  }

  function findSpeakers(cfg) {
    var prompt = buildSpeakerPrompt(cfg.segments, cfg.context);
    var gen;
    if (cfg.brain === "claude-api") {
      if (!cfg.apiKey) { return Promise.reject(new Error("Enter your Claude API key (or use the manual brain).")); }
      gen = generateClaudeApi(prompt, cfg.apiKey);
    } else {
      gen = runLocal(cfg, prompt);
    }
    return gen.then(function (resp) { return parseSpeakers(resp); });
  }

  return {
    nodeAvailable: nodeAvailable,
    ensureServer: ensureServer,
    onPullProgress: onPullProgress,
    modelPresent: modelPresent,
    pullModel: pullModel,
    findHighlights: findHighlights,
    buildHighlightPrompt: buildHighlightPrompt,
    parseHighlights: parseHighlights,
    buildVoxPopPrompt: buildVoxPopPrompt,
    parseVoxPop: parseVoxPop,
    findVoxPop: findVoxPop,
    buildStoryPrompt: buildStoryPrompt,
    parseStory: parseStory,
    findStory: findStory,
    buildTranscriptEditPrompt: buildTranscriptEditPrompt,
    parseTranscriptEdits: parseTranscriptEdits,
    findTranscriptEdits: findTranscriptEdits,
    hookMinIndex: hookMinIndex,
    alignHookText: alignHookText,
    buildHookPrompt: buildHookPrompt,
    parseHooks: parseHooks,
    findHooks: findHooks,
    buildSpeakerPrompt: buildSpeakerPrompt,
    parseSpeakers: parseSpeakers,
    findSpeakers: findSpeakers,
    preloadModel: preloadModel
  };
})();
