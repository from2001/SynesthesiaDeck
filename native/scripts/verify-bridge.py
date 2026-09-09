#!/usr/bin/env python3
"""Exercise the real Swift executable against an isolated authenticated loopback bridge."""
import json
import math
import os
from pathlib import Path
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
TOKEN = "native-integration-test-only"


class State:
    def __init__(self):
        self.start = time.monotonic()
        self.epoch = "first"
        self.origin = self.start
        self.events = []
        self.clock_requests = 0
        self.reject_clocks = 0
        self.restart = False


state = State()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def respond(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def authorized(self):
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            self.respond(401, {"error": "unauthorized"})
            return False
        return True

    def do_GET(self):
        if not self.authorized():
            return
        if self.path != "/clock":
            return self.respond(404, {})
        state.clock_requests += 1
        if state.clock_requests <= state.reject_clocks:
            return self.respond(503, {"error": "temporary outage"})
        if state.restart and time.monotonic() - state.start > 4:
            state.epoch = "second"
            state.origin = state.start + 4
        self.respond(200, {"version": 1, "epoch": state.epoch, "serverTime": (time.monotonic() - state.origin) * 1000})

    def do_POST(self):
        if not self.authorized():
            return
        if self.path != "/ingest":
            return self.respond(404, {})
        event = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        state.events.append((time.monotonic(), state.epoch, state.origin, event))
        self.respond(200, {"ok": True})


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
environment = {**os.environ, "NATIVE_TOKEN": TOKEN, "SHOW_NATIVE_URL": f"http://127.0.0.1:{server.server_port}"}
binary = ROOT / ".build/debug/nanokon-host"


def run(*arguments):
    result = subprocess.run([str(binary), *arguments], cwd=ROOT, env=environment, capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    return result


try:
    state.restart = True
    output = run("--synthetic", "--duration", "7")
    audio = [(received, epoch, origin, event) for received, epoch, origin, event in state.events if event["type"] == "audio"]
    assert len(audio) >= 185, len(audio)
    assert {item[1] for item in audio} == {"first", "second"}
    assert "epoch changed" in output.stderr
    for received, _, origin, event in audio:
        assert set(event) == {"version", "type", "timestamp", "audio", "source"}
        assert event["source"] == "synthetic"
        assert -20 < (received - origin) * 1000 - event["timestamp"] < 250
        for field, value in event["audio"].items():
            assert math.isfinite(value)
            assert 0 <= value <= (300 if field == "bpm" else 1), (field, value)
    assert audio[-1][3]["audio"]["bpmConfidence"] > 0.8
    assert abs(audio[-1][3]["audio"]["bpm"] - 120) < 4
    print(f"PASS synthetic stream: {len(audio)} frames, normalized features, clock epoch restart, bounded timestamp age")

    state = State()
    run("--midi-replay", str(ROOT / "fixtures/midi-replay.json"), "--duration", "2.3")
    actual = [item[3] for item in state.events if item[3]["type"] == "midi"]
    fixture = json.loads((ROOT / "fixtures/midi-replay.json").read_text())
    assert len(actual) == len(fixture), (len(actual), len(fixture))
    for event, expected in zip(actual, fixture):
        assert all(event[key] == expected[key] for key in ["status", "data1", "data2"])
    print(f"PASS MIDI replay: {len(actual)} press/release and continuous messages preserved")

    state = State()
    state.reject_clocks = 2
    output = run("--synthetic", "--duration", "4")
    assert "reconnected" in output.stderr
    assert len([item for item in state.events if item[3]["type"] == "audio"]) >= 60
    assert state.clock_requests >= 3
    print("PASS bridge retries: recovered from two HTTP 503 clock failures")
finally:
    server.shutdown()
    server.server_close()
