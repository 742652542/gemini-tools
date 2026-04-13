import asyncio
import os
import shutil
from datetime import datetime, timedelta, time as dt_time
from pathlib import Path
from zoneinfo import ZoneInfo

TARGET_DIRECTORIES = ["task_results", "task_files", "task_wait"]
RETENTION_DAYS = 30
BEIJING_TIMEZONE = ZoneInfo("Asia/Shanghai")


def _iter_expired_entries(base_dir: str, cutoff_timestamp: float):
    if not os.path.isdir(base_dir):
        return

    for entry_name in os.listdir(base_dir):
        entry_path = os.path.join(base_dir, entry_name)
        try:
            modified_at = os.path.getmtime(entry_path)
        except OSError as exc:
            print(f"[cleanup-scheduler] Failed to inspect {entry_path}: {exc}")
            continue

        if modified_at < cutoff_timestamp:
            yield entry_path


def _cleanup_target_directories(repo_dir: str):
    cutoff_timestamp = (datetime.now(BEIJING_TIMEZONE) - timedelta(days=RETENTION_DAYS)).timestamp()
    deleted_paths = []

    for relative_dir in TARGET_DIRECTORIES:
        target_dir = os.path.join(repo_dir, relative_dir)
        for expired_path in _iter_expired_entries(target_dir, cutoff_timestamp):
            try:
                if os.path.isdir(expired_path):
                    shutil.rmtree(expired_path)
                else:
                    os.remove(expired_path)
                deleted_paths.append(os.path.relpath(expired_path, repo_dir))
            except OSError as exc:
                print(f"[cleanup-scheduler] Failed to delete {expired_path}: {exc}")

    if deleted_paths:
        print(f"[cleanup-scheduler] Deleted expired entries: {', '.join(deleted_paths)}")
    else:
        print("[cleanup-scheduler] No expired entries found.")


def _seconds_until_next_beijing_midnight() -> float:
    now = datetime.now(BEIJING_TIMEZONE)
    next_run_date = now.date() + timedelta(days=1)
    next_run = datetime.combine(next_run_date, dt_time.min, tzinfo=BEIJING_TIMEZONE)
    return max((next_run - now).total_seconds(), 1.0)


async def _cleanup_loop(repo_dir: str, stop_event: asyncio.Event):
    while not stop_event.is_set():
        wait_seconds = _seconds_until_next_beijing_midnight()

        try:
            await asyncio.wait_for(stop_event.wait(), timeout=wait_seconds)
            break
        except asyncio.TimeoutError:
            pass

        try:
            await asyncio.to_thread(_cleanup_target_directories, repo_dir)
        except Exception as exc:
            print(f"[cleanup-scheduler] Unexpected cleanup error: {exc}")


def start_cleanup_scheduler(app):
    if getattr(app.state, "cleanup_scheduler_task", None):
        return

    repo_dir = str(Path(__file__).resolve().parent)
    stop_event = asyncio.Event()
    app.state.cleanup_scheduler_stop_event = stop_event
    app.state.cleanup_scheduler_task = asyncio.create_task(_cleanup_loop(repo_dir, stop_event))
    print("[cleanup-scheduler] Background cleanup scheduler started.")


async def stop_cleanup_scheduler(app):
    stop_event = getattr(app.state, "cleanup_scheduler_stop_event", None)
    task = getattr(app.state, "cleanup_scheduler_task", None)

    if stop_event is None or task is None:
        return

    stop_event.set()
    try:
        await task
    except Exception as exc:
        print(f"[cleanup-scheduler] Background cleanup scheduler stopped with error: {exc}")
    finally:
        app.state.cleanup_scheduler_stop_event = None
        app.state.cleanup_scheduler_task = None
