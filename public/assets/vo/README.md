# Announcer voice-over

The pre-game announcer reads the rosters over the fly-through. It has two
voices and prefers the good one:

1. **Recorded clips from this folder.** However you make them — a microphone,
   ElevenLabs, Azure, `say -o` on a Mac.
2. **The browser's speech synthesiser**, for anything with no clip. It sounds
   synthetic, but it can pronounce a name it has never seen, which no
   recording can.

## What to record

    node tools/vo-script.js

prints every line and the filename it needs. `--json` gives you the same list
in a shape you can feed straight to a TTS API.

## How lines are built

A roster line is stitched from fragments — the frame, a clip per name, and
"and" before the last one:

    frame_on_vanguard  +  name_kestrel  +  name_vulcan  +  frame_and  +  name_rooke

Recording every possible line-up is impossible, so the pieces are recorded once
and recombined. Record them with **list intonation**: the frame and the middle
names rising, as though more is coming, and let the sentence fall only on the
last name.

A line only uses recordings if *every* fragment of it exists. Miss one and the
whole sentence goes to the synthesiser instead — half a line in a real voice
and half in a robot is worse than either on its own.

## Registering them

    {
      "clips": [
        { "id": "map_blackmoor_estate", "file": "map_blackmoor_estate.mp3" },
        { "id": "frame_on_vanguard",    "file": "frame_on_vanguard.mp3" }
      ]
    }

Ids must match the script exactly. Human players will always fall back to the
synthesiser — their names are not knowable in advance.
