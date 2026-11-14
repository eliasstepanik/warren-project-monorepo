# Lone Orbit

A tiny 2D space sim with real orbital mechanics, drawn in chunky pixels, plus a
landing page that embeds the playable demo. Plain HTML, CSS and JS with
Canvas. There is no build step and no external dependency.

## Run it

The code uses ES modules, so it must be served over HTTP. Opening
`index.html` from `file://` will not work.

```sh
cd sandbox-apps/space-sim
python3 -m http.server 8000     # single player only, any static server works
# open http://localhost:8000/

node server/server.js           # static files + multiplayer, PORT=8080 by default
# open http://localhost:8080/
```

The multiplayer server (`server/`, no dependencies) is documented in
`server/PROTOCOL.md`; the shared combat simulation is `js/mp-sim.js`.

## Controls

Keys only work while the game canvas is focused. Click it, or press the Play
button.

| Key | Action |
| --- | --- |
| `A` `D` / `←` `→` | Rotate |
| `W` / `↑` | Thrust |
| `S` / `↓` | Retro thrust |
| `,` `.` / `Q` `E` | Time warp down / up (1x to 64x) |
| `+` `-` / mouse wheel | Zoom |
| `P` | Pause / resume |
| `R` | Reset |
| `Space` / `F` | Fire (multiplayer only) |
| `Tab` (hold) | Scoreboard (multiplayer only) |

Engines are disabled while time warp is above 1x. The game pauses while the
tab is hidden or the canvas is scrolled off-screen. A keyboard is required;
there are no touch controls.

## How it works

- `js/physics.js`: Kepler orbits for the star, three planets and one moon
  (bodies move on rails). The ship is a test particle pulled by every body.
  Velocity Verlet integrator, fixed 1/120 s step, and trajectory prediction
  that looks up the bodies' future positions.
- `js/sim.js`: game state. Warp N runs N times as many fixed steps per frame,
  capped at 512 per frame. The step size never changes, so accuracy does not
  drop at high warp.
- `js/render.js`: draws to a 320x180 canvas. `js/font.js` is a 3x5 bitmap font
  and `js/palette.js` is the 16-colour palette.
- `js/main.js`: input, integer scaling and the game loop. `js/page.js` drives
  the landing page.

The ship starts in a circular orbit around TIDE. Other bodies perturb it, so
over a very long time the orbit drifts.

## Tests

Needs Node 22 or newer. There are no packages to install.

```sh
for f in js/*.js server/*.js test/*.js; do node --check "$f" || exit 1; done   # syntax check
node --test            # physics, render, combat sim, websocket and server tests
```
