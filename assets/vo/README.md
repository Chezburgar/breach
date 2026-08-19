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

## The intro runs 24.4 seconds

Three lines in order, so `MATCH.introDuration` in `shared/constants.js` is
26 seconds and the fly-through stretches to fill it. Shorten one and the other
has to follow, or the camera lands before the booth stops talking.

## Adding more

    { "id": "elim_vanguard_4", "file": "elim_vanguard_4.mp3",
      "slot": "elim", "team": 0, "seconds": 2.4, "text": "..." }

`seconds` is only used to keep an intro line inside the fly-through. `text` is
never read by the game — it is there so you can tell the files apart.
