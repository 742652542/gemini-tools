import base64
import glob
import json
import os
import queue
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

import httpx
import uvicorn
import boto3
from botocore.client import Config
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel


BASE_DIR = Path(__file__).resolve().parent
if os.name == "posix":
    TASK_ROOT = Path("/data/www/other/ipsite/cache") / "chatgpt_image_tasks"
else:
    TASK_ROOT = BASE_DIR / "chatgpt_image_tasks"
RUNNING_DIR = TASK_ROOT / "running"
RESULTS_DIR = TASK_ROOT / "results"
WAIT_DIR = TASK_ROOT / "waits"

for p in [RUNNING_DIR, RESULTS_DIR, WAIT_DIR]:
    p.mkdir(parents=True, exist_ok=True)


app = FastAPI(title="ChatGPT Image Task Server")

TASK_QUEUE: "queue.Queue[str]" = queue.Queue()
WORKER_THREADS = 100
DEBUG = True
CALLBACK_TIMEOUT = 4 * 60
DEFAULT_CALLBACK_URL = "https://ixspy.com/api/gemini/receive-result"
# DEFAULT_CALLBACK_URL = ""

# UPSTREAM_BASE_URL = "https://ent.univibe.cc/v1"
# UPSTREAM_API_KEY = "sk-JhlucoBFXUENDlVmCY0AqaWPDWt2389NWAsKM2PdxBiBpyuI"

# UPSTREAM_BASE_URL = "http://127.0.0.1:8080/v1"
# UPSTREAM_API_KEY = "sk-e0db58439e138c9a5c823c3d58ad80c0ca122b155e8607ad0cd2d40283639e2b"
# UPSTREAM_BASE_URL = "http://152.53.127.53:8080/v1"

UPSTREAM_BASE_URL = "http://192.168.7.163:8090/v1"
UPSTREAM_API_KEY = "sk-458e3b43a4d1fdd329951bb62d812c91aaf77e3b8bc262c051f177d3d6ebe5ef"

UPSTREAM_TIMEOUT = 3*60
UPSTREAM_RETRY_TIMES = 2
UPSTREAM_RETRY_INTERVAL = 1.5
RUNNING_COUNT = 0
RUNNING_LOCK = threading.Lock()

try:
    with open("config.json", "r", encoding="utf-8") as f:
        _config = json.load(f)
    _s3 = _config.get("s3", {})
    S3_ACCESS_KEY_ID = _s3.get("access_key_id")
    S3_SECRET_ACCESS_KEY = _s3.get("secret_access_key")
    S3_ENDPOINT_URL = _s3.get("endpoint_url")
    S3_BUCKET_NAME = _s3.get("bucket_name")
except Exception:
    S3_ACCESS_KEY_ID = None
    S3_SECRET_ACCESS_KEY = None
    S3_ENDPOINT_URL = None
    S3_BUCKET_NAME = None


class CreateTaskBody(BaseModel):
    action: str = "generate_image"
    prompt: str
    size: Optional[str] = None
    ratios: Optional[str] = "1:1"
    image: Optional[Any] = None
    output_format: str = "png"
    model: str = "gpt-image-2"
    callback_url: Optional[str] = None
    source: Optional[str] = "chatgpt_image"


class TaskRequest(BaseModel):
    action: str = "generate_image"
    prompt: str
    source: str = "gemini"
    model: str = "Pro"
    image: Optional[Any] = None
    client_id: Optional[str] = None
    url_id: Optional[str] = None
    callback_url: Optional[str] = None
    ratios: Optional[str] = "1:1"
    size: Optional[str] = None
    output_format: Optional[str] = "png"


def _task_file(directory: Path, task_id: str) -> Path:
    return directory / f"{task_id}.json"


def _debug_log(message: str) -> None:
    if DEBUG:
        print(message)


def _write_json(path: Path, data: Dict[str, Any]) -> None:
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _read_json(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def _clear_status_files(task_id: str) -> None:
    for d in [RUNNING_DIR]:
        p = _task_file(d, task_id)
        if p.exists():
            p.unlink(missing_ok=True)


def _dated_dir(base_dir: Path) -> Path:
    date_folder = time.strftime("%Y-%m-%d", time.localtime())
    target = base_dir / date_folder
    target.mkdir(parents=True, exist_ok=True)
    return target


def _find_file_path(base_dir: Path, task_id: str) -> Optional[Path]:
    target_filename = f"{task_id}.json"
    now = time.time()
    for i in range(2):
        day = time.strftime("%Y-%m-%d", time.localtime(now - i * 86400))
        p = base_dir / day / target_filename
        if p.exists():
            return p
    return None


def _save_queue_marker(task_payload: Dict[str, Any]) -> Path:
    timestamp = int(time.time() * 1000)
    task_id = task_payload["task_id"]
    marker = WAIT_DIR / f"{timestamp}_{task_id}.json"
    _write_json(marker, task_payload)
    return marker


def _queue_position(task_id: str) -> int:
    markers = sorted(WAIT_DIR.glob("*.json"), key=lambda p: p.name)
    target_suffix = f"_{task_id}.json"
    for idx, marker in enumerate(markers, start=1):
        if marker.name.endswith(target_suffix):
            return idx
    return 0


def _remove_queue_marker(task_id: str) -> None:
    for p in WAIT_DIR.glob(f"*_{task_id}.json"):
        for _ in range(5):
            try:
                p.unlink(missing_ok=True)
                break
            except PermissionError:
                time.sleep(0.1)
            except FileNotFoundError:
                break


def _remove_running_file(task_id: str) -> None:
    p = _task_file(RUNNING_DIR, task_id)
    for _ in range(5):
        try:
            p.unlink(missing_ok=True)
            break
        except PermissionError:
            time.sleep(0.1)
        except FileNotFoundError:
            break


def _waiting_count() -> int:
    return len(glob.glob(str(WAIT_DIR / "*.json")))


def _normalize_image_reference(image_input: Any) -> Optional[str]:
    if isinstance(image_input, list):
        for item in image_input:
            data = _normalize_image_reference(item)
            if data:
                return data
        return None

    if not isinstance(image_input, str):
        return None

    image_input = image_input.strip()
    if not image_input:
        return None

    if image_input.startswith("http://") or image_input.startswith("https://"):
        return image_input

    if image_input.startswith("data:"):
        return image_input

    try:
        image_data = base64.b64decode(image_input, validate=True)
    except Exception:
        return None

    return f"data:{_get_image_mime(image_data)};base64,{image_input}"


def _normalize_image_references(image_input: Any) -> list[str]:
    out: list[str] = []
    if isinstance(image_input, list):
        for item in image_input:
            data = _normalize_image_reference(item)
            if data:
                out.append(data)
        return out

    data = _normalize_image_reference(image_input)
    if data:
        out.append(data)
    return out


def _get_image_extension(image_data: bytes) -> str:
    if image_data.startswith(b"\xff\xd8"):
        return ".jpg"
    if image_data.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if image_data.startswith(b"GIF87a") or image_data.startswith(b"GIF89a"):
        return ".gif"
    if image_data.startswith(b"RIFF") and image_data[8:12] == b"WEBP":
        return ".webp"
    return ".png"


def _get_image_mime(image_data: bytes) -> str:
    ext = _get_image_extension(image_data)
    if ext == ".jpg":
        return "image/jpeg"
    if ext == ".gif":
        return "image/gif"
    if ext == ".webp":
        return "image/webp"
    return "image/png"


def _upload_to_s3(file_path: str, object_name: str) -> Optional[str]:
    if not all([S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_ENDPOINT_URL, S3_BUCKET_NAME]):
        return None

    s3_client = boto3.client(
        "s3",
        aws_access_key_id=S3_ACCESS_KEY_ID,
        aws_secret_access_key=S3_SECRET_ACCESS_KEY,
        endpoint_url=S3_ENDPOINT_URL,
        region_name="ap-southeast-1",
        verify=False,
        config=Config(s3={"addressing_style": "path"}),
    )
    try:
        s3_client.upload_file(file_path, S3_BUCKET_NAME, object_name)
        return f"https://d.ixspy.cn/{object_name}"
    except Exception:
        return None


def _resolve_size_by_ratios(ratios: Any) -> str:
    r = str(ratios or "").strip()
    if _is_dimension_size(r):
        return r

    size_map = {
        "1:1": "1024x1024",
        "2:3": "848x1264",
        "3:2": "1264x848",
        "3:4": "896x1200",
        "4:3": "1200x896",
        "4:5": "928x1152",
        "5:4": "1152x928",
        "9:16": "768x1376",
        "16:9": "1376x768",
        "21:9": "1584x672",
        "auto": "1024x1024",
        "自适应": "1024x1024",
    }
    return size_map.get(r, "1024x1024")


def _is_supported_size(size: str) -> bool:
    return _is_dimension_size(size) or size in {
        "1024x1024",
        "848x1264",
        "1264x848",
        "896x1200",
        "1200x896",
        "928x1152",
        "1152x928",
        "768x1376",
        "1376x768",
        "1584x672",
    }


def _is_dimension_size(size: str) -> bool:
    return bool(re.fullmatch(r"\d+x\d+", size))


def _sanitize_size(size: Any, ratios: Any) -> str:
    if isinstance(size, str) and size.strip() and _is_supported_size(size.strip()):
        return size.strip()
    return _resolve_size_by_ratios(ratios)


def _run_generate_image(task_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    if not UPSTREAM_BASE_URL or not UPSTREAM_API_KEY:
        return {"success": False, "error": "fallback 配置缺失"}

    size = _sanitize_size(payload.get("size"), payload.get("ratios", "1:1"))

    req_payload = {
        "model": "gpt-image-2",
        "prompt": payload.get("prompt") or "",
        "size": size,
        "output_format": payload.get("output_format") or "png",
    }

    headers = {"Authorization": f"Bearer {UPSTREAM_API_KEY}"}
    image_refs = _normalize_image_references(payload.get("image"))

    attempt = 0
    last_error: Dict[str, Any] = {"success": False, "error": "fallback 未知错误"}
    retryable_status_codes = {408, 429, 500, 502, 503, 504}

    def _log_upstream_response(resp: httpx.Response, body: Dict[str, Any], phase: str, mode: Optional[str] = None) -> None:
        request_id = resp.headers.get("x-request-id") or resp.headers.get("request-id") or ""
        mode_text = f" mode={mode}" if mode else ""
        err_obj = (body or {}).get("error") or {}
        err_type = err_obj.get("type") or ""
        err_msg = err_obj.get("message") or ""
        if isinstance(err_msg, str) and len(err_msg) > 120:
            err_msg = err_msg[:120] + "..."
        _debug_log(
            f"[upstream] phase={phase}{mode_text} task_id={task_id} attempt={attempt} "
            f"status_code={resp.status_code} request_id={request_id} error_type={err_type} error_msg={err_msg}"
        )

    while attempt <= UPSTREAM_RETRY_TIMES:
        attempt += 1
        try:
            with httpx.Client(timeout=UPSTREAM_TIMEOUT) as client:
                if image_refs:
                    edit_headers = dict(headers)
                    edit_headers["Content-Type"] = "application/json"
                    edit_payload = {
                        "model": req_payload["model"],
                        "prompt": req_payload["prompt"],
                        "size": req_payload["size"],
                        "output_format": req_payload["output_format"],
                        "response_format": "b64_json",
                        "images": [{"image_url": image_ref} for image_ref in image_refs],
                    }
                    resp = client.post(f"{UPSTREAM_BASE_URL}/images/edits", json=edit_payload, headers=edit_headers)
                    try:
                        body = resp.json()
                    except Exception:
                        body = {"raw_text": resp.text}
                    _log_upstream_response(resp, body, "images.edits", "image_url")

                    if resp.status_code // 100 != 2:
                        err_type = (((body or {}).get("error") or {}).get("type") or "").strip()
                        custom_error = "fallback 接口返回异常"
                        if resp.status_code == 502 and err_type == "upstream_error":
                            custom_error = "show-提示词限制或者触发品牌保护。"
                        last_error = {
                            "success": False,
                            "error": custom_error,
                            "attempt": attempt,
                            "image_upload_mode": "image_url",
                            "image_count": len(image_refs),
                            "status_code": resp.status_code,
                            "raw": body,
                        }
                        should_retry = resp.status_code in retryable_status_codes and err_type != "upstream_error"
                        if should_retry and attempt <= UPSTREAM_RETRY_TIMES:
                            time.sleep(UPSTREAM_RETRY_INTERVAL)
                            continue
                        return last_error

                    b64 = (((body or {}).get("data") or [{}])[0] or {}).get("b64_json", "")
                    if isinstance(b64, str) and b64:
                        return {
                            "success": True,
                            "b64_json": b64,
                            "raw": body,
                            "image_upload_mode": "image_url",
                            "image_count": len(image_refs),
                        }

                    last_error = {
                        "success": False,
                        "error": "fallback 接口未返回图片数据",
                        "attempt": attempt,
                        "image_upload_mode": "image_url",
                        "image_count": len(image_refs),
                        "raw": body,
                    }
                    if attempt <= UPSTREAM_RETRY_TIMES:
                        time.sleep(UPSTREAM_RETRY_INTERVAL)
                        continue
                    return last_error

                generation_headers = dict(headers)
                generation_headers["Content-Type"] = "application/json"
                resp = client.post(f"{UPSTREAM_BASE_URL}/images/generations", json=req_payload, headers=generation_headers)

            try:
                body = resp.json()
            except Exception:
                body = {"raw_text": resp.text}
            _log_upstream_response(resp, body, "images.generations")

            if resp.status_code // 100 != 2:
                err_type = (((body or {}).get("error") or {}).get("type") or "").strip()
                custom_error = "fallback 接口返回异常"
                if resp.status_code == 502 and err_type == "upstream_error":
                    custom_error = "show-提示词限制或者触发品牌保护。"
                last_error = {
                    "success": False,
                    "error": custom_error,
                    "attempt": attempt,
                    "status_code": resp.status_code,
                    "raw": body,
                }
                should_retry = resp.status_code in retryable_status_codes and err_type != "upstream_error"
                if should_retry and attempt <= UPSTREAM_RETRY_TIMES:
                    time.sleep(UPSTREAM_RETRY_INTERVAL)
                    continue
                return last_error

            b64 = (((body or {}).get("data") or [{}])[0] or {}).get("b64_json", "")
            if not isinstance(b64, str) or not b64:
                last_error = {
                    "success": False,
                    "error": "fallback 接口未返回图片数据",
                    "attempt": attempt,
                    "raw": body,
                }
                if attempt <= UPSTREAM_RETRY_TIMES:
                    time.sleep(UPSTREAM_RETRY_INTERVAL)
                    continue
                return last_error

            return {"success": True, "b64_json": b64, "raw": body}
        except Exception as exc:
            last_error = {
                "success": False,
                "error": "fallback 请求异常",
                "attempt": attempt,
                "exception": str(exc),
            }
            if attempt <= UPSTREAM_RETRY_TIMES:
                time.sleep(UPSTREAM_RETRY_INTERVAL)
                continue
            return last_error

    return last_error


def _push_callback(task_id: str, final_data: Dict[str, Any], callback_url: str) -> None:
    if not callback_url:
        return

    callback_payload = _build_completed_response(final_data)
    try:
        _debug_log(f"[callback] task_id={task_id} url={callback_url} payload={json.dumps(callback_payload, ensure_ascii=False)}")
        with httpx.Client(timeout=CALLBACK_TIMEOUT) as client:
            resp = client.post(callback_url, json=callback_payload)
            _debug_log(
                f"[callback] task_id={task_id} url={callback_url} "
                f"status_code={resp.status_code} body={resp.text}"
            )
    except Exception as exc:
        _debug_log(f"[callback] task_id={task_id} url={callback_url} exception={str(exc)}")


def _build_success_result(task_id: str, payload: Dict[str, Any], file_data: Dict[str, Any]) -> Dict[str, Any]:
    cdn_url = file_data.get("cdn_url")
    data_list = [cdn_url] if cdn_url else []
    return {
        "status": "success",
        "task_id": task_id,
        "action": "generate_image",
        "data": data_list,
        "url_id": payload.get("url_id"),
        "client_id": payload.get("client_id"),
        "updated_at": int(time.time()),
    }


def _build_error_result(task_id: str, payload: Dict[str, Any], result: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "status": "error",
        "task_id": task_id,
        "action": "generate_image",
        "data": "",
        "error": result.get("error") or "任务失败",
        "message": result.get("message"),
        "url_id": payload.get("url_id"),
        "client_id": payload.get("client_id"),
    }


def _build_completed_response(result_data: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "status": "completed",
        "result": result_data,
    }


def _save_task_result(task_id: str, result: Dict[str, Any]) -> None:
    target_dir = _dated_dir(RESULTS_DIR)
    _write_json(target_dir / f"{task_id}.json", result)


def _save_task_file_from_result(task_id: str, payload: Dict[str, Any], result: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if not result.get("success"):
        return None
    b64 = result.get("b64_json")
    if not isinstance(b64, str) or not b64:
        return None

    try:
        image_data = base64.b64decode(b64)
    except Exception:
        return None

    date_folder = time.strftime("%Y-%m-%d", time.localtime())
    ext = _get_image_extension(image_data)
    temp_path = str(TASK_ROOT / f"tmp_{task_id}{ext}")

    try:
        with open(temp_path, "wb") as f:
            f.write(image_data)

        object_name = f"ai/img/task_results/{date_folder}/{task_id}{str(time.time())}{ext}"
        cdn_url = _upload_to_s3(temp_path, object_name)

        return {
            "task_id": task_id,
            "action": payload.get("action", "generate_image"),
            "source": payload.get("source", "chatgpt_image"),
            "status": "success" if cdn_url else "error",
            "cdn_url": cdn_url,
            "file_type": "cdn_url" if cdn_url else "none",
            "updated_at": int(time.time()),
        }
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)

    return None


def _worker_loop(worker_name: str) -> None:
    while True:
        task_id = TASK_QUEUE.get()
        global RUNNING_COUNT
        payload: Dict[str, Any] = {}
        try:
            payload_path = _task_file(RUNNING_DIR, task_id)
            if not payload_path.exists():
                continue

            payload = _read_json(payload_path)
            _remove_queue_marker(task_id)
            with RUNNING_LOCK:
                RUNNING_COUNT += 1
            payload["status"] = "running"
            payload["worker"] = worker_name
            payload["updated_at"] = int(time.time())
            _write_json(_task_file(RUNNING_DIR, task_id), payload)

            action = payload.get("action", "generate_image")
            if action != "generate_image":
                result = {"success": False, "error": f"unsupported action: {action}"}
            else:
                result = _run_generate_image(task_id, payload)

            file_data = _save_task_file_from_result(task_id, payload, result)
            if result.get("success") and file_data and file_data.get("cdn_url"):
                final_data = _build_success_result(task_id, payload, file_data)
            elif result.get("success"):
                final_data = _build_error_result(task_id, payload, {"error": "图片上传失败"})
            else:
                final_data = _build_error_result(task_id, payload, result)

            _save_task_result(task_id, final_data)
            _remove_running_file(task_id)
            callback_url = (payload.get("callback_url") or "").strip() or DEFAULT_CALLBACK_URL
            if callback_url:
                threading.Thread(
                    target=_push_callback,
                    args=(task_id, final_data, callback_url),
                    daemon=True,
                ).start()
        except Exception as exc:
            _remove_running_file(task_id)
            failed_result = {"success": False, "error": str(exc)}
            failed_data = _build_error_result(task_id, payload, failed_result)
            try:
                _save_task_result(task_id, failed_data)
            except Exception:
                pass
            try:
                callback_url = (payload.get("callback_url") or "").strip() or DEFAULT_CALLBACK_URL
                if callback_url:
                    threading.Thread(
                        target=_push_callback,
                        args=(task_id, failed_data, callback_url),
                        daemon=True,
                    ).start()
            except Exception:
                pass
        finally:
            _remove_running_file(task_id)
            with RUNNING_LOCK:
                if RUNNING_COUNT > 0:
                    RUNNING_COUNT -= 1
            TASK_QUEUE.task_done()


@app.on_event("startup")
def _startup() -> None:
    for idx in range(WORKER_THREADS):
        t = threading.Thread(target=_worker_loop, args=(f"worker-{idx + 1}",), daemon=True)
        t.start()


@app.post("/tasks")
def create_task(body: CreateTaskBody) -> Dict[str, Any]:
    if not body.prompt or not body.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt 不能为空")

    if (body.action or "generate_image") != "generate_image":
        raise HTTPException(status_code=400, detail="只支持 generate_image")

    task_id = f"img_{uuid.uuid4().hex[:16]}"
    payload = body.dict()
    payload["task_id"] = task_id
    payload["created_at"] = int(time.time())
    payload["status"] = "queued"
    payload["updated_at"] = int(time.time())

    _clear_status_files(task_id)
    _write_json(_task_file(RUNNING_DIR, task_id), payload)

    TASK_QUEUE.put(task_id)
    _save_queue_marker(payload)
    return {
        "status": "queued",
        "message": "任务已排队",
        "task_id": task_id,
        "waiting_count": TASK_QUEUE.qsize(),
        "query_url": f"/tasks/{task_id}",
    }


@app.get("/tasks/{task_id}")
def get_task_status(task_id: str) -> Dict[str, Any]:
    running_path = _task_file(RUNNING_DIR, task_id)
    if running_path.exists():
        return {"status": "processing", "result": _read_json(running_path)}

    result_path = _find_file_path(RESULTS_DIR, task_id)
    if result_path:
        data = _read_json(result_path)
        return {"status": "completed", "result": data}

    queue_files = glob.glob(str(WAIT_DIR / f"*_{task_id}.json"))
    if queue_files or _task_file(RUNNING_DIR, task_id).exists():
        return {"status": "processing", "message": "任务处理中"}

    return {
        "status": "error",
        "message": "任务不存在",
        "task_id": task_id,
        "result": None,
    }


@app.post("/api/ask")
async def send_task(request: TaskRequest) -> Dict[str, Any]:
    action = request.action or "generate_image"
    model = request.model or "Pro"
    is_continue = bool(request.client_id)
    prompt = (request.prompt or "").strip()

    if action != "generate_image":
        return {"status": "error", "message": "无效的操作"}
    if not prompt:
        return {"status": "error", "message": "prompt 不能为空"}

    task_id = f"task_{uuid.uuid4().hex[:8]}"
    task_payload: Dict[str, Any] = {
        "action": action,
        "is_continue": is_continue,
        "status": "queued",
        "task_id": task_id,
        "model": model,
        "prompt": prompt,
        "source": request.source,
        "client_id": request.client_id,
        "url_id": request.url_id,
        "image": request.image,
        "callback_url": request.callback_url,
        "ratios": request.ratios,
        "size": request.size,
        "output_format": request.output_format or "png",
        "updated_at": int(time.time()),
    }

    _clear_status_files(task_id)
    _write_json(_task_file(RUNNING_DIR, task_id), task_payload)

    TASK_QUEUE.put(task_id)
    _save_queue_marker(task_payload)

    with RUNNING_LOCK:
        running_count = RUNNING_COUNT
    queue_size = TASK_QUEUE.qsize()

    if running_count < WORKER_THREADS and queue_size <= 1:
        return {
            "status": "processing",
            "message": "任务已发送给客户端",
            "task_id": task_id,
            "queue_position": 0,
        }

    queue_position = _queue_position(task_id)
    return {
        "status": "queued",
        "message": "任务已排队",
        "task_id": task_id,
        "queue_position": queue_position,
        "waiting_count": _waiting_count(),
        "query_url": f"/api/result/{task_id}",
    }


@app.get("/api/result/{task_id}")
async def get_task_result(task_id: str) -> Dict[str, Any]:
    file_path = _find_file_path(RESULTS_DIR, task_id)
    if file_path:
        try:
            result_data = _read_json(file_path)
            response = _build_completed_response(result_data)
            _debug_log(f"[/api/result] task_id={task_id} response={json.dumps(response, ensure_ascii=False)}")
            return response
        except Exception:
            response = {"status": "error", "message": "读取失败"}
            _debug_log(f"[/api/result] task_id={task_id} response={json.dumps(response, ensure_ascii=False)}")
            return response

    queue_files = glob.glob(str(WAIT_DIR / f"*_{task_id}.json"))
    if queue_files or _task_file(RUNNING_DIR, task_id).exists():
        response = {"status": "processing", "message": "任务处理中"}
        _debug_log(f"[/api/result] task_id={task_id} response={json.dumps(response, ensure_ascii=False)}")
        return response

    response = {"status": "processing", "message": "任务处理中或不存在"}
    _debug_log(f"[/api/result] task_id={task_id} response={json.dumps(response, ensure_ascii=False)}")
    return response


@app.get("/api/files/{task_id}")
async def get_task_files(task_id: str) -> Dict[str, Any]:
    file_path = _find_file_path(RESULTS_DIR, task_id)
    if file_path:
        try:
            result_data = _read_json(file_path)
            if result_data.get("status") == "success" and isinstance(result_data.get("data"), list) and result_data.get("data"):
                return {
                    "status": "completed",
                    "result": {
                        "type": "download_complete",
                        "task_id": task_id,
                        "cdn_url": result_data.get("data")[0],
                        "file_type": "cdn_url",
                        "updated_at": result_data.get("updated_at"),
                    },
                }
            return {"status": "failed", "result": result_data}
        except Exception as exc:
            return {"status": "error", "message": f"读取失败: {str(exc)}"}

    queue_files = glob.glob(str(WAIT_DIR / f"*_{task_id}.json"))
    if queue_files:
        return {"status": "processing", "message": "文件处理中"}

    return {"status": "processing", "message": "文件生成中或不存在"}


@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "success": True,
        "workers": WORKER_THREADS,
        "queued": TASK_QUEUE.qsize(),
    }


if __name__ == "__main__":
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "9092"))
    uvicorn.run(app, host=host, port=port)
