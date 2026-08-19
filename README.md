# BREACH

A browser tactical shooter. Five on five, one life a round, best of five,
played on a single walled estate. Runs entirely in the browser — no plugins,
no downloads, no game server.

**Play: https://chezburgar.github.io/breach/**

## The mode

One mode, `Breach`. Two squads of five, one life each round, first to three
rounds. Dying puts you on a shoulder camera following a living teammate until
the round resolves, so a bad peek costs you the round rather than four seconds.
Squads deploy together, and a short freeze period opens each round.

## The map

**Blackwood Estate.** Three routes run from the north gate to the south
gardens: through the manor, around the chapel terrace, or through the stable
yard. The manor is the centrepiece — a double-height great hall with a gallery
ring around the void, two service stairwells running ground to roof, and
balconies over both approaches. A wine cellar cuts underneath from the hall out
to a garden grotto. Cover is placed so holding an angle is always possible and
never safe.

## Weapons

Eighteen guns with Siege-style handling: learnable recoil patterns, real damage
drop-off, and attachments that change the numbers rather than the look. Every
optic is a working sight — magnified scopes render the world a second time
through a narrow field of view and show it in the ocular, so 2x and above
genuinely magnify.

Three throwables share a fifteen second cooldown: frag, flashbang and smoke.
Flashes scale with proximity *and* how directly you were looking at them, so
turning away is real counterplay. Smoke blocks sight for bots as well as
players.

## Networking

There is no server. One player hosts — their browser runs the authoritative
simulation — and everyone else connects over a WebRTC data channel. Movement is
client-predicted and reconciled against the host, and shots are lag-compensated
by rewinding other players to when the shooter actually saw them.

- **Quick Play** walks six public lobby slots and joins the first one
  answering, or opens one itself.
- **Host / Join** uses a five-character code.
- **Training Ground** is offline: live range, shoot house, movement course,
  and a pedestal for every weapon.

Signalling goes through the public PeerJS broker; TURN relays come from
Metered.

> The Metered API key is fetched client-side by design and is therefore public
> in this repository. Anyone reading it can consume the TURN quota. Use a key
> issued for this project alone so it can be rotated independently.

## Art and audio

Almost nothing is a downloaded asset. Every material is painted procedurally at
load time — albedo, a normal map derived from a height field, and a packed
roughness/metalness map — so there are no missing textures and no pop-in.
Weapons are built from their stat blocks, so each silhouette is distinct without
a single model file. Gunfire, impacts, footsteps, explosions and flashbangs are
all synthesised through the Web Audio API.

The operator model and the victory fanfares are the exceptions. The model is
rigged but ships no animation clips, so idle, run, crouch, aim, airborne and
death are authored procedurally against its bones.

Drop your own artwork in without touching code:

- `public/assets/banners/` — see the README there for the manifest format.
- `public/assets/fanfares/` — the winner's chosen fanfare plays for everyone.

## Running it

```bash
npm install
npm start          # http://localhost:8080
```

The Node server is only a static host and a development convenience; matches
still run peer-to-peer. Other useful scripts:

```bash
npm run check      # headless: map geometry, navigation, weapons, full matches
npm run build      # emits a self-contained dist/
```

`npm run check` is worth knowing about. It builds every map and verifies that
spawns settle on solid ground, that random walkers cannot fall out of the
world, that the navigation graph is fully connected with no waypoint buried in
geometry, and then simulates complete matches with bots. It has caught real
faults — stairwells with no hole through the deck above them, a tower built as
a solid block, shelving across a doorway.

## Controls

| | |
|---|---|
| Move / sprint / crouch | `WASD` · `Shift` · `Ctrl` |
| Jump · Lean | `Space` · `Q` / `E` |
| Fire · Aim | Left mouse · Right mouse |
| Reload · Melee · Inspect | `R` · `V` · `T` |
| Weapons | `1` · `2` · scroll |
| Grenades | `3` frag · `4` flash · `5` smoke · `G` throw |
| Scoreboard · Menu | `Tab` · `Esc` |

Sprinting while crouching slides. Sliding under the low overhang on the
training course is the intended way through it.
