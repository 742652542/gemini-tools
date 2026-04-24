import asyncio
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

REMOTE_REPO_URL = "https://github.com/742652542/gemini-tools.git"
PRESERVED_DIRECTORIES = ["task_results", "task_files", "task_wait"]


def _run_git_command(args, repo_dir: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        args,
        cwd=repo_dir,
        capture_output=True,
        text=True,
        shell=False,
    )


def _backup_preserved_directories(repo_dir: str, backup_root: str):
    preserved = []

    for relative_dir in PRESERVED_DIRECTORIES:
        source_dir = os.path.join(repo_dir, relative_dir)
        backup_dir = os.path.join(backup_root, relative_dir)
        if os.path.exists(source_dir):
            shutil.copytree(source_dir, backup_dir)
            preserved.append(relative_dir)

    return preserved


def _restore_preserved_directories(repo_dir: str, backup_root: str, preserved_dirs):
    for relative_dir in preserved_dirs:
        target_dir = os.path.join(repo_dir, relative_dir)
        backup_dir = os.path.join(backup_root, relative_dir)

        if os.path.exists(target_dir):
            shutil.rmtree(target_dir)

        shutil.copytree(backup_dir, target_dir)


def _sync_repository(repo_dir: str):
    repo_check = _run_git_command(["git", "rev-parse", "--is-inside-work-tree"], repo_dir)
    if repo_check.returncode != 0:
        print(f"[git-auto-sync] Skip sync: not a git repository: {repo_dir}")
        return

    fetch_result = _run_git_command(["git", "fetch", REMOTE_REPO_URL], repo_dir)
    if fetch_result.returncode != 0:
        error_message = (fetch_result.stderr or fetch_result.stdout).strip()
        print(f"[git-auto-sync] git fetch failed: {error_message}")
        return

    diff_result = _run_git_command(["git", "diff", "--name-only", "HEAD", "FETCH_HEAD"], repo_dir)
    if diff_result.returncode != 0:
        error_message = (diff_result.stderr or diff_result.stdout).strip()
        print(f"[git-auto-sync] Failed to inspect remote changes: {error_message}")
        return

    changed_files = [line.strip() for line in diff_result.stdout.splitlines() if line.strip()]
    if not changed_files:
        return

    with tempfile.TemporaryDirectory(prefix="git-auto-sync-") as backup_root:
        preserved_dirs = _backup_preserved_directories(repo_dir, backup_root)

        reset_result = _run_git_command(["git", "reset", "--hard", "FETCH_HEAD"], repo_dir)
        if reset_result.returncode != 0:
            error_message = (reset_result.stderr or reset_result.stdout).strip()
            print(f"[git-auto-sync] git reset --hard FETCH_HEAD failed: {error_message}")
            print(f"[git-auto-sync] Changed remote files: {', '.join(changed_files)}")
            return

        clean_result = _run_git_command(["git", "clean", "-fd"], repo_dir)
        if clean_result.returncode != 0:
            error_message = (clean_result.stderr or clean_result.stdout).strip()
            print(f"[git-auto-sync] git clean -fd failed: {error_message}")
            print(f"[git-auto-sync] Changed remote files: {', '.join(changed_files)}")
            return

        _restore_preserved_directories(repo_dir, backup_root, preserved_dirs)

    print(f"[git-auto-sync] Force updated files: {', '.join(changed_files)}")
    if preserved_dirs:
        print(f"[git-auto-sync] Preserved directories: {', '.join(preserved_dirs)}")


async def start_git_auto_sync(app):
    if getattr(app.state, "git_auto_sync_completed", False):
        return

    repo_dir = str(Path(__file__).resolve().parent)
    await asyncio.to_thread(_sync_repository, repo_dir)
    app.state.git_auto_sync_completed = True
    print(f"[git-auto-sync] Startup sync completed for {REMOTE_REPO_URL}")


async def stop_git_auto_sync(app):
    return


if __name__ == "__main__":
    repo_dir = str(Path(__file__).resolve().parent)
    _sync_repository(repo_dir)
    print(f"[git-auto-sync] Manual sync completed for {REMOTE_REPO_URL}")
