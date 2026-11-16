# Changelog

All notable changes to this project will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/), and this project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
