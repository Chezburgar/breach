# BREACH

A browser tactical arena shooter. Deadshot-style pace and playlist, Siege-style
gunplay: real recoil patterns, working optics, attachments that change the
numbers, and server-authoritative hit registration with lag compensation.

Everything renders from procedurally generated PBR materials and geometry —
there is not a single texture or model file to download, so the game boots in a
couple of seconds and can never show a missing asset.

```bash
npm install
npm start
```

Then open <http://localhost:8080>.

---

## What's in it

**Modes** — Free For All, Team Deathmatch, Domination, Capture the Flag, Gun
Game, One in the Chamber. Up to 10 players; bots fill any empty slots.

**Online play** — quick-match matchmaking, parties that queue together, and
private matches with a share code and a bot slider. A lone player is put into a
bot match after a few seconds rather than waiting forever.

**Maps** — *Old Quarter*, a 150 × 150 m coastal compound: tiled plaza, a
three-storey consulate, a market street with rooftops, a walled villa and
garden, a freight warehouse with catwalks and skylights, a watchtower, and a
service tunnel running underneath it all. Plus a *Training Ground* with a live
range, a shoot house and a movement course.

**Weapons** — eighteen guns across assault rifles, SMGs, an LMG, marksman
rifles, a shotgun and sidearms. Each has its own recoil pattern, drop-off,
handling and view model, built procedurally from a shape description.

**Optics** — iron sights, three 1x sights and four magnified scopes. Aiming
places the weapon so the optic's own sight line lands on the camera axis, so
every scope is correctly aligned on every gun. 2x and above render
picture-in-picture: the world is rendered a second time through the scope's true
field of view and shown inside the ocular.

**Banners** — every player carries a banner. It shows on the pre-game intro
cards, in the kill feed, on the scoreboard, and full-size on the ELIMINATED BY
screen when they kill you. Sixteen are generated procedurally; more can be
dropped in (below).

**Fanfares** — the winner's chosen victory fanfare plays for everyone on the
victory screen. Five are synthesised; audio files can be dropped in (below).

---

## Adding your own banners and fanfares

Both are drop-in. Nothing needs rebuilding — just add files and list them.

- **Banners** → `public/assets/banners/` — see the README in that folder.
  Images at a 3.44:1 aspect ratio (e.g. 1376 × 400), listed in `manifest.json`.
  They appear in **Profile → Banner** alongside the built-in set.
- **Fanfares** → `public/assets/fanfares/` — see the README in that folder.
  Any audio the browser can decode, listed in `manifest.json`. They appear in
  **Profile → Victory Fanfare**.

---

## Controls

| | |
|---|---|
| Move | `W` `A` `S` `D` |
| Sprint / Crouch / Jump | `Shift` / `Ctrl` / `Space` |
| Slide | `Ctrl` while sprinting |
| Lean | `Q` / `E` |
| Fire / Aim | Left mouse / Right mouse |
| Reload | `R` |
| Swap weapon | `1` `2` or mouse wheel |
| Melee | `V` |
| Inspect weapon | `T` |
| Scoreboard | `Tab` |
| Pause | `Escape` |

---

## How it fits together

```
shared/     runs identically in the browser and on the server
  controller.js   the one movement implementation — client prediction and
                  server authority step the same function on the same inputs
  collision.js    yaw-rotated box world; capsule resolve, ray casts, hitboxes
  weapons.js      weapon data, attachments, recoil patterns, damage curves
  maps/           map geometry as pure data, built through a small DSL

server/
  hub.js     connections, profiles, parties, private lobbies, matchmaking
  room.js    one match: fixed-step simulation, lag-compensated hitscan, modes
  bots.js    AI that feeds the same input structs as a human client
  nav.js     bot navigation, linked by simulating a walk between waypoints

public/src/
  engine/    renderer and post chain, procedural material lab, world builder,
             effects, audio
  game/      local player, remote players, view models, scopes, training
  ui/        HUD, menus, banners, reticles
```

A few things worth knowing:

- **Movement is predicted and reconciled.** The client runs the shared
  controller immediately, then replays any inputs the server has not yet
  acknowledged when an authoritative state arrives. Residual error is absorbed
  into a decaying offset rather than snapping.
- **Shots are resolved on the server**, rewinding other players to where the
  shooter saw them, capped at 350 ms. Spread is sampled from a deterministic
  sequence both ends share, so the tracer you see is the shot the server fired.
- **Bot navigation links are derived by walking them.** Rather than guessing
  from line of sight — which gets stairs and doorways wrong — the graph is built
  by simulating a player walking between each pair of waypoints with the real
  controller.
- **Materials are painted at load.** Around two dozen surfaces are generated as
  albedo, a normal map derived from a height field, and a packed
  roughness/metalness map, then merged by material so the level draws in roughly
  twenty calls.

---

## Checks

```bash
npm run check
```

Builds every map and verifies there are no degenerate boxes, that every spawn
settles on solid ground without being embedded, that random walkers cannot fall
out of the world, that the ground is closed from above, that the navigation
graph is fully connected with no waypoint stuck inside geometry, that every
weapon resolves to finite recoil and spread — then simulates three minutes of
every game mode with eight bots and checks that they fight, that nobody ends up
inside the level, and that the end-of-match payload is complete.

There is also a map preview harness at `/preview.html?map=oldquarter&q=ultra`
for looking at geometry and materials without starting a match.

---

## Graphics settings

Low / Medium / High / Ultra, in **Settings**. They trade pixel ratio, shadow
resolution, ambient occlusion, material resolution and the number of dynamic
lights. Ultra runs 4K sun shadows and 384px materials. Changing the preset takes
effect immediately except for material resolution, which needs a reload.
