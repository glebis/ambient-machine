#!/usr/bin/env python3
"""Ambient machine local server.

Serves this folder on http://127.0.0.1:8781 and proxies ElevenLabs' sound-effects API so the
drum machine can generate one-shots without the API key ever reaching the browser.

    python3 server.py              # serve (default port 8781)
    python3 server.py --kit        # generate the default 8-piece drum kit, then exit
    python3 server.py --kit --force  # regenerate it, overwriting existing files
    python3 server.py --kit --redo hat,rim  # regenerate only some pieces

ElevenLabs key, first found wins:
  1. a key entered in the page this session (POST /api/key)
  2. $ELEVENLABS_API_KEY
  3. the ELEVENLABS_API_KEY entry of a SOPS file ($AMBIENT_SOPS_FILE,
     default ~/.claude/skills/secrets.enc.yaml), if `sops` is installed
  4. a key saved from the page with "remember" ($AMBIENT_KEY_FILE,
     default ~/.config/ambient-machine/elevenlabs.key, mode 600)
The key never reaches the browser. Drum hits are saved under sounds/drums/, other sounds under
sounds/generated/, each listed in that folder's manifest.json.
"""
import argparse
import errno
import json
import os
import re
import socket
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
SOUNDS = ROOT / "sounds" / "generated"        # any-sound generations (pads, textures, field recordings…)
BASE = "https://api.elevenlabs.io/v1"
API = BASE + "/sound-generation?output_format=mp3_44100_128"
SOPS_FILE = os.environ.get("AMBIENT_SOPS_FILE", str(Path.home() / ".claude/skills/secrets.enc.yaml"))
KEY_FILE = Path(os.environ.get("AMBIENT_KEY_FILE", str(Path.home() / ".config/ambient-machine/elevenlabs.key")))
MAX_SECONDS = 30.0                                # ElevenLabs sound effects: 0.5–30 s
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

class ApiError(RuntimeError):
    """An error worth showing in the page; `code` tells the page what to offer (e.g. "key")."""
    def __init__(self, message, status=502, code="error"):
        super().__init__(message)
        self.status, self.code = status, code


_entered = None            # key typed into the page this session
_found = None              # (key, source) from env / SOPS / key file, cached
_check = {}                # key -> (state, message) from the last check


def lookup_key():
    """(key, source) from env, SOPS or the saved key file; (None, None) if there is none."""
    if os.environ.get("ELEVENLABS_API_KEY", "").strip():
        return os.environ["ELEVENLABS_API_KEY"].strip(), "environment variable"
    if Path(SOPS_FILE).exists():
        env = dict(os.environ, SOPS_AGE_KEY_FILE=os.environ.get(
            "SOPS_AGE_KEY_FILE", str(Path.home() / ".config/sops/age/keys.txt")))
        try:
            out = subprocess.run(["sops", "-d", "--extract", '["ELEVENLABS_API_KEY"]', SOPS_FILE],
                                 capture_output=True, text=True, timeout=20, env=env)
            if out.returncode == 0 and out.stdout.strip():
                return out.stdout.strip(), "SOPS"
        except (OSError, subprocess.TimeoutExpired):
            pass                                   # sops not installed or stuck: fall through
    try:
        key = KEY_FILE.read_text().strip()
        if key:
            return key, "saved key file"
    except OSError:
        pass
    return None, None


def key_and_source(refresh=False):
    global _found
    if _entered:
        return _entered, "entered in the page"
    if _found is None or refresh:
        _found = lookup_key()
    return _found


def api_key():
    return key_and_source()[0]


def check_key(key):
    """Ask ElevenLabs whether a key works, without spending credits. Returns (state, message)."""
    req = urllib.request.Request(BASE + "/models", headers={"xi-api-key": key})
    try:
        with urllib.request.urlopen(req, timeout=15):
            return "ok", "key works"
    except urllib.error.HTTPError as err:
        status, message = parse_error(err)
        if is_key_error(err.code, status):
            return "invalid", "ElevenLabs rejected this key" + (f": {message}" if message else ".")
        # A restricted key may lack read permissions but still be allowed to generate sounds.
        return "ok", "key accepted (limited permissions)"
    except (urllib.error.URLError, socket.timeout, OSError) as err:
        return "unreachable", f"couldn't reach ElevenLabs to check the key ({reason(err)})"


def parse_error(err):
    """(status, message) from an ElevenLabs error body, e.g. {"detail": {"status": ..., "message": ...}}."""
    try:
        body = json.loads(err.read().decode(errors="replace"))
        d = body.get("detail", body)
        if isinstance(d, dict):
            # e.g. {"type": "authentication_error", "code": "invalid_api_key", "status": "invalid_api_key_length"}
            tags = " ".join(str(d.get(k, "")) for k in ("type", "code", "status")).strip()
            return tags, str(d.get("message", ""))[:240]
        if isinstance(d, list) and d and isinstance(d[0], dict):
            return "invalid_request", str(d[0].get("msg", ""))[:240]
        return "", str(d)[:240]
    except (ValueError, AttributeError, OSError):
        return "", ""


def is_key_error(code, tags):
    """True when ElevenLabs says the key itself is bad (wrong, revoked, malformed)."""
    return "permission" not in tags and (code == 401 or "authentication" in tags or "api_key" in tags)


def reason(err):
    r = getattr(err, "reason", err)
    if isinstance(r, socket.timeout) or isinstance(err, socket.timeout):
        return "timed out"
    if isinstance(r, socket.gaierror):
        return "no internet connection or DNS failure"
    return str(r) or err.__class__.__name__


def key_status(check=False):
    key, source = key_and_source(refresh=not _entered and check)
    out = {"server": True, "key": bool(key), "source": source,
           "remembered": KEY_FILE.exists(), "maxSeconds": MAX_SECONDS}
    if key and (check or key in _check):
        if check or key not in _check:
            _check[key] = check_key(key)
        out["check"], out["message"] = _check[key]
    return out


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


def generate(text, seconds, influence=0.6, loop=False):
    """MP3 bytes for a prompt; retries (longer) when ElevenLabs returns near-silence."""
    for attempt in range(3):
        audio = generate_once(text, min(MAX_SECONDS, seconds + attempt * 0.5), influence, loop)
        level = peak(audio)
        if level is None or level >= 0.02:
            return audio
        print(f"  near-silent result ({level:.3f}) for {text[:40]!r}, retrying", file=sys.stderr)
    raise ApiError("ElevenLabs returned silence three times; describe the sound in more detail.", 502, "silent")


def generate_once(text, seconds, influence=0.6, loop=False):
    """Return MP3 bytes from ElevenLabs text-to-sound-effects."""
    key, source = key_and_source()
    if not key:
        raise ApiError("No ElevenLabs API key yet: add one below, or set ELEVENLABS_API_KEY "
                       "and restart the server.", 401, "key")
    body = {"text": text, "duration_seconds": seconds, "prompt_influence": influence,
            "model_id": "eleven_text_to_sound_v2"}
    if loop:
        body["loop"] = True
    req = urllib.request.Request(API, data=json.dumps(body).encode(), method="POST", headers={
        "xi-api-key": key, "Content-Type": "application/json", "Accept": "audio/mpeg"})
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            data = res.read()
    except urllib.error.HTTPError as err:
        status, message = parse_error(err)
        detail = f" ({message})" if message else ""
        if "permission" in status or is_key_error(err.code, status):
            if "permission" in status:
                raise ApiError(f"This ElevenLabs key isn't allowed to generate sound effects{detail}. "
                               "Enable “Sound Effects” for the key, or use another one.", 401, "key") from None
            _check[key] = ("invalid", "ElevenLabs rejected this key")
            raise ApiError(f"ElevenLabs rejected the API key from {source}{detail}. "
                           "Enter a working key below.", 401, "key") from None
        if err.code == 402 or "quota" in status or "credit" in message.lower():
            raise ApiError(f"Not enough ElevenLabs credits for this sound{detail}. "
                           "Try a shorter length or top up your plan.", 402, "quota") from None
        if err.code == 429:
            raise ApiError("ElevenLabs is rate-limiting or busy right now. Wait a few seconds and try again.",
                           429, "busy") from None
        if err.code in (400, 422):
            raise ApiError(f"ElevenLabs refused the request{detail}.", 400, "request") from None
        raise ApiError(f"ElevenLabs had a problem (HTTP {err.code}){detail}. Try again in a moment.",
                       502, "upstream") from None
    except (urllib.error.URLError, socket.timeout, OSError) as err:
        raise ApiError(f"Couldn't reach ElevenLabs: {reason(err)}. Check the internet connection and retry.",
                       504, "network") from None
    if not data:
        raise ApiError("ElevenLabs returned an empty file. Try again.", 502, "upstream")
    return data


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:40] or "hit"


def load_manifest(path=MANIFEST):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return []


def add_to_manifest(entry, path=MANIFEST):
    with LOCK:
        items = [e for e in load_manifest(path) if e["id"] != entry["id"]]
        items.append(entry)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(items, indent=1))


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
            except ApiError as err:
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

    def same_origin(self):
        """Only this page may set keys or spend credits: refuse cross-site requests."""
        origin = self.headers.get("Origin")
        port = self.server.server_port
        return not origin or origin in (f"http://{self.headers.get('Host', '')}",
                                        f"http://localhost:{port}", f"http://127.0.0.1:{port}")

    def body(self):
        try:
            n = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(n) or b"{}") if 0 <= n <= 100_000 else None
        except ValueError:
            data = None
        if not isinstance(data, dict):
            raise ApiError("bad request", 400, "request")
        return data

    def do_GET(self):
        if self.path.split("?")[0] == "/api/status":
            return self.reply(200, key_status(check="check=1" in self.path))
        return super().do_GET()

    def do_DELETE(self):
        global _entered, _found
        if self.path != "/api/key" or not self.same_origin():
            return self.reply(404 if self.path != "/api/key" else 403, {"error": "not allowed"})
        _entered, _found = None, None
        try:
            KEY_FILE.unlink()
        except FileNotFoundError:
            pass
        except OSError as err:
            return self.reply(500, {"error": f"couldn't remove the saved key: {err}"})
        return self.reply(200, key_status())

    def do_POST(self):
        if self.path not in ("/api/sfx", "/api/key", "/api/discard"):
            return self.reply(404, {"error": "not found"})
        if not self.same_origin():
            return self.reply(403, {"error": "cross-origin request refused"})
        try:
            req = self.body()
            if self.path == "/api/key":
                return self.set_key(req)
            if self.path == "/api/discard":
                return self.discard(req)
            return self.sfx(req)
        except ApiError as err:
            return self.reply(err.status, {"error": str(err), "code": err.code})
        except (ValueError, TypeError):
            return self.reply(400, {"error": "bad request", "code": "request"})
        except Exception as err:                    # keep the page informed instead of dropping the connection
            print(f"  error: {err!r}", file=sys.stderr)
            return self.reply(500, {"error": f"server error: {err.__class__.__name__}: {err}", "code": "server"})

    def set_key(self, req):
        global _entered
        key = str(req.get("key", "")).strip()
        if not re.fullmatch(r"[A-Za-z0-9_\-]{20,200}", key):
            raise ApiError("That doesn't look like an ElevenLabs API key (it usually starts with sk_).", 400, "key")
        state, message = check_key(key)
        if state == "invalid":
            raise ApiError(message, 401, "key")
        _entered = key
        _check[key] = (state, message)
        if req.get("remember"):
            try:
                KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
                fd = os.open(KEY_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, "w") as f:
                    f.write(key + "\n")
                os.chmod(KEY_FILE, 0o600)
            except OSError as err:
                raise ApiError(f"Key works, but couldn't save it to {KEY_FILE}: {err}", 500, "server") from None
        return self.reply(200, key_status())

    def discard(self, req):
        """Drop unchosen takes: unlist them and move the files to sounds/.discarded/ (recoverable)."""
        ids = {str(i) for i in req.get("ids", []) if isinstance(i, str)}
        moved = []
        bin_ = ROOT / "sounds" / ".discarded"
        for manifest in (MANIFEST, SOUNDS / "manifest.json"):
            with LOCK:
                items = load_manifest(manifest)
                keep = []
                for e in items:
                    gen = e.get("id", "").startswith(("drums/gen/", "gen/"))   # never the bundled kit
                    if e.get("id") in ids and gen:
                        src = (ROOT / e["url"]).resolve()
                        if ROOT in src.parents and src.exists():
                            bin_.mkdir(parents=True, exist_ok=True)
                            src.replace(bin_ / src.name)
                        moved.append(e["id"])
                    else:
                        keep.append(e)
                if len(keep) != len(items):
                    manifest.write_text(json.dumps(keep, indent=1))
        return self.reply(200, {"discarded": moved})

    def sfx(self, req):
        text = str(req.get("text", "")).strip()[:450]
        if not text:
            raise ApiError("Describe the sound first.", 400, "request")
        drum = req.get("kind", "drum") == "drum"
        seconds = min(5.0 if drum else MAX_SECONDS, max(0.5, float(req.get("seconds", 0.8 if drum else 4))))
        influence = min(1.0, max(0.0, float(req.get("influence", 0.6))))
        loop = bool(req.get("loop")) and not drum
        name = str(req.get("name", "")).strip()[:40] or text[:24]
        audio = generate(text, seconds, influence, loop)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        folder, manifest = (DRUMS / "generated", MANIFEST) if drum else (SOUNDS, SOUNDS / "manifest.json")
        path = folder / f"{slug(name)}-{stamp}.mp3"
        folder.mkdir(parents=True, exist_ok=True)
        path.write_bytes(audio)
        rel = path.relative_to(ROOT).as_posix()
        entry = {"id": f"{'drums/gen' if drum else 'gen'}/{slug(name)}-{stamp}", "url": rel, "name": name,
                 "group": "drums · generated" if drum else "generated", "prompt": text,
                 "seconds": seconds, "loop": loop}
        add_to_manifest(entry, manifest)
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
        except ApiError as err:
            sys.exit(str(err))
        return
    ThreadingHTTPServer.request_queue_size = 128   # the page fetches ~30 samples at once; the default 5 resets them
    ThreadingHTTPServer.daemon_threads = True
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as err:
        if err.errno == errno.EADDRINUSE:
            sys.exit(f"Port {args.port} is already in use. Is the machine already running? "
                     f"Open http://localhost:{args.port}, or start on another port: python3 server.py --port 8782")
        raise
    key, source = key_and_source()
    print(f"Ambient machine on http://localhost:{args.port}  "
          f"(ElevenLabs key: {'from ' + source if key else 'none yet, add one in the page'})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
