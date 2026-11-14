# Multiplayer protocol

Transport: WebSocket at `/ws` (RFC 6455), one JSON object per text message,
at most 4096 bytes (bigger messages close the socket with code 1009). Every
message has a string field `t` (the type). A client that sends nothing for 10 s
is disconnected (code 1001), so send `ping` now and then.

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
- `create`/`join` are only valid once per connection.

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
and is invulnerable for 2 s. Empty rooms are deleted.
