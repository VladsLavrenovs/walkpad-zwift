# NPC sprite sheets

Drop `look-0.png` ... `look-7.png` here to replace the placeholder people of the Open world
(missing files keep the placeholder). Format, one PNG per look:

- 5 columns: 0 standing, 1-4 the walk cycle (one stride);
- 8 rows: the character seen from 8 directions, row 0 from the front (facing you), turning
  45 degrees at a time: row 2 shows its right side (it faces the left of the picture), row 4 its
  back, row 6 its left side (it faces the right of the picture);
- cells 1:2 wide:high (e.g. 128 x 256 px, so the sheet is 640 x 2048), feet at the bottom
  middle, transparent background.

The figure is drawn 1.75 m tall. See `web/src/worlds/openworld/npcsprites.ts`.
