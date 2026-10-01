#!/usr/bin/env python3
"""Copy the Quaternius "Medieval Village MegaKit (Standard)" pieces the fantasy world uses into
web/public/worlds/fantasy/models, plus its hand-painted textures shrunk for the web.

The kit ships ~100 MB of 2048-4096 px PNG textures; the world needs a few: base colours as
1024 px JPEG, normal maps as 512 px JPEG, the vine leaf mask as a small PNG (about 3 MB in all).
Texture references are stripped from the glTF JSON (the world assigns its own materials by
material name, see src/worlds/fantasy/assets.ts). The kit is CC0 1.0 (its License_Standard.txt
is copied along); credits are in docs/art/CREDITS.md.

    python3 web/tools/import_quaternius.py "~/Downloads/Medieval Village MegaKit[Standard].zip"
"""

from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path

KIT = "Medieval Village MegaKit[Standard]"
MODELS = [
    "Wall_UnevenBrick_Straight",
    "Wall_UnevenBrick_Window_Wide_Round",
    "Wall_UnevenBrick_Door_Round",
    "Prop_WoodenFence_Single",
    "Prop_WoodenFence_Extension1",
    "Prop_Wagon",
    "Prop_Crate",
    "Prop_Brick1",
    "Prop_Brick2",
    "Prop_Brick3",
    "Prop_Brick4",
    "Prop_Support",
    # Village houses (assembled in code from these modular pieces).
    "Wall_Plaster_Straight",
    "Wall_Plaster_Window_Wide_Round",
    "Wall_Plaster_Door_Round",
    "Wall_Plaster_WoodGrid",
    "Wall_BottomCover",
    "Corner_Exterior_Wood",
    "Roof_RoundTiles_4x4",
    "Roof_RoundTiles_4x6",
    "Roof_RoundTiles_6x6",
    "Roof_RoundTiles_6x8",
    "Roof_Front_Brick4",
    "Roof_Front_Brick6",
    "Prop_Chimney",
    "Prop_Chimney2",
    "Window_Wide_Round1",
    "WindowShutters_Wide_Round_Open",
    "WindowShutters_Wide_Round_Closed",
    "Prop_Vine1",
    "Prop_Vine4",
    "Door_1_Round",
    "Wall_UnevenBrick_Window_Thin_Round",
    "Window_Thin_Round1",
    # Castles (keeps and towers built from brick walls) and farms.
    "Roof_Tower_RoundTiles",
]
# (texture, max size, format)
TEXTURES = [
    ("T_Plaster_BaseColor", 1024, "jpg"), ("T_Plaster_Normal", 512, "jpg"),
    ("T_UnevenBrick_BaseColor", 1024, "jpg"), ("T_UnevenBrick_Normal", 512, "jpg"),
    ("T_RoundTiles_BaseColor", 1024, "jpg"), ("T_RoundTiles_Normal", 512, "jpg"),
    ("T_WoodTrim_BaseColor", 1024, "jpg"), ("T_WoodTrim_Normal", 512, "jpg"),
    ("T_RockTrim_BaseColor", 1024, "jpg"), ("T_RockTrim_Normal", 512, "jpg"),
    ("T_Brick_BaseColor", 1024, "jpg"), ("T_Brick_Normal", 512, "jpg"),
    ("T_VineLeaf", 256, "png"),
]
OUT = Path(__file__).resolve().parents[1] / "public" / "worlds" / "fantasy" / "models"
TEX_OUT = OUT.parent / "textures"


def strip_textures(gltf: dict) -> dict:
    for key in ("images", "textures", "samplers"):
        gltf.pop(key, None)
    for material in gltf.get("materials", []):
        pbr = material.get("pbrMetallicRoughness", {})
        for tex in ("baseColorTexture", "metallicRoughnessTexture"):
            pbr.pop(tex, None)
        for tex in ("normalTexture", "occlusionTexture", "emissiveTexture"):
            material.pop(tex, None)
    return gltf


def main(zip_path: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(Path(zip_path).expanduser()) as z:
        for name in MODELS:
            base = f"{KIT}/glTF/{name}"
            gltf = strip_textures(json.loads(z.read(base + ".gltf")))
            buffers = gltf.get("buffers", [])
            if len(buffers) != 1:
                raise SystemExit(f"{name}: expected one buffer, found {len(buffers)}")
            bin_name = buffers[0]["uri"]
            (OUT / f"{name}.gltf").write_text(json.dumps(gltf, separators=(",", ":")))
            (OUT / bin_name).write_bytes(z.read(f"{KIT}/glTF/{bin_name}"))
            print(f"  {name}")
        (OUT / "LICENSE-Quaternius-MedievalVillageMegaKit.txt").write_bytes(z.read(f"{KIT}/License_Standard.txt"))
        import io

        from PIL import Image  # only needed for the import

        TEX_OUT.mkdir(parents=True, exist_ok=True)
        for name, size, fmt in TEXTURES:
            image = Image.open(io.BytesIO(z.read(f"{KIT}/Textures/{name}.png")))
            image = image.getchannel("A") if fmt == "png" else image.convert("RGB")  # png: the leaf mask
            image.thumbnail((size, size), Image.LANCZOS)
            path = TEX_OUT / f"{name}.{fmt}"
            if fmt == "jpg":
                image.save(path, quality=88 if "Normal" in name else 84, optimize=True)
            else:
                image.save(path, optimize=True)
            print(f"  {path.name}  {path.stat().st_size // 1024} KB")
    total = sum(p.stat().st_size for p in OUT.iterdir())
    textures = sum(p.stat().st_size for p in TEX_OUT.iterdir())
    print(f"{len(MODELS)} models, {total / 1024:.0f} KB; textures {textures / 1024:.0f} KB")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else f"~/Downloads/{KIT}(1).zip")
