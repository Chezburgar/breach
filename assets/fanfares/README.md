# Victory fanfares

Drop audio files in this folder and list them in `manifest.json`. They then appear
in **Profile → Victory Fanfare**, and the winner's chosen fanfare plays for
everyone on the victory screen.

```json
{
  "fanfares": [
    { "id": "my_horns",  "name": "Horns of Dawn", "file": "horns-of-dawn.mp3" },
    { "id": "my_anthem", "name": "Anthem",        "file": "anthem.ogg" }
  ]
}
```

- `file` is relative to this folder.
- `id` must be unique and stable — it is what gets saved in a player's profile.
- Any format the browser can decode works: `.mp3`, `.ogg`, `.m4a`, `.wav`.
- Keep them short. Two to six seconds sits best against the victory screen.
- Loudness is not normalised, so master them at a similar level to each other.

Until files are added here, the game uses its five built-in synthesised
fanfares, so nothing is missing out of the box.
