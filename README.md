# QuietCut

A Premiere Pro panel that automates the repetitive parts of talking-head edits:

1. **Silence removal** — cut dead air and long pauses.
2. **Auto punch-in zooms** — make static talking-head footage feel dynamic.
3. **Filler-word removal** — cut "um", "uh", "like", etc. (local Whisper, GPU-accelerated).

Built as a **CEP** panel because, as of mid-2026, the timeline operations this tool
relies on (razor/split at arbitrary times, ripple-delete a range, Motion keyframes)
work reliably in CEP/ExtendScript but are still missing or hacky in UXP.

> **Status: Phase 3 in testing.** Silence removal + auto punch-in zoom (done) +
> filler/repetition removal via local Whisper.

---

## Architecture

```
Premiere Pro
 ├─ CEP Panel (index.html + js/)        the UI: buttons, review lists
 │     │  CSInterface.evalScript()
 │     ▼
 ├─ jsx/host.jsx (ExtendScript)         the ONLY layer that edits the timeline
 │
 └─ (Phase 1+) Python helper on localhost
        runs FFmpeg (silence) and faster-whisper (fillers); returns timestamps
```

All timeline editing is isolated in `jsx/host.jsx`. If Premiere's scripting ever
moves fully to UXP, that one file is what we rewrite.

---

## Install (Windows, one time)

You don't need to install Node or Python for Phase 0 — Premiere hosts the panel.

1. Open a normal PowerShell window in this folder.
2. Run the setup script:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\setup.ps1
   ```

   This does two reversible things:
   - Turns on CEP "unsigned extensions" mode in the registry (`PlayerDebugMode`).
   - Links this folder into Premiere's extensions folder
     (`%APPDATA%\Adobe\CEP\extensions\com.quietcut.panel`) so edits here are live.

3. Fully quit Premiere Pro if it's open, then reopen it.
4. Open a project that has a sequence.
5. **Window → Extensions → QuietCut.**

The setup script also downloads **FFmpeg** into `bin/` (used from Phase 1 on).
No system install or PATH change — it's self-contained.

### Test Phase 1 (silence removal)

1. Open a project with a talking-head sequence in the Timeline.
2. Open the panel (**Window → Extensions → QuietCut**).
3. (Optional) open **Settings** to tune:
   - **Noise threshold** (default −30 dB) — quieter than this counts as silence.
   - **Min silence length** (default 500 ms) — pauses shorter than this are kept.
   - **Padding** (default 100 ms) — breath left around speech so cuts don't clip.
4. (Optional) If you want to keep an untouched copy, click **Duplicate** in the
   top bar first — it makes "… – QuietCut", switches to it, and the bar shows
   you're now editing the copy. Operations always apply to the **active
   sequence** shown there; they never auto-duplicate.
5. Click **Scan for Silences**. The panel reads each audio clip's source file,
   runs FFmpeg's `silencedetect`, and lists the proposed cuts (start → end, duration).
6. Untick anything you want to keep, then click **Apply cuts** — it razors +
   ripple-deletes the chosen silences on the active sequence.

**To undo:** Ctrl+Z (may take a few presses), or — if you clicked Duplicate
first — just delete the "– QuietCut" sequence to revert completely.

### Test Phase 2 (auto punch-in zoom)

Zoom works by laying an **adjustment layer** over just the emphatic moments and
adding a **Transform effect** to it (an adjustment layer's built-in Motion does
not affect lower tracks — only an applied effect does) — so only that stretch of
footage zooms, then returns to normal. The footage underneath is never cut, and
you can wipe all zooms with one button.

**One-time setup:** the panel needs an adjustment layer to reuse. In Premiere,
**File → New → Adjustment Layer** (it lands in your Project panel; leave
"Adjustment Layer" in its name). You only do this once per project.

1. Switch to the **Zoom** tab. (Zooms apply to the active sequence in the top
   bar — click **Duplicate** first if you want a safety copy.) Make sure there's
   an **empty video track above** your footage (the adjustment layer goes there).
2. In **Settings** (sliders):
   - **Zoom amount** — how far to punch in (default 108%).
   - **Max length** — target hold time (default 10s). Each zoom now releases at the
     **end of the spoken sentence** it lands on (from the Whisper transcript, confirmed
     by a real pause) so it doesn't snap out mid-thought; if there's no transcript it
     falls back to a loudness pause. With **Let the sentence finish** on (default), a
     zoom may run a little past Max to reach that boundary; turn it off for a hard cap.
     (Loudness-based zoom now runs a quick transcription pass for these clean cut points.)
   - **How many moments** — Few / Balanced / Many (loudness sensitivity).
   - **Style** — *Hold* (cut in/out) or *Ramp in/out* (ease).
3. Click **Find Zoom Moments** → the panel scans loudness over time, starts a
   punch-in at each emphatic moment, and **holds it until the next natural pause**
   (so each zoom lasts a sentence/phrase, not a couple of words).
4. Untick any you don't want, then click **Apply zooms** → it drops a scaled
   adjustment layer over each chosen moment on the top empty track. **Back-to-back
   moments merge into one layer** that holds the zoom and pushes a little further on
   each beat, releasing once at the end — so the shot doesn't pop out to normal and
   back in between adjacent zooms. Spaced-out moments stay separate.
5. Don't like a result? Click **Clear all zoom layers** to remove every zoom.

**Camera Pull (intro move):** at the bottom of the Zoom tab, expand **Camera Pull**
to drop a "pull-back" reveal at the very start — the shot opens punched-in (**Open at**,
default 131%) and eases back to **Settle to** (default 100% — lands on the normal framing
so there's no jump when the layer ends) over **Pull time** (default 2.2s), holding for
**Hold length**. **Ease** shapes the motion: *Smooth* uses Premiere's default bezier, while
*Gentle / Medium / Strong* "bake" the curve as dense keyframes for a fast-pull-then-long-
settle feel (Premiere scripting can't set bezier handle velocity directly, so the curve is
traced with keyframes instead). It uses the same adjustment-layer + Transform mechanism as
zooms (so it needs an empty track above + an adjustment layer in the project), and **Clear
all zoom layers** removes it too. Defaults were captured from a real editor's own
camera-pull preset.

"How many moments" controls how far above the take's average loudness counts as
emphatic. The review list lets you override any choice.

### Test Phase 3 (fillers + repetitions)

Uses a local, offline **Whisper** speech-to-text (`bin/Faster-Whisper-XXL/`) to get
word-level timestamps, flags fillers + stutters, and cuts them with the same
razor/ripple-delete engine as silence removal. GPU-accelerated automatically if
you have an NVIDIA card; CPU otherwise. Nothing is uploaded.

1. **Fillers** tab. (Cuts apply to the active sequence — click **Duplicate** first
   for a safety copy.)
2. In **Settings**: toggle **Remove filler words** / **Remove repeated words**;
   pick **Accuracy** (Fast `base.en` / Balanced `small.en` / Best `medium.en`);
   edit the **Filler words** list (commas or new lines; supports phrases like
   "you know").
3. **Transcribe & Scan** → first run downloads the chosen model once. The panel
   lists each flagged word with its timestamp and a filler/repeat tag.
4. Untick anything to keep, then **Apply cuts**.

Repetition rule: consecutive repeats ("yeah, yeah, yeah") keep the last and cut
the earlier copies. Whisper word timing can be ±0.1s, so review before applying.

#### How silence detection works (and its current limit)

To stay fully automatic (no export preset to configure), Phase 1 reads each audio
clip's **original media file** off the timeline and analyzes that directly, then
maps the timestamps back to sequence time. This is exact for typical talking-head
edits (one continuous mic recording). It does **not** yet account for clip
volume/gain or silence sitting in *gaps between* clips — a full sequence-mixdown
path is the planned upgrade if your footage needs it. Assumes clips play at 100%
speed.

### Uninstall / undo

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Uninstall
```

Removes the registry flag and the folder link. Your project files are untouched.

---

## Debugging (optional)

With Premiere running and the panel open, open Chrome and go to
<http://localhost:8088> to inspect the panel and see `console.log` output.
(Port is set in `.debug`.)

---

## Project layout

```
CSXS/manifest.xml     CEP manifest (panel id, host, size)
index.html            panel UI + styles
js/CSInterface.js     minimal bridge to the host
js/audio.js           FFmpeg silence detection (via Node) + sequence-time mapping
js/main.js            UI logic + scan/review/apply flow
jsx/host.jsx          ExtendScript — all timeline reads/edits (razor, ripple-delete)
bin/ffmpeg.exe        downloaded by setup.ps1 (not committed)
bin/Faster-Whisper-XXL/  local Whisper STT for Phase 3 (large; not committed)
.debug                enables Chrome DevTools on port 8088
setup.ps1             install / uninstall developer setup (+ FFmpeg download)
```

---

## Roadmap

- [x] **Phase 0** — scaffold + UI↔host bridge (read active sequence).
- [x] **Phase 1** — silence removal (FFmpeg `silencedetect` → review → razor + ripple-delete).
  - **Cut engine (shared by Silence / Fillers / Cleanup / Quick Clean), hardened:** razors both
    boundaries, then removes **all** clips filling a range (so cuts that span a clip edit or a
    gap no longer silently leave stray splits + uncut audio). A range is applied **only if every
    track can take it cleanly** — fully covered (ripples in sync) or empty with nothing after it;
    otherwise the range is **skipped, not half-applied**, so video can't ripple while audio
    doesn't (no A/V drift). It reports **cuts actually made vs. skipped** (`{cuts, skipped,
    requested}`), and the panel warns when any were skipped. `remove(true,true)` ripples only its
    own track, so the all-or-nothing gate is what keeps tracks in sync. *(Still to do from the
    audit: block/flag non-100%-speed clips, and auto-duplicate before the first apply.)*
- [x] **Phase 2** — auto punch-in zoom (adjustment-layer Transform, smart moments, sentence-hold).
  - **Shows what it zooms into** — each suggested moment in the review list displays the
    first few spoken words underneath the timecode (from the transcript for loudness mode,
    from the highlight quote for AI mode), so you can tell what the punch-in lands on without
    scrubbing. Click a row to move the playhead there to preview.
  - **Mark for manual zoom** — instead of auto-applying, drop a timeline marker at the start
    of each ticked moment (`sequence.markers.createMarker`, in seconds, colored, with the
    AI reason / dB as the comment). Non-destructive — only adds markers, never touches clips
    or your existing markers. Jump between them in the Markers panel / timeline ruler and add
    the zoom by hand. Lets you keep full manual control while still using the AI's eye for
    *where* the interesting beats are.
- [x] **Phase 3** — filler + repetition removal (local Whisper word timestamps → review → cut).
- [ ] **Phase 4** — Highlights / "best parts" (transcript → AI judges content → review). In testing.
  - Brains (selectable in Highlights + Zoom settings; shared):
    - **Local (qwen2.5)** — free, offline, automatic. **Preloaded on panel open**
      (`QCAi.preloadModel` warms it into memory with a 30-min keep-alive) so the first local
      call is instant instead of paying a cold model load.
    - **Claude (manual · claude.ai)** — real Claude on your Max plan, no API key: panel
      builds the prompt, you copy it into claude.ai and paste the reply back. Same model
      quality; two copy-pastes per run. Best for Highlights / Vox Pop.
    - **Claude (API key)** — automatic Claude, pay-per-use (pennies of text).
  - Subscription-OAuth ("sign in with your Max plan") is **not** offered — Anthropic bans it
    for third-party tools. The manual/claude.ai route is the sanctioned way to use the plan.
  - **Context for the AI** (shared across every AI tab) — one optional free-text box where
    you tell the model what the footage is about (brand, topic, who's speaking, what to
    protect). It's woven into every prompt (Cleanup, Quick Clean, Highlights, Vox Pop, Zoom)
    so it won't cut a "repetitive" line that's actually your product/pricing/campaign. Set it
    once in any tab; it syncs everywhere and persists.
  - **Editable manual reply** — for the manual/claude.ai brain, parsing happens inside the
    overlay: if the pasted JSON is malformed it **stays open with your reply intact** so you
    fix it and retry (no re-transcribe). After a manual scan, an **✎ Edit reply** button on
    the review card reopens the overlay with your previous answer so you can tweak the JSON
    (drop a bad cut, fix a range) and re-apply instantly. Available on Cleanup, Highlights,
    and Vox Pop.
- [ ] **Phase 8** — Captions. In testing. Transcribes the sequence, lets you **fix wrong
  words** in an editable list, then either:
  - **Burn styled captions** — generates an ASS subtitle (per-word active-word highlight,
    box vs hug-lines, font/size/weight/colors/position) and renders a **transparent overlay**
    with the bundled ffmpeg+libass (ProRes 4444 / QuickTime RLE / VP9-alpha), then imports
    and drops it on a top track. Burned-in: restyle = re-render. This is how Captions/Submagic
    do it — Premiere's scripting can't style native captions or do active-word highlight.
  - **Plain track** — writes an SRT and creates a native, editable (unstyled) Premiere
    caption track via `createCaptionTrack`.
  - Needs an empty video track on top. Rounded per-word "pill" backgrounds and scale-pop are
    a later upgrade (need a frame renderer; pure ASS can't do them).
- [ ] **Phase 7** — Quick Clean (run several passes at once). In testing. Pick any of
  Silence + Fillers/repetitions + AI cleanup; it transcribes **once** (shared by fillers
  and cleanup), detects everything against the **untouched** timeline, shows **one
  combined, source-tagged review list**, and applies **all cuts in a single pass**.
  Optionally chains into Zoom afterward.
  - **Correctness rule (do not break):** every cut must be detected on one pristine
    read of the timeline, merged into one ascending non-overlapping list (union), and
    applied in exactly ONE `qcApplySilenceCuts` call. Applying passes separately lets the
    first ripple-delete shift later timestamps so subsequent passes cut the wrong frames
    with no error shown. Zoom is non-destructive and runs LAST on a fresh re-read.
- [ ] **Phase 6** — Cleanup / AI transcript edit. In testing. Transcribes the whole
  sequence, sends the transcript to the chosen brain (manual Claude recommended), and gets
  back a list of suggested cuts — false starts, repeated points, rambling, tangents,
  misspeaks, dead weight — each with a category + reason. You tick the ones you want and
  apply them through the same non-destructive razor + ripple engine as Silence. An
  **Aggressiveness** setting (Light / Balanced / Heavy) tunes how much it proposes.
- [ ] **Phase 5** — Vox Pop / compilation builder (same-question street interviews). In testing.
  - **Phase A:** transcribe each interview (**word-level** timestamps) → AI detects the
    shared question, picks the juiciest soundbite per person and trims it to the **exact
    words** (from/to are word indices, so it can cut a short phrase, not just whole
    sentences), proposes the storyline → reviewable plan with jump-to-preview. Put each
    interview clip on one sequence.
  - **Phase B:** **Build Vox Pop edit** assembles the approved plan into a new
    "… – Vox Pop" sequence — the question once, then each soundbite in playback order,
    pulled from the source media (video + linked audio). Non-destructive: it clones the
    current sequence (so settings match) and lays the sub-ranges end to end; originals
    are untouched.
- [ ] **Phase 10** — Story / Documentary assembler. In testing. From one or more interview
  recordings on the sequence, the AI acts as a documentary editor: drops the interviewer's
  questions + filler, picks the strongest moments, trims each to the **exact words**, and
  **re-orders them into a narrative arc** (hook → context → key beats → payoff — recording
  order doesn't matter). Reviewable, reorderable (▲▼) list with per-beat preview + section
  labels and a Length control (Tight / Balanced / Thorough); Build assembles a "… – Story"
  sequence.
  - **Speaker attribution from clip names** — each clip's timeline name is passed to the AI as
    that clip's SPEAKER (`qcGetVideoClips` now returns `name`; shown as `CLIP n [name]`).
    Clips sharing a name are treated as the same person, so a doc with, say, 10 clips of one
    interviewee and 4 of another is attributed correctly and can be shaped into a back-and-forth.
    Rename clips to the speaker on the timeline; if you don't, the name defaults to the source
    file, which still groups same-source clips as one speaker. The review row shows the speaker. Shares the word-level transcription and the `qcBuildVoxPop` assembler with Vox
  Pop (now takes a name label + restores each source clip's in/out after the build, so a
  many-beats-from-one-source documentary doesn't leave the bin clip trimmed).
- [ ] **Phase 9** — Speaker → LinkedIn. In testing. The AI pulls each person's **name,
  company, and job title** from how they introduce themselves (uses the shared AI-context
  box; manual-Claude editable reply supported). Has its **own brain setting, default Local
  (qwen)** — independent of the shared brain, because name/title extraction is light work
  that shouldn't round-trip to Claude (still switchable to Claude per-tab if needed; API mode
  reuses the shared key). Each result is an **editable** card (the
  AI/Whisper can mishear names) with a **Find on LinkedIn** button that opens a Google search
  (`"Name" Company Title LinkedIn`) in the default browser. Read-only / lookup feature — it
  never touches the timeline.
  - **Two-phase transcription (time saver):** it transcribes only the **first ~10s** (the
    intro) and tries there first; only if no name is found does it fall back to transcribing
    the whole sequence (`transcribeSegments({ limitSec })` caps Whisper to that window of
    sequence time, trimming/skipping clips past the boundary).
  - **Why Whisper (not Premiere's transcript):** Premiere's Speech-to-Text transcript and
    caption text are **not exposed to ExtendScript** (Adobe: "no APIs around captions or
    transcription… wait until UXP"), so we can't read the editor's existing transcript — we
    generate our own. Kept fast by the 10s window above + the preloaded model below.
