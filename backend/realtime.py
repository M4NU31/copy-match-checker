#!/usr/bin/env python3
"""Realtime collaboration relay for Copy Match Checker.

A tiny per-project pub/sub over WebSockets: presence (who is viewing a project),
issue focus, and (later) live cursors. Purely ephemeral in-memory relay — no DB,
no persistence. It just stamps each message with the sender's identity and
rebroadcasts it to everyone else in the same project room.

Run:  python3 realtime.py            # ws://127.0.0.1:5501  (override: RT_PORT)
Needs: pip install websockets

Auth note (Phase 1): the client's identity (name/email/avatar/color) is taken
from its `hello` message and trusted. The tool is behind Google login and this
data is low-sensitivity presence, but a hardened version should verify a token.
"""
import asyncio
import json
import os

import websockets

PORT = int(os.environ.get("RT_PORT", "5501"))

# project_id -> set of connection entries {"ws":..., "user":...}
rooms = {}


def _room(project):
    return rooms.setdefault(project, [])


async def _broadcast(project, payload, exclude=None):
    msg = json.dumps(payload)
    dead = []
    for entry in list(_room(project)):
        ws = entry["ws"]
        if ws is exclude:
            continue
        try:
            await ws.send(msg)
        except Exception:  # noqa: BLE001
            dead.append(entry)
    for d in dead:
        try:
            _room(project).remove(d)
        except ValueError:
            pass


async def handler(ws, *_args):  # *_args tolerates older websockets (ws, path)
    project = None
    entry = None
    user = None
    try:
        first = json.loads(await ws.recv())
        if first.get("type") != "hello":
            return
        project = str(first.get("project") or "")
        user = first.get("user") or {}
        if not project or not user.get("id"):
            return
        entry = {"ws": ws, "user": user}
        _room(project).append(entry)
        # Send the newcomer the users already present (unique by id).
        seen, roster = set(), []
        for e in _room(project):
            if e is entry:
                continue
            uid = e["user"].get("id")
            if uid in seen:
                continue
            seen.add(uid)
            roster.append(e["user"])
        await ws.send(json.dumps({"type": "roster", "users": roster}))
        await _broadcast(project, {"type": "join", "user": user}, exclude=ws)
        # Relay everything else, stamping the server-known sender identity.
        async for raw in ws:
            try:
                m = json.loads(raw)
            except Exception:  # noqa: BLE001
                continue
            if not isinstance(m, dict):
                continue
            m["user"] = user
            await _broadcast(project, m, exclude=ws)
    except Exception:  # noqa: BLE001
        pass
    finally:
        if project and entry:
            try:
                _room(project).remove(entry)
            except ValueError:
                pass
            # Only announce a real departure (no other connection for this user).
            still_here = any(e["user"].get("id") == user.get("id") for e in _room(project))
            if not still_here:
                await _broadcast(project, {"type": "leave", "user": user})
            if not _room(project):
                rooms.pop(project, None)


async def main():
    async with websockets.serve(handler, "127.0.0.1", PORT, ping_interval=30):
        print(f"Realtime relay  ->  ws://127.0.0.1:{PORT}")
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nStopped.")
