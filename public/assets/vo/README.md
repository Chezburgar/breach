# Commentary booth

Recorded lines played against match events. Which clip belongs to which moment
lives entirely in `manifest.json` — nothing in the game code names a file.

    node tools/vo-list.js

## Slots

| slot    | when                                    | team |
|---------|-----------------------------------------|------|
| `intro` | the pre-game fly-through, in `order`    | —    |
| `elim`  | that side got an elimination            | yes  |
| `last`  | that side is down to one player         | yes  |
| `round` | that side won the round                 | yes  |
| `win`   | that side won the match                 | yes  |

`team` is `0` for Vanguard, `1` for Sentinel. A slot with several clips for a
side picks between them at random, never the same one twice running.

## Two rules

**Nothing overlaps.** One line at a time, always.

**Late is worse than silent.** A booth only convinces if it reacts to what
just happened, so a line that waited too long is dropped rather than played
against the wrong moment. Each slot has its own patience: a win announcement
never expires, a round result waits six seconds, an elimination call is stale
after 1.6 and is thrown away. Higher-priority lines jump the queue — a match
win interrupts nothing but is served before any elimination still waiting.

A kill that leaves a side on their last player calls `last` rather than
`elim`: it is the more interesting fact, and saying both would be two lines
about one event.

## One opening per map

An `intro` clip can name a `map`, and then it is only ever heard there. A clip
with no `map` suits any of them.

| map       | lines | spoken | window |
|-----------|-------|--------|--------|
| `estate`  | 3     | 24.8s  | 26.0s  |
| `skyline` | 2     | 16.0s  | 17.5s  |

The window is the map's own `introDuration`, set in its builder — the estate
falls back to `MATCH.introDuration` in `shared/constants.js`. The fly-through
stretches to fill whatever the window is, so lines and window move together:
add a line and the camera has to be given longer, or it lands before the booth
stops talking. `npm run check` fails if a map's lines no longer fit.

## Adding more

    { "id": "elim_vanguard_4", "file": "elim_vanguard_4.mp3",
      "slot": "elim", "team": 0, "seconds": 2.4, "text": "..." }

`seconds` is only used to keep an intro line inside the fly-through, and
`map` only applies to `intro`. `text` is never read by the game — it is there
so you can tell the files apart.
