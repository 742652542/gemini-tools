from __future__ import annotations

import argparse
import hashlib
import shutil
import subprocess
import sys
from pathlib import Path


def file_sha256(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def process_image(image_path: Path, exe_path: Path) -> bool:
    original_data = image_path.read_bytes()
    original_hash = hashlib.sha256(original_data).hexdigest()

    attempts = [
        ("legacy", [str(exe_path), "--legacy", "--no-banner", "-i", str(image_path), "-o", str(image_path)]),
        ("default", [str(exe_path), "--no-banner", str(image_path)]),
        ("force", [str(exe_path), "--no-banner", "--force", "-i", str(image_path), "-o", str(image_path)]),
    ]

    for profile, command in attempts:
        if profile != "legacy":
            image_path.write_bytes(original_data)

        try:
            result = subprocess.run(command, check=False)
        except Exception as exc:
            print(f"Failed to execute GeminiWatermarkTool ({profile}): {exc}")
            result = None

        if result and result.returncode == 0 and file_sha256(image_path) != original_hash:
            print(f"Watermark processing successful ({profile}): {image_path}")
            return True

        print(f"Watermark processing not successful ({profile}), trying fallback if available: {image_path}")

    image_path.write_bytes(original_data)
    return False


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run GeminiWatermarkTool.exe with legacy/default/force fallback")
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
    if not image_path.exists() or not image_path.is_file():
        parser.error(f"image not found: {image_path}")

    exe_path = Path(args.exe).resolve()
    if not exe_path.exists() or not exe_path.is_file():
        parser.error(f"exe not found: {exe_path}")

    output_path = Path(args.output).resolve() if args.output else image_path
    if output_path != image_path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(image_path, output_path)
        target_path = output_path
    else:
        target_path = image_path

    success = process_image(target_path, exe_path)
    return 0 if success else 1


if __name__ == "__main__":
    raise SystemExit(main())
