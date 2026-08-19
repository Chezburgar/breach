# Commentary booth

Fifteen ElevenLabs lines from two personas — an analyst and an Aussie colour
commentator. The booth alternates between them so consecutive lines sound like
two people rather than one on a loop, and never plays the same clip twice
running.

    node tools/vo-list.js

lists every clip, its length, and the slot it is in.

## Slots

Slots decide *when* a line can play:

| slot    | when                                          |
|---------|-----------------------------------------------|
| `intro` | under the pre-game fly-through                |
| `round` | a round starting or ending, and the match end  |
| `sting` | short punctuation — a three-kill streak        |

An `intro` clip is only chosen if it fits inside the fly-through, so a line
longer than the intro is skipped rather than cut off.

## These clips were slotted by length, not by content

Length is the only thing about an audio file that can be read without
listening to it — so the initial slotting is a guess: over six seconds went to
`intro`, three to six to `round`, under three to `sting`.

**Listen to them and fix the ones that landed wrong.** Edit `slot` in
`manifest.json`; nothing in the game code names a clip, so that file is the
only place the booth is configured. Fill in `text` while you are there — it is
never read by the game, but a line you cannot identify is a line you cannot
place.

## Adding more

Drop the file in this folder and add an entry:

    { "id": "booth_aussie_x", "file": "booth_aussie_x.mp3",
      "persona": "aussie", "seconds": 3.2, "slot": "round", "text": "..." }

`seconds` only matters for the `intro` fit check. `persona` is any string —
the booth simply prefers whichever one did not speak last.

## No player names

The booth never reads names. No recording can say a name it has never heard,
and stitching one in from the browser's synthesiser sounded worse than not
saying it at all.
