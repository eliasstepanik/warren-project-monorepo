# Multiplayer protocol

Transport: WebSocket at `/ws` (RFC 6455), one JSON object per text message,
at most 4096 bytes (bigger messages close the socket with code 1009). Every
message has a string field `t` (the type). A client from which no frame (of
any kind, including WebSocket pongs) arrives for 30 s is disconnected (code
1001). The server sends a WebSocket ping every 10 s, which browsers answer by
themselves, so a hidden tab stays connected; sending `ping` now and then is
still useful to measure latency. A client that does not read what is sent to it
(more than 256 KB queued) is disconnected.

Limits (defaults, configurable when starting the server with the environment
variables `MAX_CONNECTIONS`, `MAX_PER_IP` and `MAX_ROOMS`): 256 connections
(more are refused with HTTP 503), 16 per IP address (HTTP 429, 0 = no cap) and
64 rooms (`create` answers `{t:'error', msg:'server full'}` only when every
room has players: if the cap is reached, the oldest empty room still in its
grace period is deleted to make space). Invalid values of these variables
(not a number, negative) are ignored and the default is used; `PORT` (default
8080) works the same way. The per-IP cap uses the raw socket address
(`remoteAddress`), so behind a reverse proxy all users share one address and
one cap: raise `MAX_PER_IP` or set it to 0 there. Each client may send at most
about 100 messages/s of any type; extra ones are dropped silently.

Close codes sent by the server: 1000 (normal echo), 1001 (idle timeout), 1002
(protocol error, including a bad close code), 1003 (binary message; only text
is supported), 1007 (text, or a close reason, that is not valid UTF-8), 1008
(too many failed joins), 1009 (message over 4096 bytes, or split into more than
64 frames).

Time is in seconds, distance in du, angles in radians (same units as
`js/physics.js`). The simulation runs at 120 steps/s; snapshots are sent at
20 Hz. There is no time warp online. Body positions are not sent: compute them
with `positionsAt(snap.time)` from `js/physics.js`.

## Client to server

| Message | Meaning |
| --- | --- |
| `{t:'create', name}` | Create a room and join it. |
| `{t:'join', room, name}` | Join room `room` (4 letters, case-insensitive). |
| `{t:'input', rot, thrust, retro, fire, seq}` | The controls currently held. |
| `{t:'ping', c}` | Latency probe; `c` is a number echoed back. |

- `name` is reduced to letters, digits, space and `_ . -`, at most 12 chars
  (`PILOT` if nothing is left).
- `input`: `rot` is -1, 0 or 1; `thrust`, `retro`, `fire` are 0 or 1; `seq` is
  a non-negative integer that the server echoes as `lastSeq` in snapshots, so
  the client can drop the inputs it has already seen applied. Out-of-range
  values are clamped. The input stays in effect until the next one. At most
  about 60 inputs/s are accepted; extra ones are dropped silently.
- `create`/`join` are only valid while the connection is not in a room (a
  second one answers `already in a room`). A failed `join` (bad code, unknown
  room, full room) may be retried, but the 5th failed `join` on one connection
  closes it with code 1008. This only slows guessing down: the count is per
  connection, so a client can reconnect and try again. Room codes are not
  secrets.

## Server to client

| Message | Meaning |
| --- | --- |
| `{t:'welcome', id, room, players}` | Sent after `create`/`join`. `id` is your ship id (0-3, also your colour index). |
| `{t:'players', list}` | Sent to the room whenever someone joins or leaves. |
| `{t:'snap', time, ships, shots}` | World state, 20 Hz. |
| `{t:'event', type, ...}` | Something happened; sent as it happens. |
| `{t:'pong', c}` | Reply to `ping`. |
| `{t:'error', msg}` | A request failed (full room, unknown room, bad message...). |

`players` is `list` of `{id, name, color}`.

`snap`:

- `time`: simulation time (s).
- `ships`: `{id, x, y, vx, vy, a, alive, inv, k, d, seq}`: position, velocity,
  heading `a`, `alive` 0/1, `inv` seconds of invulnerability left, kills `k`,
  deaths `d`, `seq` = last input seq applied.
- `shots`: `{id, o, x, y, vx, vy}`: `o` is the owner's ship id.

`event` types:

- `{type:'kill', killer, victim}`: ship ids. `killer === victim` is a suicide
  (no score).
- `{type:'crash', id, body}`: ship `id` hit body index `body`.
- `{type:'respawn', id}`.

## Rules

Up to 4 players per room. Fire cooldown 0.4 s, shots live 4 s, are pulled by
gravity and cannot hit their owner during the first 0.3 s. A dead ship respawns
after 3 s in a circular orbit around a random planet, away from other ships,
and is invulnerable for 2 s. A room whose last player left stops simulating
and is deleted 10 s later, unless someone joins it first (so a page reload can
rejoin its room).
