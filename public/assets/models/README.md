# Operator model

`operator.fbx` is the rigged character. It does **not** embed its textures — it
names them, and they have to sit in this folder next to it, with these exact
filenames:

| file | what it is | needed |
| --- | --- | --- |
| `Color_b32e675f-6421-4861-8965-0117541f4582.jpg` | base colour — the white, black and gold kit | yes |
| `NormalGL_b32e675f-6421-4861-8965-0117541f4582.jpg` | normal map (OpenGL green channel) | optional |
| `ORM_b32e675f-6421-4861-8965-0117541f4582.jpg` | occlusion / roughness / metalness packed into R / G / B | optional |

Without the colour map every operator renders as a flat untextured shape,
because the FBX still declares a texture and three.js builds one with no image
behind it. The loader checks for these files and falls back to a plain
off-white finish if they are absent, so the game runs either way — but the
model will not look like it is supposed to until the colour map is here.

The team colour is **not** part of the texture. It is added as a rim along the
edge of the silhouette at draw time, so the same maps serve both sides.

## Rig

No animation clips — every pose is authored procedurally in
`src/game/character.js` against the bone names. The rig faces +Z; the
controller's forward is −Z, so the loader turns it half a circle before
anything else touches it.
