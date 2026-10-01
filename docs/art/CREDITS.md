# Art credits

Every third-party asset in the web app, with its source and licence. Only CC0 (public domain)
assets are used. Add a row whenever an asset is added.

## Fantasy trail world (`web/public/worlds/fantasy/`)

| Asset | Author | Source | Licence | Files |
|---|---|---|---|---|
| Medieval Village MegaKit (Standard, free version) | Quaternius | <https://quaternius.com> | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (`models/LICENSE-Quaternius-MedievalVillageMegaKit.txt`) | see below |

Models (`models/*.gltf` + `.bin`, geometry only):

- Walls: `Wall_Plaster_Straight`, `Wall_Plaster_Window_Wide_Round`, `Wall_Plaster_Door_Round`,
  `Wall_Plaster_WoodGrid`, `Wall_UnevenBrick_Straight`, `Wall_UnevenBrick_Window_Wide_Round`,
  `Wall_UnevenBrick_Window_Thin_Round`, `Wall_UnevenBrick_Door_Round`, `Wall_BottomCover`,
  `Corner_Exterior_Wood`
- Roofs: `Roof_RoundTiles_4x4`, `Roof_RoundTiles_4x6`, `Roof_RoundTiles_6x6`, `Roof_RoundTiles_6x8`,
  `Roof_Front_Brick4`, `Roof_Front_Brick6`, `Roof_Tower_RoundTiles`
- Windows and doors: `Window_Wide_Round1`, `Window_Thin_Round1`, `WindowShutters_Wide_Round_Open`,
  `WindowShutters_Wide_Round_Closed`, `Door_1_Round`
- Props: `Prop_Chimney`, `Prop_Chimney2`, `Prop_Vine1`, `Prop_Vine4`, `Prop_WoodenFence_Single`,
  `Prop_WoodenFence_Extension1`, `Prop_Wagon`,
  `Prop_Crate`, `Prop_Brick1`-`4`, `Prop_Support`

Textures (`textures/`, downscaled by the import script: base colour 1024 px JPEG, normal map 512 px
JPEG): `T_Plaster_BaseColor`/`Normal`, `T_UnevenBrick_BaseColor`/`Normal`, `T_RoundTiles_BaseColor`/`Normal`,
`T_WoodTrim_BaseColor`/`Normal`, `T_RockTrim_BaseColor`/`Normal`, `T_Brick_BaseColor`/`Normal`, and the
leaf mask `T_VineLeaf.png` (alpha channel only).

Imported with `web/tools/import_quaternius.py`. Houses, castle towers, walls and gates are
assembled in code from these pieces (`gen.ts`: `house()`, `tower()`); foundations, battlements,
lanterns and the windmill are procedural shapes wearing the kit's textures.

Everything else in the fantasy world (terrain, cobbled roads, trees, grass, crops, rocks, ruins
pillars and arches, crystals, waterfalls, water ripples, sky, clouds, stars, fireflies, city
towers, neon, rain) is generated in code (`web/src/worlds/fantasy/`), no external assets.

## Walker sprite (`web/public/walker/`)

The owner's own artwork (not third-party).

## Maps and imagery

- OpenStreetMap tiles (minimap, route planner): © OpenStreetMap contributors, ODbL, credited on
  the map.
- Google Photorealistic 3D Tiles (Real world world): Google's attribution shown on screen.
