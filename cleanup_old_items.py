import argparse
import os
import shutil
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path


TARGET_DIRECTORIES = [
    Path(r"C:\Users\Administrator\Desktop\tools\gemini-tools\task_results"),
    Path(r"C:\Users\Administrator\Desktop\tools\gemini-tools\task_files"),
    Path(r"C:\Users\Administrator\Downloads"),
]
DEFAULT_RETENTION_DAYS = 2


@dataclass
class CleanupStats:
    deleted_files: int = 0
    deleted_dirs: int = 0
    skipped_missing_roots: int = 0
    errors: int = 0


def is_older_than(path: Path, cutoff: datetime) -> bool:
    try:
        created_at = datetime.fromtimestamp(path.stat().st_ctime)
    except OSError:
        return False
    return created_at < cutoff


def remove_path(path: Path, dry_run: bool) -> None:
    if dry_run:
        return

    if path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink()


def cleanup_root(root: Path, cutoff: datetime, dry_run: bool, stats: CleanupStats) -> None:
    if not root.exists():
        print(f"[skip] Directory does not exist: {root}")
        stats.skipped_missing_roots += 1
        return

    print(f"[scan] Scanning: {root}")

    for current_root, dir_names, file_names in os.walk(root, topdown=False):
        current_path = Path(current_root)

        for file_name in file_names:
            file_path = current_path / file_name
            try:
                if not is_older_than(file_path, cutoff):
                    continue
                print(f"[file] {'Would delete' if dry_run else 'Deleted'}: {file_path}")
                remove_path(file_path, dry_run)
                stats.deleted_files += 1
            except OSError as exc:
                print(f"[error] Failed to delete file: {file_path} -> {exc}")
                stats.errors += 1

        for dir_name in dir_names:
            dir_path = current_path / dir_name
            try:
                if not is_older_than(dir_path, cutoff):
                    continue

                # Delete only old directories that are already empty, so newer files are never removed indirectly.
                if any(dir_path.iterdir()):
                    continue

                print(f"[dir] {'Would delete' if dry_run else 'Deleted'}: {dir_path}")
                remove_path(dir_path, dry_run)
                stats.deleted_dirs += 1
            except OSError as exc:
                print(f"[error] Failed to delete directory: {dir_path} -> {exc}")
                stats.errors += 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Delete files and empty directories older than N days")
    parser.add_argument("--days", type=int, default=DEFAULT_RETENTION_DAYS, help="Retention days, default 3")
    parser.add_argument("--dry-run", action="store_true", help="Preview only, do not delete anything")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.days < 0:
        raise SystemExit("--days must be 0 or greater")

    cutoff = datetime.now() - timedelta(days=args.days)
    stats = CleanupStats()

    print(f"Retention days: {args.days}")
    print(f"Cutoff time: {cutoff:%Y-%m-%d %H:%M:%S}")
    print(f"Mode: {'dry-run' if args.dry_run else 'delete'}")

    for root in TARGET_DIRECTORIES:
        cleanup_root(root, cutoff, args.dry_run, stats)

    print("\nCleanup complete")
    print(f"Deleted files: {stats.deleted_files}")
    print(f"Deleted directories: {stats.deleted_dirs}")
    print(f"Missing root directories: {stats.skipped_missing_roots}")
    print(f"Errors: {stats.errors}")
    return 0 if stats.errors == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
