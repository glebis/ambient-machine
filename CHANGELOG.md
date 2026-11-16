# Changelog

All notable changes to this project will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/), and this project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Sound generator panel: any sound from a text prompt via ElevenLabs, 0.5–30 s, optional seamless loop,
  saved to `sounds/generated/` and optionally loaded straight into a slot.
- Settings dialog: the one place to see, check, enter, remember or forget the ElevenLabs key.
- Takes: generate 1–4 variations at once, audition and use them in place, keep the chosen one and move
  the rest to `sounds/.discarded/`.
- Whole-kit generation: one style prompt makes takes for all eight drum tracks, three requests at a time,
  with retries when ElevenLabs is busy.

- Library search (`/`), collapsible groups with counts, stars that pin sounds to the top, "+N more" for long groups.
- Drum kit history: generating a kit keeps the previous one; step between kits with ‹ › or remove one.
- Foldable panels and "more" disclosures: slots show only their core controls, generation controls are folded away,
  how-to lines appear on hover.

### Fixed
- Drum tracks whose sound went missing showed "drop a sound"; they now fall back to the bundled kit piece.
- "Failed to fetch" and other raw errors: a stopped server, a plain static server, timeouts, invalid keys,
  missing credits, rate limits and network failures now show a plain explanation.
- A clear message instead of a traceback when the port is already in use.

## [0.1.0] - 2026-11-16

### Added
- 8 slots with a granular *cloud* mode and a clock-locked *loop* mode, per-slot LFO.
- Configurable stereo delay with freeze, convolution reverb with a generated impulse.
- Launch quantise, resample looper (AudioWorklet) with overdub and WAV export.
- 8 scenes with morphing recall, master limiter, draggable panels.
- 8-track × 16-step drum machine with 4 patterns, MPC-style shuffle on a 1/16 or 1/8 grid,
  per-track shuffle amount, humanise, mute/solo and choke.
- ElevenLabs drum generation through the local `server.py` proxy, plus a default
  8-piece kit generated with it.
- Bundled FM electric-piano sample sets and the script that synthesises them.
