# Ambient machine

A browser instrument for quick ambient music. Layer real or generated samples as **granular clouds and clock-locked loops** in 8 slots, put a **step-sequenced beat** under them, and shape it all with a configurable **delay** and **reverb**. Plain Web Audio: no build step, no dependencies beyond Python 3.

For musicians and experimenters who want to sketch ambient textures fast, from their own recordings or from sounds generated on the spot.

## Run it

```sh
git clone https://github.com/glebis/ambient-machine.git
cd ambient-machine
python3 server.py
```

Open http://localhost:8781. On macOS you can double-click `Open Ambient Machine.command` instead; it starts the server and opens the browser.

Opening `index.html` straight from disk works too, but the bundled sounds won't load over `file://`. Drag your own audio files in instead.

**Requirements:** Python 3, a Chromium-based browser (tested in Chrome; Safari and Firefox are untested).

**Optional, for generating drum sounds:** an [ElevenLabs](https://elevenlabs.io) API key in `ELEVENLABS_API_KEY`:

```sh
ELEVENLABS_API_KEY=... python3 server.py
```

Without a key everything else works, and you can add a key later in *settings*. `server.py` can also read it from a SOPS-encrypted file named by `AMBIENT_SOPS_FILE`. Its silence check uses macOS `afconvert` and is skipped elsewhere.

## What's in it
- **Library.** Search by name, group or prompt (press `/`), fold groups, and star sounds to pin them to a *★ starred* group at the top. Long groups show 8 items and a *+N more* link.
- **Less on screen.** Every panel folds from its header (remembered). Slots show size, density, position, pitch, volume and sends; texture, tone, pan and modulation sit under *more*, which says when an LFO is running. Generation controls in the drum machine sit under *generate sounds with ElevenLabs*, and the sound generator panel starts folded. How-to lines appear when you hover a panel.
- **8 slots.** Each has a sound (drag one in from the library or Finder) and a mode. *Cloud* is granular: size, density, position, scan, spray, shape (pluck → bell → swell), pitch, spread quantised to free/octaves/fifths/penta, reverse probability, stereo width and tone. *Loop* retriggers the region from *position* every N beats on the clock. Every slot also has volume, pan, delay send and reverb send.
- **Per-slot modulation.** Sine, triangle, random walk or sample & hold, routed to position, size, density, pitch, spray, tone, pan or volume. A red dot on the target control shows where it is right now.
- **Delay.** Free time in ms or a tempo-synced division (straight, dotted, triplet). Feedback with low and high cut inside the loop, plus soft saturation. Ping-pong amount, stereo width, right-channel time offset, wow (rate and depth), mix, a send into the reverb, and **freeze**: infinite hold with the input muted and the loop made lossless.
- **Reverb.** A generated-impulse convolution reverb with size, damping, pre-delay and mix. Its impulse is rebuilt and crossfaded when size or damping change.
- **Clock and launch quantise.** Launches and stops can snap to the next beat, bar or two bars. The tempo runs from 40 to 160 bpm.
- **Drum machine.** It has 8 tracks × 16 steps on the same clock, with 4 patterns (A–D) that switch on the next bar. Click a step to toggle it, shift-click for an accent, or drag to paint. Groove has shuffle, humanise and level, plus mute and solo per track. Shuffle is MPC-style: 50% is straight, 66.7% a triplet feel, 75% the hardest. It works on a 1/16 or 1/8 grid, and each track has a shuffle knob (0–100%) for how much of it the track follows, e.g. a straight kick under shuffled hats. Each track has volume, pitch, decay, pan and delay/reverb sends, and the hat chokes the open hat. Drop any library sound onto a track; drum sounds can also be dragged onto granular slots.
- **Sound generator.** Describe any sound (a texture, a pad, a field recording, foley) and generate it with ElevenLabs, 0.5–30 s, optionally as a seamless loop. ⌘↵ in the prompt generates. Files go to `sounds/generated/`.
- **Takes.** Both generators make 1–4 takes at once. They appear in a takes tray as they finish; click one to hear it *and* put it in place (on the drum track, or in the chosen slot), so you can compare takes while the beat plays. *keep chosen* moves the other takes to `sounds/.discarded/` (recoverable); *keep all* leaves them in the library. At most 3 requests run at once, and "busy" answers from ElevenLabs are retried.
- **Whole kit in one style.** Type a style ("dusty lo-fi tape, warm") and press *generate kit · N*: every drum track gets its own prompt from its role (kick, snare, clap, hat, open hat, rim, tom, shaker) plus your style, N takes each. The first finished take of each track goes in right away; pick others in the tray.
- **Kit history.** Generating a kit never overwrites the current one: it is kept, and the new kit becomes a new entry. *‹ kit ›* above the grid steps between kits (or pick one from the list); each kit remembers the takes you chose. *remove* drops a kit from the list; its sounds stay in the library. If a track's sound has gone missing (deleted or not generated on this computer), it falls back to the bundled piece.
- **Settings.** The *settings* button in the top bar is the one place for the ElevenLabs key: it shows where the key came from, checks it with ElevenLabs (free), and takes a new key, remembered by default in `~/.config/ambient-machine/elevenlabs.key` (mode 600). `server.py` looks for a key in this order: entered in Settings, `$ELEVENLABS_API_KEY`, a SOPS file (`$AMBIENT_SOPS_FILE`), the saved key file. The generators only show a one-line hint, in red with a *settings…* button when the key is missing or rejected. Failures read as plain sentences: server not running, invalid key, no credits, rate limit, no internet.
- **ElevenLabs drum sounds.** Select a track, describe one hit, and press *generate*. `server.py` calls the sound-effects API with your key, so the key never reaches the browser. It saves the file to `sounds/drums/generated/` and lists it in `sounds/drums/manifest.json`, so it persists and shows up in the library. Near-silent results are retried up to twice with longer durations. Hits are trimmed to their onset in the browser, because generated one-shots often start late. To regenerate the default kit, run `python3 server.py --kit --force`, or `--kit --redo hat,rim` for single pieces. Each generation uses ElevenLabs credits.
- **Resample looper** (AudioWorklet). It records the slots plus effects mix for 1–8 bars from the next bar, then loops it. It can overdub with a decay control. *→ library* turns the take into a sound you can granulate in a slot; *save wav* downloads it.
- **8 scenes.** Arm *store* (or shift-click a scene) to store a scene; click it to recall. Recall morphs every numeric control over the *morph* time and launches or stops slots to match.
- **Master.** Volume, plus a soft limiter (DynamicsCompressor at ratio 20) with ceiling and gain-reduction readout.
- **Everything draggable.** Rearrange panels by dragging their headers (the order is remembered). Drag sounds onto slots, or from slot to slot. Knobs drag vertically, sliders horizontally, and waveforms set the position. Shift drags finely, double-click resets to the default, and wheel and arrow keys also work.

State, scenes and the panel layout persist in `localStorage`. *reset everything* in the footer clears them.

## Files
`engine.js` holds the audio graph, specs, grain scheduler, delay, reverb and looper worklet. `ui.js` holds the controls, panels, drag-and-drop, scenes and persistence. `style.css` and `index.html` are the page. `server.py` is the local server and the ElevenLabs proxy.
`tools/earcons/generate.py` synthesises the bundled sample sets (needs `numpy` and `scipy`).

## Sounds and AI disclosure

- `sounds/dawn`, `glass`, `felt`, `tape`, `harbour`: soft FM electric-piano phrases, synthesised by `tools/earcons/generate.py`.
- `sounds/drums/kit/`: an 8-piece kit **generated with AI** (ElevenLabs sound effects) from the prompts listed in `sounds/drums/manifest.json`.
- The code was written with Claude Code under human direction. See [AUTHORSHIP.md](AUTHORSHIP.md).

## Privacy

Nothing is collected. The page and server run on your machine, and state is kept in your browser's `localStorage`. The only outside requests are Google Fonts and, through the local server, ElevenLabs: your prompt when you press *generate*, and a free key check when you check or enter a key in *settings*. A key you enter there is saved on this computer only if *remember* is ticked.

## License

[Apache-2.0](LICENSE). Copyright 2026 Gleb Kalinin. See [NOTICE](NOTICE) and [AUTHORSHIP.md](AUTHORSHIP.md).

---

### More from Gleb

I build focus tools, AI workflows, and write about creativity & tech: [glebkalinin.com](https://glebkalinin.com)

- [pos](https://github.com/glebis/pos): focus-aligned terminal cockpit over cmux + tmux
- [claude-skills](https://github.com/glebis/claude-skills): a library of Claude Code skills
