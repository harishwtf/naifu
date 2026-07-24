/*
 * Naifu - ExtendScript host layer.
 *
 * This is the ONLY layer that touches the Premiere timeline. The panel UI
 * (js/main.js) calls these functions via CSInterface.evalScript(). Keeping all
 * host/timeline logic here means that if Premiere's scripting surface ever
 * changes (e.g. a future move to UXP), this is the single file we rewrite.
 *
 * Functions here return JSON *strings* (ExtendScript has no native JSON.stringify
 * we can rely on across versions), which main.js parses with JSON.parse.
 */

/** Escape a value so it can sit safely inside a double-quoted JSON string. */
function qc_jsonEscape(s) {
    if (s === undefined || s === null) {
        return "";
    }
    s = String(s);
    s = s.replace(/\\/g, "\\\\");
    s = s.replace(/"/g, '\\"');
    s = s.replace(/[\r]/g, "\\r");
    s = s.replace(/[\n]/g, "\\n");
    s = s.replace(/[\t]/g, "\\t");
    return s;
}

/**
 * Phase 0 round-trip test: report the active sequence's name and how many
 * clips it contains. Reads only — does not modify anything.
 *
 * @return {string} JSON, e.g.
 *   {"ok":true,"name":"My Seq","videoClips":12,"audioClips":12,
 *    "totalClips":24,"videoTracks":2,"audioTracks":3}
 */
function getActiveSequenceInfo() {
    try {
        if (app.project === undefined || app.project === null) {
            return '{"ok":false,"error":"No project is open in Premiere Pro."}';
        }

        var seq = app.project.activeSequence;
        if (seq === undefined || seq === null) {
            return '{"ok":false,"error":"No active sequence. Open a sequence in the Timeline and click again."}';
        }

        var videoClips = 0;
        var audioClips = 0;
        var i;

        for (i = 0; i < seq.videoTracks.numTracks; i++) {
            videoClips += seq.videoTracks[i].clips.numItems;
        }
        for (i = 0; i < seq.audioTracks.numTracks; i++) {
            audioClips += seq.audioTracks[i].clips.numItems;
        }

        var name = qc_jsonEscape(seq.name);
        var projName = qc_jsonEscape(app.project.name);

        return '{"ok":true' +
            ',"name":"' + name + '"' +
            ',"project":"' + projName + '"' +
            ',"videoClips":' + videoClips +
            ',"audioClips":' + audioClips +
            ',"totalClips":' + (videoClips + audioClips) +
            ',"videoTracks":' + seq.videoTracks.numTracks +
            ',"audioTracks":' + seq.audioTracks.numTracks +
            '}';
    } catch (e) {
        return '{"ok":false,"error":"ExtendScript error: ' + qc_jsonEscape(e.toString()) + '"}';
    }
}

/** Simple liveness check so the panel can confirm the host script loaded. */
function ping() {
    return '{"ok":true,"pong":true,"app":"' + qc_jsonEscape(app.name) + '","version":"' + qc_jsonEscape(app.version) + '"}';
}

/* =========================================================================
 * PHASE 1 - Silence removal
 * ========================================================================= */

/** Premiere measures time internally in ticks. This many ticks = 1 second. */
var QC_TICKS_PER_SECOND = 254016000000;

/**
 * Collect the audio clips on the active sequence so the panel can run FFmpeg
 * on their underlying media files. Read-only.
 *
 * @return {string} JSON, e.g.
 *   {"ok":true,"clips":[
 *      {"track":0,"mediaPath":"D:/foo.wav","startSec":0,"endSec":120.5,
 *       "inSec":0,"outSec":120.5,"speed":1}
 *   ]}
 */
function qcGetAudioClips() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) {
            return '{"ok":false,"error":"No active sequence."}';
        }

        var parts = [];
        var t, c;
        for (t = 0; t < seq.audioTracks.numTracks; t++) {
            var clips = seq.audioTracks[t].clips;
            for (c = 0; c < clips.numItems; c++) {
                var clip = clips[c];
                var mediaPath = "";
                try {
                    if (clip.projectItem && clip.projectItem.getMediaPath) {
                        mediaPath = clip.projectItem.getMediaPath();
                    }
                } catch (mp) { mediaPath = ""; }

                if (!mediaPath) { continue; } // skip generators / offline

                var speed = 1.0;
                try { speed = clip.getSpeed(); } catch (sp) { speed = 1.0; }

                parts.push(
                    '{"track":' + t +
                    ',"mediaPath":"' + qc_jsonEscape(mediaPath) + '"' +
                    ',"startSec":' + clip.start.seconds +
                    ',"endSec":' + clip.end.seconds +
                    ',"inSec":' + clip.inPoint.seconds +
                    ',"outSec":' + clip.outPoint.seconds +
                    ',"speed":' + speed +
                    '}'
                );
            }
        }

        return '{"ok":true,"clips":[' + parts.join(",") + ']}';
    } catch (e) {
        return '{"ok":false,"error":"' + qc_jsonEscape(e.toString()) + '"}';
    }
}

/** Move the playhead to a given time (seconds) so the user can preview a spot. */
function qcSetPlayhead(sec) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) { return '{"ok":false,"error":"No active sequence."}'; }
        var ticks = String(Math.round(parseFloat(sec) * QC_TICKS_PER_SECOND));
        seq.setPlayerPosition(ticks);
        return '{"ok":true}';
    } catch (e) {
        return '{"ok":false,"error":"' + qc_jsonEscape(e.toString()) + '"}';
    }
}

/**
 * Drop sequence markers at the given times so the editor can jump to each
 * AI-detected moment and add a zoom by hand. Non-destructive: it only ADDS
 * markers — it never touches clips or the user's existing markers.
 *
 * createMarker() takes a time in SECONDS (not ticks); moment starts are already
 * sequence-relative seconds (same value used to move the playhead).
 *
 * @param {string} spec  "t|note;t|note;..."  t = seconds, note = optional comment
 * @param {string|number} colorIndex  Premiere marker color 0..7 (default 3)
 * @return {string} JSON {"ok":true,"count":N}
 */
function qcAddZoomMarkers(spec, colorIndex) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) { return '{"ok":false,"error":"No active sequence."}'; }
        if (!spec) { return '{"ok":false,"error":"No moments to mark."}'; }
        var ci = parseInt(colorIndex, 10);
        if (isNaN(ci)) { ci = 3; }
        var items = String(spec).split(";");
        var count = 0;
        for (var i = 0; i < items.length; i++) {
            if (!items[i]) { continue; }
            var seg = items[i].split("|");
            var t = parseFloat(seg[0]);
            if (isNaN(t)) { continue; }
            if (t < 0) { t = 0; }
            var note = (seg.length > 1) ? seg[1] : "";
            var m = seq.markers.createMarker(t);
            try { m.name = "Zoom " + (count + 1); } catch (eN) {}
            if (note) { try { m.comments = note; } catch (eC) {} }
            try { m.setColorByIndex(ci); } catch (eCol) {}
            count++;
        }
        return '{"ok":true,"count":' + count + '}';
    } catch (e) {
        return '{"ok":false,"error":"' + qc_jsonEscape(e.toString()) + '"}';
    }
}

/** Name of the active sequence, so the panel can show what's being edited. */
function qcActiveSequenceName() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) { return '{"ok":false,"error":"No active sequence."}'; }
        return '{"ok":true,"name":"' + qc_jsonEscape(seq.name) + '"}';
    } catch (e) {
        return '{"ok":false,"error":"' + qc_jsonEscape(e.toString()) + '"}';
    }
}

/**
 * Duplicate the active sequence on demand (user-triggered) and switch to the
 * copy. Operations themselves no longer auto-duplicate — the user decides when
 * they want a safety copy, then runs as many actions on it as they like.
 *
 * @return {string} JSON {"ok":true,"name":"My Seq - Naifu"}
 */
function qcDuplicateSequence() {
    try {
        var original = app.project.activeSequence;
        if (!original) {
            return '{"ok":false,"error":"No active sequence to duplicate."}';
        }

        // Snapshot existing sequence IDs so we can find the new clone.
        var beforeIds = {};
        var i;
        for (i = 0; i < app.project.sequences.numSequences; i++) {
            beforeIds[app.project.sequences[i].sequenceID] = true;
        }

        original.clone(); // returns boolean; the clone lands in app.project.sequences

        // Find the sequence that wasn't there before.
        var clone = null;
        for (i = 0; i < app.project.sequences.numSequences; i++) {
            var s = app.project.sequences[i];
            if (!beforeIds[s.sequenceID]) { clone = s; break; }
        }
        if (!clone) {
            return '{"ok":false,"error":"Could not locate the duplicated sequence."}';
        }

        // Try to give it a clear name. Some versions make name read-only.
        var desired = original.name + " - Naifu";
        try { clone.name = desired; } catch (rn) {}

        // Make the clone the active/front sequence so edits apply to it.
        try { app.project.openSequence(clone.sequenceID); } catch (os) {}

        return '{"ok":true,"name":"' + qc_jsonEscape(clone.name) + '"}';
    } catch (e) {
        return '{"ok":false,"error":"' + qc_jsonEscape(e.toString()) + '"}';
    }
}

/** Razor every track at `sec`; return the actual frame-aligned tick of the cut. */
function qc_razorAt(seq, qeSeq, sec) {
    var ticks = String(Math.round(sec * QC_TICKS_PER_SECOND));
    seq.setPlayerPosition(ticks);
    // Read back: the playhead snaps to a frame boundary, so this is the exact
    // tick the cut will land on. We match clips against it later.
    var actual = seq.getPlayerPosition().ticks;
    qeSeq.razor(qeSeq.CTI.timecode);
    return Number(actual);
}

/**
 * Classify one track for the time range [sT,eT] (both boundaries already razored):
 *   "tiled"    - clips fully cover the range; rippling them shifts this track by (eT-sT).
 *   "empty-ok" - nothing in the range AND nothing at/after it; nothing to shift, safe.
 *   "unsafe"   - a gap inside the range, a clip straddling a boundary, OR empty-in-range
 *                with content after it (rippling other tracks would drift this one out
 *                of sync). Callers skip the whole range when ANY track is "unsafe".
 * remove(true,true) ripples only its own track, so per-track shifts stay in sync only
 * when every track moves by the same (eT-sT) — hence this all-or-nothing gate.
 */
function qc_trackRangeStatus(track, sT, eT, tolTicks) {
    var clips = track.clips;
    var sum = 0, hasInRange = false, hasTail = false, c;
    for (c = 0; c < clips.numItems; c++) {
        var cs = Number(clips[c].start.ticks);
        var ce = Number(clips[c].end.ticks);
        if (ce <= sT + tolTicks) { continue; }               // fully before the range
        if (cs >= eT - tolTicks) { hasTail = true; continue; } // at/after the range end
        if (cs >= sT - tolTicks && ce <= eT + tolTicks) {
            sum += (ce - cs); hasInRange = true;             // clip fully inside
        } else {
            return "unsafe";                                 // straddles a boundary
        }
    }
    if (hasInRange && Math.abs(sum - (eT - sT)) <= tolTicks * 2) { return "tiled"; }
    if (!hasInRange) { return hasTail ? "unsafe" : "empty-ok"; }
    return "unsafe";                                          // partial coverage (a gap)
}

/**
 * Ripple-delete the clips filling [sT,eT] on one "tiled" track, front-to-back.
 * Each ripple removal pulls the next in-range clip to start at sT, so we always
 * remove whatever clip is currently sitting at sT, exactly (count) times.
 * @return {number} clips removed.
 */
function qc_rippleTrackRange(track, sT, eT, tolTicks) {
    var clips = track.clips;
    var k = 0, c;
    for (c = 0; c < clips.numItems; c++) {
        var cs = Number(clips[c].start.ticks);
        var ce = Number(clips[c].end.ticks);
        if (cs >= sT - tolTicks && ce <= eT + tolTicks && ce > sT + tolTicks) { k++; }
    }
    var done = 0, guard = 0;
    while (done < k && guard < 1000) {
        guard++;
        var hit = false;
        for (c = 0; c < clips.numItems; c++) {
            if (Math.abs(Number(clips[c].start.ticks) - sT) <= tolTicks) {
                clips[c].remove(true, true);
                done++; hit = true;
                break;
            }
        }
        if (!hit) { break; }
    }
    return done;
}

/**
 * Apply silence cuts to the (already duplicated) active sequence.
 *
 * @param {string} rangesStr  "start,end;start,end;..." in seconds, ascending.
 * @return {string} JSON {"ok":true,"cuts":<applied>,"skipped":<N>,"requested":<total>}
 *                  `cuts` is ranges actually removed; `skipped` is ranges left alone
 *                  because a track couldn't take them cleanly (gap / straddle / would
 *                  desync). cuts + skipped === requested.
 */
function qcApplySilenceCuts(rangesStr) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) {
            return '{"ok":false,"error":"No active sequence."}';
        }
        if (!rangesStr) {
            return '{"ok":false,"error":"No cuts provided."}';
        }

        app.enableQE();
        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq) {
            return '{"ok":false,"error":"QE DOM unavailable; cannot razor."}';
        }

        var tolTicks = Number(seq.timebase); // ~one frame of slack when matching
        if (!tolTicks || isNaN(tolTicks)) { tolTicks = QC_TICKS_PER_SECOND / 24; }

        // Parse "s,e;s,e" into pairs of seconds.
        var raw = rangesStr.split(";");
        var pairs = [];
        var i;
        for (i = 0; i < raw.length; i++) {
            if (!raw[i]) { continue; }
            var ab = raw[i].split(",");
            if (ab.length === 2) {
                pairs.push([parseFloat(ab[0]), parseFloat(ab[1])]);
            }
        }
        if (pairs.length === 0) {
            return '{"ok":false,"error":"No valid cut ranges."}';
        }

        // Pass 1: razor every boundary. Splitting moves nothing, so order is safe.
        var cuts = [];
        for (i = 0; i < pairs.length; i++) {
            var sT = qc_razorAt(seq, qeSeq, pairs[i][0]);
            var eT = qc_razorAt(seq, qeSeq, pairs[i][1]);
            cuts.push([sT, eT]);
        }

        // Pass 2: remove back-to-front (so a removal's ripple doesn't shift the
        // ranges we haven't processed yet). A range is applied ONLY if every track
        // can take it cleanly — otherwise it's skipped, so we never half-cut a range
        // and drift audio out of sync with video.
        var removed = 0, skipped = 0, t;
        for (i = cuts.length - 1; i >= 0; i--) {
            var sTk = cuts[i][0], eTk = cuts[i][1];

            var safe = true;
            for (t = 0; t < seq.videoTracks.numTracks && safe; t++) {
                if (qc_trackRangeStatus(seq.videoTracks[t], sTk, eTk, tolTicks) === "unsafe") { safe = false; }
            }
            for (t = 0; t < seq.audioTracks.numTracks && safe; t++) {
                if (qc_trackRangeStatus(seq.audioTracks[t], sTk, eTk, tolTicks) === "unsafe") { safe = false; }
            }
            if (!safe) { skipped++; continue; }

            var rem = 0;
            for (t = 0; t < seq.videoTracks.numTracks; t++) {
                if (qc_trackRangeStatus(seq.videoTracks[t], sTk, eTk, tolTicks) === "tiled") {
                    rem += qc_rippleTrackRange(seq.videoTracks[t], sTk, eTk, tolTicks);
                }
            }
            for (t = 0; t < seq.audioTracks.numTracks; t++) {
                if (qc_trackRangeStatus(seq.audioTracks[t], sTk, eTk, tolTicks) === "tiled") {
                    rem += qc_rippleTrackRange(seq.audioTracks[t], sTk, eTk, tolTicks);
                }
            }
            if (rem > 0) { removed++; } else { skipped++; }
        }

        return '{"ok":true,"cuts":' + removed + ',"skipped":' + skipped + ',"requested":' + pairs.length + '}';
    } catch (e) {
        return '{"ok":false,"error":"' + qc_jsonEscape(e.toString()) + '"}';
    }
}

/* =========================================================================
 * PHASE 2 - Auto punch-in zoom
 * ========================================================================= */

/**
 * List the video clips ("segments") on the active sequence so the panel can
 * decide which to zoom (and measure their loudness for "smart" placement).
 * Read-only.
 */
function qcGetVideoClips() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) { return '{"ok":false,"error":"No active sequence."}'; }

        var parts = [];
        var t, c;
        for (t = 0; t < seq.videoTracks.numTracks; t++) {
            var clips = seq.videoTracks[t].clips;
            for (c = 0; c < clips.numItems; c++) {
                var clip = clips[c];
                var mediaPath = "";
                try {
                    if (clip.projectItem && clip.projectItem.getMediaPath) {
                        mediaPath = clip.projectItem.getMediaPath();
                    }
                } catch (mp) { mediaPath = ""; }
                // The clip's timeline name — editors often rename clips to the
                // speaker, so Story uses it to attribute who says what.
                var nm = "";
                try { nm = String(clip.name); } catch (nmE) { nm = ""; }

                parts.push(
                    '{"track":' + t +
                    ',"startTicks":' + clip.start.ticks +
                    ',"startSec":' + clip.start.seconds +
                    ',"endSec":' + clip.end.seconds +
                    ',"inSec":' + clip.inPoint.seconds +
                    ',"outSec":' + clip.outPoint.seconds +
                    ',"mediaPath":"' + qc_jsonEscape(mediaPath) + '"' +
                    ',"name":"' + qc_jsonEscape(nm) + '"' +
                    '}'
                );
            }
        }
        return '{"ok":true,"clips":[' + parts.join(",") + ']}';
    } catch (e) {
        return '{"ok":false,"error":"' + qc_jsonEscape(e.toString()) + '"}';
    }
}

/** Find a video clip on a track by its (frame-aligned) start tick. */
function qc_findVideoClip(seq, trackIndex, startTicks, tolTicks) {
    if (trackIndex >= seq.videoTracks.numTracks) { return null; }
    var clips = seq.videoTracks[trackIndex].clips;
    for (var c = 0; c < clips.numItems; c++) {
        if (Math.abs(Number(clips[c].start.ticks) - startTicks) <= tolTicks) {
            return clips[c];
        }
    }
    return null;
}

/** Locate a clip's Motion > Scale parameter (by name, with index fallback). */
function qc_getMotionScale(clip) {
    var comps = clip.components;
    var motion = null;
    var i;
    for (i = 0; i < comps.numItems; i++) {
        if (String(comps[i].displayName) === "Motion") { motion = comps[i]; break; }
    }
    if (!motion && comps.numItems > 1) { motion = comps[1]; } // typical Motion index
    if (!motion) { return null; }

    var props = motion.properties;
    var scale = null;
    for (i = 0; i < props.numItems; i++) {
        if (String(props[i].displayName) === "Scale") { scale = props[i]; break; }
    }
    if (!scale && props.numItems > 1) { scale = props[1]; } // typical Scale index
    return scale;
}

/** Add one Scale keyframe; tries a Time object first, falls back to seconds. */
function qc_addScaleKey(scaleProp, timeObj, secs, value) {
    try {
        scaleProp.addKey(timeObj);
        scaleProp.setValueAtKey(timeObj, value, true);
        return true;
    } catch (e1) {
        try {
            scaleProp.addKey(secs);
            scaleProp.setValueAtKey(secs, value, true);
            return true;
        } catch (e2) {
            return false;
        }
    }
}

/** Build a Time object at the given number of seconds. */
function qc_timeAt(secs) {
    var T = new Time();
    T.seconds = secs;
    return T;
}

/** Recursively search the project for an adjustment-layer project item. */
function qc_findAdjustmentLayerItem(item) {
    var kids = item.children;
    if (!kids) { return null; }
    for (var i = 0; i < kids.numItems; i++) {
        var c = kids[i];
        if (String(c.name).toLowerCase().indexOf("adjustment") !== -1) { return c; }
        try {
            if (c.children && c.children.numItems > 0) {
                var found = qc_findAdjustmentLayerItem(c);
                if (found) { return found; }
            }
        } catch (e) {}
    }
    return null;
}

/**
 * Pick the highest video track that is safe to drop zoom layers on — i.e. empty,
 * or already holding only our adjustment-layer zooms. An adjustment layer here
 * affects every track below it, which is what we want.
 */
function qc_findZoomTrack(seq) {
    for (var t = seq.videoTracks.numTracks - 1; t >= 0; t--) {
        var clips = seq.videoTracks[t].clips;
        var usable = true;
        for (var c = 0; c < clips.numItems; c++) {
            if (String(clips[c].name).toLowerCase().indexOf("adjustment") === -1) {
                usable = false; break;
            }
        }
        if (usable) { return t; }
    }
    return -1;
}

/**
 * Get the scale parameter(s) of a named effect on a clip. The Transform effect
 * exposes a single "Scale" when Uniform Scale is on, but separate "Scale Height"
 * and "Scale Width" when it's off — so we return whichever set is present and
 * drive them together.
 */
function qc_getScaleProps(clip, effectDisplayName) {
    var comps = clip.components;
    var comp = null, i;
    for (i = 0; i < comps.numItems; i++) {
        if (String(comps[i].displayName) === effectDisplayName) { comp = comps[i]; break; }
    }
    if (!comp) { return []; }

    var props = comp.properties;
    var single = null, h = null, w = null;
    for (i = 0; i < props.numItems; i++) {
        var dn = String(props[i].displayName);
        if (dn === "Scale") { single = props[i]; }
        else if (dn === "Scale Height") { h = props[i]; }
        else if (dn === "Scale Width") { w = props[i]; }
    }
    if (single) { return [single]; }
    var arr = [];
    if (h) { arr.push(h); }
    if (w) { arr.push(w); }
    return arr;
}

/**
 * Premiere keyframe interpolation type codes (ComponentParam.setInterpolationTypeAtKey).
 * 0 = Linear, 4 = Hold, 5 = Bezier (smooth ease). Codes 1/2/3 are obsolete no-ops
 * that silently render LINEAR — passing 2 was the cause of "no easing".
 */
var QC_KF_LINEAR = 0;
var QC_KF_BEZIER = 5;

/** Best-effort: set a keyframe's interpolation type (ignored if unsupported). */
function qc_setInterp(prop, timeObj, secs, type) {
    try { prop.setInterpolationTypeAtKey(timeObj, type, true); return; } catch (e1) {}
    try { prop.setInterpolationTypeAtKey(secs, type, true); } catch (e2) {}
}

/**
 * Set one scale property: a constant hold, or a ramp 100 -> amount -> 100.
 * Keyframe times on a clip's effect are CLIP-RELATIVE (measured from the clip's
 * in-point), not sequence time.
 *
 * @param rampSec  time to push in / out (the ramp speed).
 * @param easeCode 1 = smooth (Bezier), 0 = linear.
 */
function qc_applyScale(prop, clip, amount, style, rampSec, easeCode) {
    if (style !== 1) {
        try { prop.setValue(amount, true); return true; }
        catch (e) { return false; }
    }

    var base = 0;
    try { base = clip.inPoint.seconds; } catch (e1) {}
    var dur = 1;
    try { dur = clip.end.seconds - clip.start.seconds; } catch (e2) {}
    if (!(dur > 0)) { dur = 1; }

    var ease = rampSec;
    if (isNaN(ease) || ease < 0.05) { ease = 0.05; }
    if (ease > dur / 2) { ease = dur / 2; } // can't ramp longer than half the clip

    var times = [base, base + ease, base + dur - ease, base + dur];
    var vals = [100, amount, amount, 100];

    try { prop.setTimeVarying(true); } catch (tv) {}
    var ok = false;
    var interp = (easeCode === 0) ? QC_KF_LINEAR : QC_KF_BEZIER;
    for (var i = 0; i < 4; i++) {
        if (qc_addScaleKey(prop, qc_timeAt(times[i]), times[i], vals[i])) {
            ok = true;
            qc_setInterp(prop, qc_timeAt(times[i]), times[i], interp);
        }
    }
    return ok;
}

/** Find a QE track item (by start tick) whose name looks like an adjustment layer. */
function qc_findQeItem(qeTrack, startTicks, tolTicks) {
    var n = qeTrack.numItems;
    for (var i = 0; i < n; i++) {
        var it = qeTrack.getItemAt(i);
        if (!it) { continue; }
        var nm = "";
        try { nm = String(it.name); } catch (e1) {}
        if (nm.toLowerCase().indexOf("adjustment") === -1) { continue; }
        var t = NaN;
        try { t = Number(it.start.ticks); } catch (e2) {}
        if (!isNaN(t) && Math.abs(t - startTicks) <= tolTicks) { return it; }
    }
    return null;
}

/** Find a placed clip on a track by start tick (within tolerance). */
function qc_findClipByTicks(vt, startTicks, tolTicks) {
    for (var c = 0; c < vt.clips.numItems; c++) {
        if (Math.abs(Number(vt.clips[c].start.ticks) - startTicks) <= tolTicks) {
            return vt.clips[c];
        }
    }
    return null;
}

/**
 * Lay an adjustment layer over each emphatic moment and scale it so the footage
 * BELOW zooms, then returns to normal. An adjustment layer's intrinsic Motion
 * does NOT affect lower tracks — only an applied effect does — so we add the
 * Transform effect (via QE DOM) to each layer and scale that. Non-destructive:
 * the footage underneath is untouched, and zooms wipe with qcClearZooms.
 *
 * @param {string} spec  "t1,t2,amount,style;..." (seconds) where
 *    style 0 = hold at `amount`, style 1 = ramp 100 -> amount -> 100.
 * @return {string} JSON {"ok":true,"applied":N,"failed":M,"track":idx}
 */
function qcApplyZoomLayers(spec) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) { return '{"ok":false,"error":"No active sequence."}'; }
        if (!spec) { return '{"ok":false,"error":"No zoom instructions."}'; }

        var al = qc_findAdjustmentLayerItem(app.project.rootItem);
        if (!al) {
            return '{"ok":false,"needAL":true,"error":"No adjustment layer in the project. Create one (File > New > Adjustment Layer), then try again."}';
        }

        var track = qc_findZoomTrack(seq);
        if (track < 0) {
            return '{"ok":false,"error":"No free video track for zooms. Add an empty video track above your footage and try again."}';
        }
        var vt = seq.videoTracks[track];
        var tolTicks = Number(seq.timebase);
        if (!tolTicks || isNaN(tolTicks)) { tolTicks = QC_TICKS_PER_SECOND / 24; }

        // --- Phase A: place + trim every adjustment layer (standard DOM) ---
        var rows = spec.split(";");
        var placed = [];
        var i, c;
        for (i = 0; i < rows.length; i++) {
            if (!rows[i]) { continue; }
            var f = rows[i].split(",");
            if (f.length < 4) { continue; }
            var t1 = parseFloat(f[0]);
            var t2 = parseFloat(f[1]);
            var amount = parseFloat(f[2]);
            var style = parseInt(f[3], 10);
            var rampSec = f.length > 4 ? parseFloat(f[4]) : 0.5;
            var easeCode = f.length > 5 ? parseInt(f[5], 10) : 1;

            try { vt.overwriteClip(al, t1); } catch (ov) { continue; }

            var startTicks = Math.round(t1 * QC_TICKS_PER_SECOND);
            var clip = qc_findClipByTicks(vt, startTicks, tolTicks);
            if (!clip) { continue; }
            try { clip.end = qc_timeAt(t2); } catch (te) {}

            placed.push({
                ticks: Number(clip.start.ticks),
                amount: amount, style: style, ramp: rampSec, ease: easeCode
            });
        }
        if (placed.length === 0) {
            return '{"ok":false,"error":"Could not place any zoom layers on V' + (track + 1) + '."}';
        }

        // --- Phase B: add Transform effect via QE + set its Scale ---
        app.enableQE();
        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq) { return '{"ok":false,"error":"QE DOM unavailable."}'; }
        var transform = qe.project.getVideoEffectByName("Transform");
        if (!transform) { return '{"ok":false,"error":"Could not find the \\"Transform\\" effect."}'; }
        var qeVT = qeSeq.getVideoTrackAt(track);
        if (!qeVT) { return '{"ok":false,"error":"QE track unavailable."}'; }

        var applied = 0, failed = 0;
        for (i = 0; i < placed.length; i++) {
            var qeItem = qc_findQeItem(qeVT, placed[i].ticks, tolTicks);
            if (!qeItem) { failed++; continue; }
            try { qeItem.addVideoEffect(transform); } catch (ae) { failed++; continue; }

            var clip2 = qc_findClipByTicks(vt, placed[i].ticks, tolTicks);
            if (!clip2) { failed++; continue; }
            var sprops = qc_getScaleProps(clip2, "Transform");
            if (sprops.length === 0) { failed++; continue; }

            // Drive Scale Height + Width together (or the single Scale) so the
            // zoom is uniform regardless of the Uniform Scale checkbox.
            var ok = false;
            for (var p = 0; p < sprops.length; p++) {
                if (qc_applyScale(sprops[p], clip2, placed[i].amount, placed[i].style, placed[i].ramp, placed[i].ease)) {
                    ok = true;
                }
            }
            if (ok) { applied++; } else { failed++; }
        }
        return '{"ok":true,"applied":' + applied + ',"failed":' + failed + ',"track":' + track + '}';
    } catch (e) {
        return '{"ok":false,"error":"' + qc_jsonEscape(e.toString()) + '"}';
    }
}

/* =========================================================================
 * PHASE 5 - Vox Pop (assemble a montage from approved soundbites)
 * ========================================================================= */

/** Walk every video track in the same order qcGetVideoClips() used, returning
 * for each clip its project (master) item plus the clip's source-media in/out
 * (seconds). The panel's clipIndex indexes into this flat list, so this is how
 * we map a soundbite back to its source media — and the in/out bounds let us
 * pad a soundbite without ever running past what that clip actually covers. */
function qc_collectVideoProjectItems(seq) {
    var items = [];
    var t, c;
    for (t = 0; t < seq.videoTracks.numTracks; t++) {
        var clips = seq.videoTracks[t].clips;
        for (c = 0; c < clips.numItems; c++) {
            var pi = null, inSec = 0, outSec = 0;
            try { pi = clips[c].projectItem; } catch (e) {}
            try { inSec = Number(clips[c].inPoint.seconds); } catch (e) {}
            try { outSec = Number(clips[c].outPoint.seconds); } catch (e) {}
            items.push({ pi: pi, inSec: inSec, outSec: outSec });
        }
    }
    return items;
}

/** Remove every clip from all tracks of a sequence (no ripple needed). */
function qc_emptySequence(seq) {
    var t, c;
    for (t = 0; t < seq.videoTracks.numTracks; t++) {
        var vc = seq.videoTracks[t].clips;
        for (c = vc.numItems - 1; c >= 0; c--) {
            try { vc[c].remove(false, false); } catch (e) {}
        }
    }
    for (t = 0; t < seq.audioTracks.numTracks; t++) {
        var ac = seq.audioTracks[t].clips;
        for (c = ac.numItems - 1; c >= 0; c--) {
            try { ac[c].remove(false, false); } catch (e) {}
        }
    }
}

/** Clone the given sequence, rename it, make it active, return the clone. */
function qc_cloneAndOpen(source, newName) {
    var beforeIds = {};
    var i;
    for (i = 0; i < app.project.sequences.numSequences; i++) {
        beforeIds[app.project.sequences[i].sequenceID] = true;
    }
    source.clone();
    var clone = null;
    for (i = 0; i < app.project.sequences.numSequences; i++) {
        var s = app.project.sequences[i];
        if (!beforeIds[s.sequenceID]) { clone = s; break; }
    }
    if (!clone) { return null; }
    try { clone.name = newName; } catch (rn) {}
    try { app.project.openSequence(clone.sequenceID); } catch (os) {}
    return clone;
}

/**
 * Assemble the approved Vox Pop plan into a brand-new sequence: the question
 * once, then each soundbite in playback order, pulled from the SOURCE media of
 * the original interview clips. Non-destructive: it clones the current sequence
 * (so resolution/frame rate match), empties the copy, and lays the chosen
 * sub-ranges end to end. Both video and audio come along (overwriteClip always
 * carries the linked audio). The originals are untouched.
 *
 * @param {string} spec  "clipIndex,srcStart,srcEnd;..." in seconds, playback order.
 * @param {number} pad   seconds of breath to keep on each side of a soundbite
 *                       (clamped to the clip's own source range so it never
 *                       bleeds past what that clip covers). Optional.
 * @param {string} label sequence-name suffix (default "Vox Pop"; e.g. "Story").
 * @return {string} JSON {"ok":true,"name":"... - <label>","placed":N,"skipped":M}
 */
function qcBuildVoxPop(spec, pad, label) {
    try {
        var source = app.project.activeSequence;
        if (!source) { return '{"ok":false,"error":"No active sequence."}'; }
        if (!spec) { return '{"ok":false,"error":"No soundbites to assemble."}'; }

        var labelStr = (label && String(label)) ? String(label) : "Vox Pop";
        var padSec = parseFloat(pad);
        if (isNaN(padSec) || padSec < 0) { padSec = 0; }

        // Resolve source project items BEFORE we clone/switch sequences.
        var projItems = qc_collectVideoProjectItems(source);

        // Parse the plan.
        var rows = spec.split(";");
        var plan = [];
        var i;
        for (i = 0; i < rows.length; i++) {
            if (!rows[i]) { continue; }
            var f = rows[i].split(",");
            if (f.length < 3) { continue; }
            var ci = parseInt(f[0], 10);
            var s = parseFloat(f[1]);
            var e = parseFloat(f[2]);
            if (isNaN(ci) || isNaN(s) || isNaN(e) || e <= s) { continue; }
            if (ci < 0 || ci >= projItems.length || !projItems[ci] || !projItems[ci].pi) { continue; }

            // Pad outward for breath, but never past this clip's own source range.
            var src = projItems[ci];
            var lo = s - padSec, hi = e + padSec;
            if (src.outSec > src.inSec) {
                if (lo < src.inSec) { lo = src.inSec; }
                if (hi > src.outSec) { hi = src.outSec; }
            }
            if (lo < 0) { lo = 0; }
            if (hi <= lo) { continue; }
            plan.push({ pi: src.pi, s: lo, e: hi });
        }
        if (plan.length === 0) {
            return '{"ok":false,"error":"No valid soundbites in the plan."}';
        }

        // Snapshot each source's in/out so we can restore them after — we trim the
        // master clip to place each piece, and a documentary reuses one source many
        // times, so leaving its marks moved would surprise the editor later.
        var snap = [];
        for (i = 0; i < plan.length; i++) {
            var dup = false, q;
            for (q = 0; q < snap.length; q++) { if (snap[q].pi === plan[i].pi) { dup = true; break; } }
            if (dup) { continue; }
            var inT = null, outT = null;
            try { inT = plan[i].pi.getInPoint().ticks; } catch (e1) {}
            try { outT = plan[i].pi.getOutPoint().ticks; } catch (e2) {}
            snap.push({ pi: plan[i].pi, inT: inT, outT: outT });
        }

        // Make the assembled sequence: clone (matches settings) then empty it.
        var clone = qc_cloneAndOpen(source, source.name + " - " + labelStr);
        if (!clone) {
            return '{"ok":false,"error":"Could not create the ' + qc_jsonEscape(labelStr) + ' sequence."}';
        }
        var seq = app.project.activeSequence; // now the clone
        qc_emptySequence(seq);

        var vt = seq.videoTracks[0];
        if (!vt) { return '{"ok":false,"error":"The new sequence has no video track."}'; }
        var tolTicks = Number(seq.timebase);
        if (!tolTicks || isNaN(tolTicks)) { tolTicks = QC_TICKS_PER_SECOND / 24; }

        var placed = 0, skipped = 0;
        var playhead = 0; // seconds; where the next soundbite begins
        for (i = 0; i < plan.length; i++) {
            var pi = plan[i].pi;
            // In/out are ticks STRINGS (a bare number would be read as seconds);
            // mediaType 4 = all media, so both video and audio trim together.
            try {
                pi.setInPoint(String(Math.round(plan[i].s * QC_TICKS_PER_SECOND)), 4);
                pi.setOutPoint(String(Math.round(plan[i].e * QC_TICKS_PER_SECOND)), 4);
            } catch (sp) {}

            var ok = false;
            try { ok = vt.overwriteClip(pi, playhead); } catch (ov) { ok = false; }
            if (ok === false) { skipped++; continue; }

            // Read back the clip we just placed and advance to its real end, so
            // the next soundbite butts up against it even if the trim landed a
            // frame off (self-correcting, no overlaps or gaps).
            var startTicks = Math.round(playhead * QC_TICKS_PER_SECOND);
            var justPlaced = qc_findClipByTicks(vt, startTicks, tolTicks);
            if (justPlaced) {
                playhead = Number(justPlaced.end.seconds);
                placed++;
            } else {
                // Couldn't locate it; fall back to the planned duration.
                playhead += (plan[i].e - plan[i].s);
                placed++;
            }
        }

        // Restore each source clip's original in/out marks (best-effort).
        for (i = 0; i < snap.length; i++) {
            try { if (snap[i].inT != null) { snap[i].pi.setInPoint(String(snap[i].inT), 4); } } catch (e3) {}
            try { if (snap[i].outT != null) { snap[i].pi.setOutPoint(String(snap[i].outT), 4); } } catch (e4) {}
        }

        return '{"ok":true,"name":"' + qc_jsonEscape(seq.name) +
            '","placed":' + placed + ',"skipped":' + skipped + '}';
    } catch (e) {
        return '{"ok":false,"error":"' + qc_jsonEscape(e.toString()) + '"}';
    }
}

/** Set a list of clip-relative scale keyframes (times given as absolute seconds
 *  offset from runStart). Used by qcApplyZoomRuns for held/escalating zooms. */
function qc_setScaleKeys(prop, clip, runStart, kfs, easeCode) {
    var base = 0;
    try { base = clip.inPoint.seconds; } catch (e1) {}
    try { prop.setTimeVarying(true); } catch (tv) {}
    var interp = (easeCode === 0) ? QC_KF_LINEAR : QC_KF_BEZIER;
    var ok = false;
    for (var i = 0; i < kfs.length; i++) {
        var t = base + (kfs[i].t - runStart);
        if (qc_addScaleKey(prop, qc_timeAt(t), t, kfs[i].v)) {
            ok = true;
            qc_setInterp(prop, qc_timeAt(t), t, interp);
        }
    }
    return ok;
}

/**
 * Lay one adjustment layer per RUN of zoom keyframes. A run is a single layer
 * spanning its first..last keyframe time, animated through an arbitrary list of
 * scale stops — so back-to-back emphasis can HOLD and escalate inside one layer
 * and release once, instead of popping out and in between adjacent zooms.
 *
 * @param {string} spec  "easeCode,t:v,t:v,...;..." one run per ';' (absolute secs).
 * @return {string} JSON {"ok":true,"applied":N,"failed":M,"track":idx}
 */
function qcApplyZoomRuns(spec) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) { return '{"ok":false,"error":"No active sequence."}'; }
        if (!spec) { return '{"ok":false,"error":"No zoom instructions."}'; }

        var al = qc_findAdjustmentLayerItem(app.project.rootItem);
        if (!al) {
            return '{"ok":false,"needAL":true,"error":"No adjustment layer in the project. Create one (File > New > Adjustment Layer), then try again."}';
        }
        var track = qc_findZoomTrack(seq);
        if (track < 0) {
            return '{"ok":false,"error":"No free video track for zooms. Add an empty video track above your footage and try again."}';
        }
        var vt = seq.videoTracks[track];
        var tolTicks = Number(seq.timebase);
        if (!tolTicks || isNaN(tolTicks)) { tolTicks = QC_TICKS_PER_SECOND / 24; }

        var rows = spec.split(";");
        var placed = [];
        var i, k;
        for (i = 0; i < rows.length; i++) {
            if (!rows[i]) { continue; }
            var f = rows[i].split(",");
            if (f.length < 3) { continue; }
            var easeCode = parseInt(f[0], 10);
            if (isNaN(easeCode)) { easeCode = 1; }
            var kfs = [];
            for (k = 1; k < f.length; k++) {
                var pair = f[k].split(":");
                if (pair.length === 2) {
                    var tt = parseFloat(pair[0]), vv = parseFloat(pair[1]);
                    if (!isNaN(tt) && !isNaN(vv)) { kfs.push({ t: tt, v: vv }); }
                }
            }
            if (kfs.length < 2) { continue; }
            var runStart = kfs[0].t, runEnd = kfs[kfs.length - 1].t;
            try { vt.overwriteClip(al, runStart); } catch (ov) { continue; }
            var startTicks = Math.round(runStart * QC_TICKS_PER_SECOND);
            var clip = qc_findClipByTicks(vt, startTicks, tolTicks);
            if (!clip) { continue; }
            try { clip.end = qc_timeAt(runEnd); } catch (te) {}
            placed.push({ ticks: Number(clip.start.ticks), runStart: runStart, kfs: kfs, ease: easeCode });
        }
        if (placed.length === 0) {
            return '{"ok":false,"error":"Could not place any zoom layers on V' + (track + 1) + '."}';
        }

        app.enableQE();
        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq) { return '{"ok":false,"error":"QE DOM unavailable."}'; }
        var transform = qe.project.getVideoEffectByName("Transform");
        if (!transform) { return '{"ok":false,"error":"Could not find the \\"Transform\\" effect."}'; }
        var qeVT = qeSeq.getVideoTrackAt(track);
        if (!qeVT) { return '{"ok":false,"error":"QE track unavailable."}'; }

        var applied = 0, failed = 0;
        for (i = 0; i < placed.length; i++) {
            var qeItem = qc_findQeItem(qeVT, placed[i].ticks, tolTicks);
            if (!qeItem) { failed++; continue; }
            try { qeItem.addVideoEffect(transform); } catch (ae) { failed++; continue; }
            var clip2 = qc_findClipByTicks(vt, placed[i].ticks, tolTicks);
            if (!clip2) { failed++; continue; }
            var sprops = qc_getScaleProps(clip2, "Transform");
            if (sprops.length === 0) { failed++; continue; }
            var ok = false;
            for (var p = 0; p < sprops.length; p++) {
                if (qc_setScaleKeys(sprops[p], clip2, placed[i].runStart, placed[i].kfs, placed[i].ease)) { ok = true; }
            }
            if (ok) { applied++; } else { failed++; }
        }
        return '{"ok":true,"applied":' + applied + ',"failed":' + failed + ',"track":' + track + '}';
    } catch (e) {
        return '{"ok":false,"error":"' + qc_jsonEscape(e.toString()) + '"}';
    }
}

/* =========================================================================
 * CAMERA PULL - an intro "pull-back" move on an adjustment layer at the start:
 * open punched-in (peak), ease back to a subtle hold (settle), then hold.
 * Built from the user's own captured move; uses the same Transform-via-QE
 * technique as zoom. Cleared by qcClearZooms (it's an adjustment layer).
 * ========================================================================= */

/**
 * Animate the Transform Scale as a pull: peak at clip start -> settle over
 * pullSec, then hold. Keyframe times are clip-relative.
 *
 * easeCode: 0 = linear, 1 = Premiere's default smooth bezier (2 keyframes).
 *   2/3/4 = a BAKED ease-in-out of increasing sharpness — dense linear keyframes
 *   tracing an exponent curve, so we can shape the velocity (fast-then-settle)
 *   that Premiere's bezier handles can't be set to via script. Higher = the move
 *   front-loads harder and settles slower.
 */
function qc_applyCameraPullScale(prop, clip, peak, settle, pullSec, easeCode) {
    var base = 0;
    try { base = clip.inPoint.seconds; } catch (e1) {}
    try { prop.setTimeVarying(true); } catch (tv) {}

    if (easeCode >= 2) {
        var power = easeCode;                              // 2 gentle .. 4 strong
        var steps = Math.max(8, Math.round(pullSec / 0.07)); // ~one key / 70ms
        var ok = false;
        for (var i = 0; i <= steps; i++) {
            var u = i / steps;                             // 0..1 across the pull
            var e = (u < 0.5)
                ? (0.5 * Math.pow(2 * u, power))
                : (1 - 0.5 * Math.pow(2 * (1 - u), power));
            var t = base + u * pullSec;
            var val = peak + (settle - peak) * e;
            if (qc_addScaleKey(prop, qc_timeAt(t), t, val)) {
                ok = true;
                qc_setInterp(prop, qc_timeAt(t), t, QC_KF_LINEAR); // samples define the curve
            }
        }
        return ok;
    }

    // 0 = linear, 1 = smooth bezier: just the two endpoints.
    var interp = (easeCode === 0) ? QC_KF_LINEAR : QC_KF_BEZIER;
    var times = [base, base + pullSec];
    var vals = [peak, settle];
    var ok2 = false;
    for (var k = 0; k < 2; k++) {
        if (qc_addScaleKey(prop, qc_timeAt(times[k]), times[k], vals[k])) {
            ok2 = true;
            qc_setInterp(prop, qc_timeAt(times[k]), times[k], interp);
        }
    }
    return ok2;
}

/**
 * Lay an adjustment layer at the start of the sequence and animate its Transform
 * Scale as a camera pull: open at `peak`%, ease to `settle`% over `pullSec`, hold
 * `settle`% for the rest of `lenSec`. Non-destructive; clear with qcClearZooms.
 *
 * @return {string} JSON {"ok":true,"track":idx,"lenSec":N}
 */
function qcApplyCameraPull(peak, settle, pullSec, lenSec, easeCode) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) { return '{"ok":false,"error":"No active sequence."}'; }

        peak = parseFloat(peak); settle = parseFloat(settle);
        pullSec = parseFloat(pullSec); lenSec = parseFloat(lenSec);
        easeCode = parseInt(easeCode, 10);
        if (isNaN(peak)) { peak = 131; }
        if (isNaN(settle)) { settle = 100; }
        if (isNaN(pullSec) || pullSec <= 0) { pullSec = 2.2; }
        if (isNaN(lenSec) || lenSec < pullSec) { lenSec = Math.max(pullSec + 1, 5); }
        if (isNaN(easeCode)) { easeCode = 1; }

        var al = qc_findAdjustmentLayerItem(app.project.rootItem);
        if (!al) {
            return '{"ok":false,"needAL":true,"error":"No adjustment layer in the project. Create one (File > New > Adjustment Layer), then try again."}';
        }
        var track = qc_findZoomTrack(seq);
        if (track < 0) {
            return '{"ok":false,"error":"No free video track. Add an empty video track above your footage and try again."}';
        }
        var vt = seq.videoTracks[track];
        var tolTicks = Number(seq.timebase);
        if (!tolTicks || isNaN(tolTicks)) { tolTicks = QC_TICKS_PER_SECOND / 24; }

        // Place the adjustment layer at the very start and trim to length.
        try { vt.overwriteClip(al, 0); } catch (ov) {
            return '{"ok":false,"error":"Could not place the camera-pull layer."}';
        }
        var clip = qc_findClipByTicks(vt, 0, tolTicks);
        if (!clip) { return '{"ok":false,"error":"Placed the layer but could not find it to animate."}'; }
        try { clip.end = qc_timeAt(lenSec); } catch (te) {}

        // Add Transform via QE and animate its Scale.
        app.enableQE();
        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq) { return '{"ok":false,"error":"QE DOM unavailable."}'; }
        var transform = qe.project.getVideoEffectByName("Transform");
        if (!transform) { return '{"ok":false,"error":"Could not find the \\"Transform\\" effect."}'; }
        var qeVT = qeSeq.getVideoTrackAt(track);
        if (!qeVT) { return '{"ok":false,"error":"QE track unavailable."}'; }
        var qeItem = qc_findQeItem(qeVT, 0, tolTicks);
        if (!qeItem) { return '{"ok":false,"error":"Could not locate the layer in QE."}'; }
        try { qeItem.addVideoEffect(transform); } catch (ae) {
            return '{"ok":false,"error":"Could not add the Transform effect."}';
        }

        var clip2 = qc_findClipByTicks(vt, 0, tolTicks);
        if (!clip2) { return '{"ok":false,"error":"Lost the layer after adding Transform."}'; }
        var sprops = qc_getScaleProps(clip2, "Transform");
        if (sprops.length === 0) { return '{"ok":false,"error":"No Transform Scale to animate."}'; }

        var ok = false;
        for (var p = 0; p < sprops.length; p++) {
            if (qc_applyCameraPullScale(sprops[p], clip2, peak, settle, pullSec, easeCode)) { ok = true; }
        }
        if (!ok) { return '{"ok":false,"error":"Could not set the camera-pull keyframes."}'; }
        return '{"ok":true,"track":' + track + ',"lenSec":' + lenSec + '}';
    } catch (e) {
        return '{"ok":false,"error":"' + qc_jsonEscape(e.toString()) + '"}';
    }
}

/* =========================================================================
 * INSPECT - read the effects + keyframes off a selected clip
 * (used to capture a user's own look — e.g. a "camera pull" — so the panel
 *  can recreate it as a one-click preset). Read-only.
 * ========================================================================= */

/** First selected track item on the active sequence (video first, then audio). */
function qc_firstSelectedClip(seq) {
    try {
        var sel = seq.getSelection();
        if (sel && sel.length) { return sel[0]; }
    } catch (e) {}
    var t, c;
    for (t = 0; t < seq.videoTracks.numTracks; t++) {
        var vc = seq.videoTracks[t].clips;
        for (c = 0; c < vc.numItems; c++) {
            try { if (vc[c].isSelected()) { return vc[c]; } } catch (e1) {}
        }
    }
    for (t = 0; t < seq.audioTracks.numTracks; t++) {
        var ac = seq.audioTracks[t].clips;
        for (c = 0; c < ac.numItems; c++) {
            try { if (ac[c].isSelected()) { return ac[c]; } } catch (e2) {}
        }
    }
    return null;
}

/** Convert a keyframe time (Time object, seconds, or ticks) to seconds. */
function qc_keyTimeToSec(t) {
    if (t === null || t === undefined) { return 0; }
    try { if (t.seconds !== undefined && t.seconds !== null) { return t.seconds; } } catch (e) {}
    var n = Number(t);
    if (isNaN(n)) { return 0; }
    // Big numbers are ticks; small numbers are already seconds.
    return (n > 1000000) ? (n / QC_TICKS_PER_SECOND) : n;
}

/**
 * Dump every effect (component) on the selected clip, each parameter's current
 * value, and — for animated parameters — their keyframe times + values. The
 * keyframe times are clip-relative (measured from the clip's in-point), which is
 * what we need to recreate the move on a fresh adjustment layer.
 *
 * @return {string} JSON describing the clip's effects.
 */
function qcInspectSelection() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) { return '{"ok":false,"error":"No active sequence."}'; }
        var clip = qc_firstSelectedClip(seq);
        if (!clip) {
            return '{"ok":false,"error":"Select your camera-pull clip on the timeline (click it), then press Inspect."}';
        }

        var base = 0;
        try { base = clip.inPoint.seconds; } catch (e0) {}

        var effects = [];
        var comps = clip.components;
        var i, p;
        for (i = 0; i < comps.numItems; i++) {
            var comp = comps[i];
            var dn = ""; try { dn = String(comp.displayName); } catch (e1) {}
            var mn = ""; try { mn = String(comp.matchName); } catch (e2) {}

            var propsOut = [];
            var props = comp.properties;
            for (p = 0; p < props.numItems; p++) {
                var prop = props[p];
                var pn = ""; try { pn = String(prop.displayName); } catch (e3) {}
                var tv = false; try { tv = !!prop.isTimeVarying(); } catch (e4) {}
                var cur = ""; try { cur = String(prop.getValue()); } catch (e5) {}

                var keysOut = [];
                if (tv) {
                    try {
                        var ks = prop.getKeys();
                        if (ks && ks.length) {
                            for (var kk = 0; kk < ks.length; kk++) {
                                var ksec = qc_keyTimeToSec(ks[kk]) - base; // clip-relative
                                var kval = ""; try { kval = String(prop.getValueAtKey(ks[kk])); } catch (e6) {}
                                keysOut.push('{"t":' + ksec.toFixed(3) + ',"v":"' + qc_jsonEscape(kval) + '"}');
                            }
                        }
                    } catch (e7) {}
                }
                propsOut.push('{"name":"' + qc_jsonEscape(pn) + '","animated":' + tv +
                    ',"value":"' + qc_jsonEscape(cur) + '","keys":[' + keysOut.join(",") + ']}');
            }
            effects.push('{"effect":"' + qc_jsonEscape(dn) + '","matchName":"' + qc_jsonEscape(mn) +
                '","params":[' + propsOut.join(",") + ']}');
        }

        var dur = 0; try { dur = clip.end.seconds - clip.start.seconds; } catch (e8) {}
        return '{"ok":true,"clip":"' + qc_jsonEscape(clip.name) + '","durationSec":' + dur.toFixed(3) +
            ',"effects":[' + effects.join(",") + ']}';
    } catch (e) {
        return '{"ok":false,"error":"' + qc_jsonEscape(e.toString()) + '"}';
    }
}

/* =========================================================================
 * CAPTIONS - sequence info, import + place a rendered overlay, native SRT track
 * ========================================================================= */

/** Width/height/fps/duration of the active sequence, for sizing the overlay. */
function qcSequenceInfo() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) { return '{"ok":false,"error":"No active sequence."}'; }
        var w = 0, h = 0, fps = 0;
        try {
            var st = seq.getSettings();
            if (st) {
                w = Number(st.videoFrameWidth);
                h = Number(st.videoFrameHeight);
                if (st.videoFrameRate && st.videoFrameRate.ticks) {
                    fps = QC_TICKS_PER_SECOND / Number(st.videoFrameRate.ticks);
                }
            }
        } catch (e1) {}
        if (!w || isNaN(w)) { try { w = Number(seq.frameSizeHorizontal); h = Number(seq.frameSizeVertical); } catch (e2) {} }

        var dur = 0, t, c, e;
        for (t = 0; t < seq.videoTracks.numTracks; t++) {
            var vc = seq.videoTracks[t].clips;
            for (c = 0; c < vc.numItems; c++) { e = Number(vc[c].end.seconds); if (e > dur) { dur = e; } }
        }
        for (t = 0; t < seq.audioTracks.numTracks; t++) {
            var ac = seq.audioTracks[t].clips;
            for (c = 0; c < ac.numItems; c++) { e = Number(ac[c].end.seconds); if (e > dur) { dur = e; } }
        }
        if (!(fps > 0) || isNaN(fps)) { fps = 30; }
        if (!w || isNaN(w)) { w = 1920; }
        if (!h || isNaN(h)) { h = 1080; }
        if (!(dur > 0)) { dur = 5; }
        return '{"ok":true,"width":' + Math.round(w) + ',"height":' + Math.round(h) +
            ',"fps":' + (Math.round(fps * 1000) / 1000) + ',"durationSec":' + dur.toFixed(3) + '}';
    } catch (e) {
        return '{"ok":false,"error":"' + qc_jsonEscape(e.toString()) + '"}';
    }
}

function qc_baseName(p) {
    var s = String(p).replace(/\\/g, "/");
    var idx = s.lastIndexOf("/");
    return (idx >= 0) ? s.substr(idx + 1) : s;
}

/** Find a just-imported project item by its file name (most recent match). */
function qc_findImportedByPath(mediaPath) {
    var base = qc_baseName(mediaPath);
    var noExt = base.replace(/\.[^.]+$/, "");
    var root = app.project.rootItem, found = null;
    for (var i = 0; i < root.children.numItems; i++) {
        var nm = ""; try { nm = String(root.children[i].name); } catch (e) {}
        if (nm === base || nm === noExt || nm.indexOf(base) !== -1) { found = root.children[i]; }
    }
    return found;
}

/** Highest video track with no clips (captions sit above everything). */
function qc_findCaptionTrack(seq) {
    for (var t = seq.videoTracks.numTracks - 1; t >= 0; t--) {
        if (seq.videoTracks[t].clips.numItems === 0) { return t; }
    }
    return -1;
}

/** Import a rendered caption overlay and lay it at the sequence start on a free top track. */
function qcImportAndPlace(mediaPath) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) { return '{"ok":false,"error":"No active sequence."}'; }
        try { app.project.importFiles([mediaPath], true, app.project.rootItem, false); }
        catch (ie) { return '{"ok":false,"error":"Import failed: ' + qc_jsonEscape(ie.toString()) + '"}'; }

        var item = qc_findImportedByPath(mediaPath);
        if (!item) { return '{"ok":false,"error":"Imported the overlay but could not find it in the project."}'; }

        var track = qc_findCaptionTrack(seq);
        if (track < 0) { return '{"ok":false,"error":"No empty video track for captions. Add an empty track at the top and try again."}'; }
        try { seq.videoTracks[track].overwriteClip(item, 0); }
        catch (oe) { return '{"ok":false,"error":"Could not place the overlay: ' + qc_jsonEscape(oe.toString()) + '"}'; }
        return '{"ok":true,"track":' + track + '}';
    } catch (e) {
        return '{"ok":false,"error":"' + qc_jsonEscape(e.toString()) + '"}';
    }
}

/** Import an SRT and create a native (editable, unstyled) caption track. */
function qcAddCaptionTrack(srtPath) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) { return '{"ok":false,"error":"No active sequence."}'; }
        try { app.project.importFiles([srtPath], true, app.project.rootItem, false); }
        catch (ie) { return '{"ok":false,"error":"Import failed: ' + qc_jsonEscape(ie.toString()) + '"}'; }

        var item = qc_findImportedByPath(srtPath);
        if (!item) { return '{"ok":false,"error":"Imported the SRT but could not find it in the project."}'; }

        var ok = false;
        try { ok = seq.createCaptionTrack(item, 0); }
        catch (ce) {
            try { ok = seq.createCaptionTrack(item, "0"); }
            catch (ce2) { return '{"ok":false,"error":"createCaptionTrack failed: ' + qc_jsonEscape(ce2.toString()) + '"}'; }
        }
        if (!ok) { return '{"ok":false,"error":"Premiere declined to create the caption track."}'; }
        return '{"ok":true}';
    } catch (e) {
        return '{"ok":false,"error":"' + qc_jsonEscape(e.toString()) + '"}';
    }
}

/** Remove all adjustment-layer zooms from the active sequence (no ripple). */
function qcClearZooms() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) { return '{"ok":false,"error":"No active sequence."}'; }
        var removed = 0;
        var t, c;
        for (t = 0; t < seq.videoTracks.numTracks; t++) {
            var clips = seq.videoTracks[t].clips;
            for (c = clips.numItems - 1; c >= 0; c--) {
                if (String(clips[c].name).toLowerCase().indexOf("adjustment") !== -1) {
                    try { clips[c].remove(false, false); removed++; } catch (rm) {}
                }
            }
        }
        return '{"ok":true,"removed":' + removed + '}';
    } catch (e) {
        return '{"ok":false,"error":"' + qc_jsonEscape(e.toString()) + '"}';
    }
}
