from __future__ import annotations

import argparse
import hashlib
import shutil
import subprocess
import sys
from pathlib import Path

import cv2


def file_sha256(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def get_watermark_size(width: int, height: int) -> str:
    return "large" if width > 1024 and height > 1024 else "small"


def get_watermark_config(width: int, height: int, variant: str) -> tuple[int, int, int]:
    is_large = width > 1024 and height > 1024
    if variant == "v1":
        if is_large:
            return 64, 64, 96
        return 32, 32, 48

    if is_large:
        return 192, 192, 96

    long_side = max(width, height)
    short_side = min(width, height)
    if short_side >= 566:
        source_long_dim = 2752.0
    elif short_side >= 550:
        source_long_dim = 2816.0
    else:
        source_long_dim = 2848.0
    scale = float(long_side) / source_long_dim
    margin = int(round(192.0 * scale))
    return margin, margin, 36


def default_search_rect(width: int, height: int, variant: str) -> tuple[int, int, int, int]:
    margin_right, margin_bottom, logo_size = get_watermark_config(width, height, variant)
    pos_x = width - margin_right - logo_size
    pos_y = height - margin_bottom - logo_size
    size_kind = get_watermark_size(width, height)

    if variant == "v2" and size_kind == "small":
        search_size = 120
    elif size_kind == "large":
        search_size = 160
    else:
        search_size = 120

    center_x = pos_x + (logo_size // 2)
    center_y = pos_y + (logo_size // 2)
    x = max(0, center_x - (search_size // 2))
    y = max(0, center_y - (search_size // 2))
    x = min(x, max(0, width - search_size))
    y = min(y, max(0, height - search_size))
    w = min(search_size, width - x)
    h = min(search_size, height - y)
    return x, y, w, h


def run_command(command: list[str]) -> int | None:
    try:
        result = subprocess.run(command, check=False)
        return result.returncode
    except Exception as exc:
        print(f"Command failed: {command}\nError: {exc}")
        return None


def process_like_python(image_path: Path, exe_path: Path) -> bool:
    original_data = image_path.read_bytes()
    original_hash = hashlib.sha256(original_data).hexdigest()

    image = cv2.imdecode(cv2.imencode(".png", cv2.imread(str(image_path), cv2.IMREAD_COLOR))[1], cv2.IMREAD_COLOR)
    if image is None:
        print(f"Failed to decode image: {image_path}")
        return False
    img_h, img_w = image.shape[:2]
    size_kind = get_watermark_size(img_w, img_h)

    v2_fixed = [str(exe_path), "--no-banner", "--no-legacy", str(image_path)]
    if run_command(v2_fixed) == 0 and file_sha256(image_path) != original_hash:
        print(f"[OK] {image_path.name} via v2_fixed")
        return True

    image_path.write_bytes(original_data)
    search_x, search_y, search_w, search_h = default_search_rect(img_w, img_h, "v2")
    snap_min, snap_max = (32, 48) if size_kind == "small" else (48, 64)
    v2_enhanced = [
        str(exe_path),
        "--no-banner",
        "--no-legacy",
        "-i",
        str(image_path),
        "-o",
        str(image_path),
        "--fallback-region",
        f"{search_x},{search_y},{search_w},{search_h}",
        "--snap",
        "--snap-min-size",
        str(snap_min),
        "--snap-max-size",
        str(snap_max),
        "--snap-threshold",
        "0.50",
    ]
    if run_command(v2_enhanced) == 0 and file_sha256(image_path) != original_hash:
        print(f"[OK] {image_path.name} via v2_enhanced")
        return True

    image_path.write_bytes(original_data)
    v1_fixed = [str(exe_path), "--legacy", "--no-banner", "-i", str(image_path), "-o", str(image_path)]
    if run_command(v1_fixed) == 0 and file_sha256(image_path) != original_hash:
        print(f"[OK] {image_path.name} via v1_fixed")
        return True

    image_path.write_bytes(original_data)
    print(f"[SKIP] {image_path.name} via like-python flow")
    return False


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run GeminiWatermarkTool.exe using a flow similar to current Python logic")
    parser.add_argument("image", help="Input image path")
    parser.add_argument("-o", "--output", help="Optional output image path")
    parser.add_argument(
        "--exe",
        default=str(Path(__file__).with_name("GeminiWatermarkTool.exe")),
        help="Path to GeminiWatermarkTool.exe",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    image_path = Path(args.image).resolve()
    exe_path = Path(args.exe).resolve()
    if not image_path.exists() or not image_path.is_file():
        parser.error(f"image not found: {image_path}")
    if not exe_path.exists() or not exe_path.is_file():
        parser.error(f"exe not found: {exe_path}")

    output_path = Path(args.output).resolve() if args.output else image_path
    if output_path != image_path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(image_path, output_path)
        target_path = output_path
    else:
        target_path = image_path

    success = process_like_python(target_path, exe_path)
    return 0 if success else 1


if __name__ == "__main__":
    raise SystemExit(main())
