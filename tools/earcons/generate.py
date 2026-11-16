"""Generate the soft Rhodes-style ambient earcons bundled in sounds/.

Original sounds (not copies of any existing system sound): FM electric-piano
tones, slow tremolo, and a long, dark, diffuse reverb tail.

Run:  python3 -I tools/earcons/generate.py   (needs numpy + scipy)
Writes 48 kHz stereo 16-bit WAVs to sounds/<set>/{voice-start,voice-stop,tool-start,tool-done}.wav
"""
from pathlib import Path

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, fftconvolve, sosfilt

SR = 48_000
OUT = Path(__file__).resolve().parents[2] / "sounds"


def hz(note: str) -> float:
    names = {"C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "F": 5, "F#": 6,
             "Gb": 6, "G": 7, "G#": 8, "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11}
    name, octave = note[:-1], int(note[-1])
    return 440.0 * 2 ** ((names[name] + 12 * (octave + 1) - 69) / 12)


def rhodes(freq: float, dur: float, vel: float, tone: dict) -> np.ndarray:
    """One FM electric-piano note: warm 1:1 body plus a quick high 'tine'."""
    t = np.arange(int(dur * SR)) / SR
    if tone["wobble"]:  # slow tape-style pitch drift, in cents
        cents = tone["wobble"] * np.sin(2 * np.pi * 0.55 * t + freq)
        phase = 2 * np.pi * np.cumsum(freq * 2 ** (cents / 1200)) / SR
    else:
        phase = 2 * np.pi * freq * t
    index = vel * tone["bright"] * (0.4 + 2.2 * np.exp(-t * 6.0))
    body = np.sin(phase + index * np.sin(phase))
    tine_idx = vel * 1.2 * np.exp(-t * 45.0)
    tine = np.sin(phase + tine_idx * np.sin(14.0 * phase))
    attack = np.minimum(1.0, t / tone["attack"])
    decay = np.exp(-t * (1.1 + freq / 900.0))  # higher notes die sooner
    return (0.85 * body + tone["tine"] * tine * np.exp(-t * 8)) * attack * decay * vel


def reverb_ir(seconds: float, darkness_hz: float, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)  # fixed seed: reproducible output
    n = int(seconds * SR)
    t = np.arange(n) / SR
    ir = rng.standard_normal((n, 2)) * np.exp(-t * 6.9 / seconds)[:, None]  # -60 dB at the end
    ir = sosfilt(butter(2, darkness_hz, "low", fs=SR, output="sos"), ir, axis=0)
    return ir / np.max(np.abs(ir))


def render(notes, length, wet, room, peak_db, tone) -> np.ndarray:
    """notes: (note, start seconds, velocity, duration seconds)."""
    dry = np.zeros((int(length * SR), 2))
    for i, (note, start, vel, dur) in enumerate(notes):
        sig = rhodes(hz(note), dur, vel, tone)
        pan = 0.5 + 0.28 * np.sin(i * 2.1)  # spread notes gently across the field
        s = int(start * SR)
        e = min(len(dry), s + len(sig))
        dry[s:e, 0] += sig[: e - s] * np.sqrt(1 - pan)
        dry[s:e, 1] += sig[: e - s] * np.sqrt(pan)
    t = np.arange(len(dry)) / SR
    trem = tone["tremolo"]
    dry[:, 0] *= 1 - 0.12 * (1 + np.sin(2 * np.pi * trem * t)) / 2
    dry[:, 1] *= 1 - 0.12 * (1 + np.sin(2 * np.pi * trem * t + np.pi)) / 2
    ir = reverb_ir(room, tone["dark"], seed=7)
    wet_sig = np.stack([fftconvolve(dry[:, c], ir[:, c])[: len(dry)] for c in (0, 1)], axis=1)
    wet_sig /= np.max(np.abs(wet_sig)) + 1e-9
    mix = (1 - wet) * dry / (np.max(np.abs(dry)) + 1e-9) + wet * wet_sig
    mix = sosfilt(butter(1, tone["lowpass"], "low", fs=SR, output="sos"), mix, axis=0)
    fade = int(0.35 * SR)
    mix[-fade:] *= np.linspace(1, 0, fade)[:, None] ** 2
    return mix / np.max(np.abs(mix)) * 10 ** (peak_db / 20)


def strum(chord, gap, vel, decrement, dur):
    return [(n, i * gap, max(0.2, vel - i * decrement), dur - i * 0.08) for i, n in enumerate(chord)]


def sound_set(start_chord, stop_chord, tool_a, tool_b, gap=0.1, room=2.8, wet=0.45):
    return {
        "voice-start": dict(notes=strum(start_chord, gap, 0.55, 0.05, 2.6), length=3.2, wet=wet, room=room, peak_db=-8),
        "voice-stop": dict(notes=strum(stop_chord, gap * 0.9, 0.42, 0.0, 2.0), length=2.6, wet=wet, room=room * 0.85, peak_db=-10),
        "tool-start": dict(notes=[(tool_a[0], 0.0, 0.30, 0.9), (tool_a[1], 0.03, 0.16, 0.7)], length=1.4, wet=0.55, room=1.6, peak_db=-16),
        "tool-done": dict(notes=[(tool_b[0], 0.0, 0.28, 0.9), (tool_b[1], 0.11, 0.24, 1.0)], length=1.6, wet=0.55, room=1.8, peak_db=-15),
    }


BASE_TONE = dict(bright=1.0, tine=0.25, attack=0.006, tremolo=4.2, dark=3200, lowpass=7000, wobble=0)

# Five sets. "dawn" is the original and the app default.
SETS = {
    # open Dmaj9, slow strum up; falls back to the root
    "dawn": dict(tone=BASE_TONE,
                 sounds=sound_set(["D3", "A3", "E4", "F#4", "C#5"], ["F#4", "E4", "A3", "D3"], ("A5", "E6"), ("E5", "B5"))),
    # higher and airier — Fmaj7#11, brighter tine, big room
    "glass": dict(tone={**BASE_TONE, "bright": 0.8, "tine": 0.4, "tremolo": 5.0, "dark": 4500, "lowpass": 9000},
                  sounds=sound_set(["F3", "C4", "E4", "A4", "B4"], ["B4", "A4", "E4", "F3"], ("C6", "G6"), ("A5", "E6"), gap=0.08, room=3.6, wet=0.55)),
    # low, rounded, almost no attack — Eb add9, very dark
    "felt": dict(tone={**BASE_TONE, "bright": 0.55, "tine": 0.08, "attack": 0.02, "tremolo": 3.2, "dark": 1800, "lowpass": 3800},
                 sounds=sound_set(["Eb3", "Bb3", "F4", "G4"], ["G4", "Bb3", "Eb3"], ("Bb4", "F5"), ("G4", "D5"), gap=0.15, room=3.0)),
    # warm minor colour with a slow tape wobble — Am9
    "tape": dict(tone={**BASE_TONE, "bright": 0.9, "tine": 0.2, "tremolo": 2.6, "dark": 2600, "lowpass": 5200, "wobble": 9},
                 sounds=sound_set(["A2", "E3", "G3", "B3", "C4"], ["C4", "B3", "E3", "A2"], ("E5", "B5"), ("G5", "D6"), gap=0.12, room=2.6)),
    # suspended, unresolved, pentatonic — Gsus2, quick strum
    "harbour": dict(tone={**BASE_TONE, "bright": 1.1, "tine": 0.3, "tremolo": 4.8, "dark": 3800, "lowpass": 8000},
                    sounds=sound_set(["G3", "D4", "A4", "D5"], ["D5", "A4", "D4", "G3"], ("D6", "A6"), ("B5", "D6"), gap=0.06, room=2.2, wet=0.5)),
}


def main() -> None:
    for set_name, spec in SETS.items():
        folder = OUT / set_name
        folder.mkdir(parents=True, exist_ok=True)
        for name, params in spec["sounds"].items():
            audio = render(tone=spec["tone"], **params)
            wavfile.write(folder / f"{name}.wav", SR, (audio * 32767).astype(np.int16))
        print(f"ui/sounds/{set_name}/  {', '.join(spec['sounds'])}")


if __name__ == "__main__":
    main()
