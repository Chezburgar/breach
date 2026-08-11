# Player banners

Drop images in this folder and list them in `manifest.json`. They appear in
**Profile → Banner**, alongside the sixteen procedural banners the game ships
with, and show up in the pre-game intro, the kill feed, the scoreboard and on
the "ELIMINATED BY" screen.

```json
{
  "banners": [
    { "id": "b_wolfpack", "name": "Wolfpack", "file": "wolfpack.png", "rarity": "epic" },
    { "id": "b_gold",     "name": "Gilded",   "file": "gilded.jpg",   "rarity": "legendary" }
  ]
}
```

- `file` is relative to this folder.
- `id` must be unique and stable — it is what gets saved in a player's profile.
- `rarity` is optional (`common`, `uncommon`, `rare`, `epic`, `legendary`) and
  only controls the colour of the strip along the bottom edge.
- **Aspect ratio 3.44:1** — for example 1376 × 400. Other ratios are
  centre-cropped to fill.
- PNG or JPG. Around 1400px wide is plenty; they are drawn no larger than that.
- The right-hand third is overlaid with a dark scrim and the player's name, so
  keep important artwork on the left.
