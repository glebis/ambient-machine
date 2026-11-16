#!/usr/bin/env python3
"""Ambient machine local server.

Serves this folder on http://127.0.0.1:8781 and proxies ElevenLabs' sound-effects API so the
drum machine can generate one-shots without the API key ever reaching the browser.

    python3 server.py              # serve (default port 8781)
    python3 server.py --kit        # generate the default 8-piece drum kit, then exit
    python3 server.py --kit --force  # regenerate it, overwriting existing files
    python3 server.py --kit --redo hat,rim  # regenerate only some pieces

Key lookup: $ELEVENLABS_API_KEY, else the ELEVENLABS_API_KEY entry of a SOPS file
($AMBIENT_SOPS_FILE, default ~/.claude/skills/secrets.enc.yaml) if `sops` is installed.
Every generated file is saved under sounds/drums/ and listed in sounds/drums/manifest.json.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DRUMS = ROOT / "sounds" / "drums"
MANIFEST = DRUMS / "manifest.json"
API = "https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128"
LOCK = threading.Lock()

# Default kit: name, prompt, seconds. Warm and dry so the delay/reverb sends do the space.
KIT = [
    ("kick", "one punchy analog kick drum hit, deep round low thump, loud, close-miked, dry, no reverb", 1.0),
    ("snare", "one dusty lo-fi snare drum hit, crisp crack with warm body, loud, dry, no reverb", 1.0),
    ("clap", "one loud hand clap, sharp transient, close-miked, dry studio, no reverb", 1.0),
    ("hat", "one closed hi-hat cymbal hit, crisp metallic tick, loud, close-miked, dry", 1.0),
    ("open hat", "one open hi-hat cymbal hit, bright airy shimmer that rings out, loud, dry", 1.5),
    ("rim", "loud wooden block knock, percussion hit, short and bright, dry", 1.0),
    ("tom", "one low floor tom drum hit, warm tuned boom, loud, dry", 1.2),
    ("shaker", "one single shaker shake, crisp seeds rattle, loud, close-miked, dry", 1.0),
]

_key = None


def api_key():
    global _key
    if _key:
        return _key
    _key = os.environ.get("ELEVENLABS_API_KEY") or None
    if not _key:
        env = dict(os.environ, SOPS_AGE_KEY_FILE=os.environ.get(
            "SOPS_AGE_KEY_FILE", str(Path.home() / ".config/sops/age/keys.txt")))
        try:
            out = subprocess.run(
                ["sops", "-d", "--extract", '["ELEVENLABS_API_KEY"]',
                 os.environ.get("AMBIENT_SOPS_FILE", str(Path.home() / ".claude/skills/secrets.enc.yaml"))],
                capture_output=True, text=True, timeout=20, env=env)
            _key = out.stdout.strip() or None
        except (OSError, subprocess.TimeoutExpired):
            _key = None
    return _key


def peak(mp3):
    """Peak level (0..1) of MP3 bytes via macOS afconvert; None if it can't be measured."""
    import tempfile, wave, array
    with tempfile.TemporaryDirectory() as tmp:
        src, dst = Path(tmp) / "in.mp3", Path(tmp) / "out.wav"
        src.write_bytes(mp3)
        try:
            subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16", str(src), str(dst)],
                           check=True, capture_output=True, timeout=20)
            with wave.open(str(dst)) as w:
                data = array.array("h", w.readframes(w.getnframes()))
        except (OSError, subprocess.SubprocessError, wave.Error):
            return None
    return max((abs(x) for x in data), default=0) / 32768


def generate(text, seconds, influence=0.6):
    """MP3 bytes for a prompt; retries (longer) when ElevenLabs returns near-silence."""
    for attempt in range(3):
        audio = generate_once(text, seconds + attempt * 0.5, influence)
        level = peak(audio)
        if level is None or level >= 0.02:
            return audio
        print(f"  near-silent result ({level:.3f}) for {text[:40]!r}, retrying", file=sys.stderr)
    raise RuntimeError("ElevenLabs returned silence three times; try a more descriptive prompt.")


def generate_once(text, seconds, influence=0.6):
    """Return MP3 bytes from ElevenLabs text-to-sound-effects."""
    key = api_key()
    if not key:
        raise RuntimeError("No ElevenLabs key: set ELEVENLABS_API_KEY or add it to SOPS.")
    body = json.dumps({"text": text, "duration_seconds": seconds, "prompt_influence": influence,
                       "model_id": "eleven_text_to_sound_v2"}).encode()
    req = urllib.request.Request(API, data=body, method="POST", headers={
        "xi-api-key": key, "Content-Type": "application/json", "Accept": "audio/mpeg"})
    try:
        with urllib.request.urlopen(req, timeout=90) as res:
            return res.read()
    except urllib.error.HTTPError as err:
        detail = err.read().decode(errors="replace")[:300]
        raise RuntimeError(f"ElevenLabs {err.code}: {detail}") from None


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:40] or "hit"


def load_manifest():
    try:
        return json.loads(MANIFEST.read_text())
    except (OSError, ValueError):
        return []


def add_to_manifest(entry):
    with LOCK:
        items = [e for e in load_manifest() if e["id"] != entry["id"]]
        items.append(entry)
        MANIFEST.parent.mkdir(parents=True, exist_ok=True)
        MANIFEST.write_text(json.dumps(items, indent=1))


def make_kit(force=False, redo=()):
    (DRUMS / "kit").mkdir(parents=True, exist_ok=True)
    for name, prompt, seconds in KIT:
        path = DRUMS / "kit" / f"{slug(name)}.mp3"
        if path.exists() and not force and slug(name) not in redo:
            print(f"  keep  {path.name}")
        else:
            try:
                path.write_bytes(generate(prompt, seconds))
                print(f"  made  {path.name}")
            except RuntimeError as err:
                print(f"  FAIL  {path.name}: {err}", file=sys.stderr)
                continue
        add_to_manifest({"id": f"drums/kit/{slug(name)}", "url": f"sounds/drums/kit/{path.name}",
                         "name": name, "group": "drum kit", "prompt": prompt, "seconds": seconds})


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")  # always pick up edited files
        super().end_headers()

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            super().log_message(fmt, *args)

    def reply(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/api/status":
            return self.reply(200, {"server": True, "key": bool(api_key())})
        return super().do_GET()

    def do_POST(self):
        if self.path != "/api/sfx":
            return self.reply(404, {"error": "not found"})
        # Only this page may spend credits: refuse cross-site requests.
        origin = self.headers.get("Origin")
        host = self.headers.get("Host", "")
        if origin and origin not in (f"http://{host}", f"http://localhost:{self.server.server_port}",
                                     f"http://127.0.0.1:{self.server.server_port}"):
            return self.reply(403, {"error": "cross-origin request refused"})
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            text = str(req.get("text", "")).strip()[:400]
            seconds = min(5.0, max(0.5, float(req.get("seconds", 0.8))))
            influence = min(1.0, max(0.0, float(req.get("influence", 0.6))))
            name = str(req.get("name", "")).strip()[:40] or text[:24]
            if not text:
                return self.reply(400, {"error": "describe the sound first"})
            audio = generate(text, seconds, influence)
        except RuntimeError as err:
            return self.reply(502, {"error": str(err)})
        except (ValueError, TypeError):
            return self.reply(400, {"error": "bad request"})
        stamp = time.strftime("%Y%m%d-%H%M%S")
        rel = f"sounds/drums/generated/{slug(name)}-{stamp}.mp3"
        (ROOT / rel).parent.mkdir(parents=True, exist_ok=True)
        (ROOT / rel).write_bytes(audio)
        entry = {"id": f"drums/gen/{slug(name)}-{stamp}", "url": rel, "name": name,
                 "group": "drums · generated", "prompt": text, "seconds": seconds}
        add_to_manifest(entry)
        return self.reply(200, entry)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8781)
    ap.add_argument("--kit", action="store_true", help="generate the default drum kit and exit")
    ap.add_argument("--force", action="store_true", help="with --kit: regenerate existing files")
    ap.add_argument("--redo", default="", help="with --kit: comma-separated pieces to regenerate, e.g. hat,rim")
    args = ap.parse_args()
    if args.kit:
        try:
            make_kit(args.force, {slug(x) for x in args.redo.split(',') if x})
        except RuntimeError as err:
            sys.exit(str(err))
        return
    ThreadingHTTPServer.request_queue_size = 128   # the page fetches ~30 samples at once; the default 5 resets them
    ThreadingHTTPServer.daemon_threads = True
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Ambient machine on http://localhost:{args.port}  (ElevenLabs key: {'found' if api_key() else 'missing'})")
    server.serve_forever()


if __name__ == "__main__":
    main()
