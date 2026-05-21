import base64
import glob
import json
import os
import queue
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

import boto3
import httpx
import uvicorn
from botocore.client import Config
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel


ALLOWED_MODELS = {"gemini-3.1-flash-image", "gemini-3-pro-image"}

BASE_DIR = Path(__file__).resolve().parent
if os.name == "posix":
    TASK_ROOT = Path("/data/www/other/ipsite/cache") / "antigravity_image_tasks"
else:
    TASK_ROOT = BASE_DIR / "antigravity_image_tasks"
RUNNING_DIR = TASK_ROOT / "running"
RESULTS_DIR = TASK_ROOT / "results"
WAIT_DIR = TASK_ROOT / "waits"

for p in [RUNNING_DIR, RESULTS_DIR, WAIT_DIR]:
    p.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Antigravity Image Task Server")
TASK_QUEUE: "queue.Queue[str]" = queue.Queue()
WORKER_THREADS = 100
DEBUG = True
CALLBACK_TIMEOUT = 4 * 60
DEFAULT_CALLBACK_URL = "https://ixspy.com/api/gemini/receive-result"
# UPSTREAM_BASE_URL = "http://127.0.0.1:8080/antigravity/v1beta"
# UPSTREAM_API_KEY = ""
UPSTREAM_BASE_URL = "http://192.168.7.163:8090/antigravity/v1beta"
UPSTREAM_API_KEY = "sk-be3af4852f81204bebe5ba5fa319b9a6d372466a788d876e14170786677a0527"

UPSTREAM_TIMEOUT = 3 * 60
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
    model: str = "gemini-3.1-flash-image"
    callback_url: Optional[str] = None
    source: Optional[str] = "antigravity_image"


class TaskRequest(BaseModel):
    action: str = "generate_image"
    prompt: str
    source: str = "gemini"
    model: str = "gemini-3.1-flash-image"
    image: Optional[Any] = None
    client_id: Optional[str] = None
    url_id: Optional[str] = None
    callback_url: Optional[str] = None
    ratios: Optional[str] = "1:1"
    size: Optional[str] = None
    output_format: Optional[str] = "png"


def _validate_model(model: Any) -> str:
    value = str(model or "gemini-3.1-flash-image").strip()
    if value not in ALLOWED_MODELS:
        raise ValueError(f"unsupported model: {value}")
    return value


def _sanitize_image_size(size: Any) -> str:
    value = str(size or "").strip().upper()
    if value in {"1K", "2K", "4K"}:
        return value
    return "2K"


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


def _normalize_image_bytes(image_input: Any) -> Optional[bytes]:
    if isinstance(image_input, list):
        for item in image_input:
            data = _normalize_image_bytes(item)
            if data:
                return data
        return None
    if not isinstance(image_input, str):
        return None
    image_input = image_input.strip()
    if not image_input:
        return None
    if image_input.startswith("data:") and "," in image_input:
        image_input = image_input.split(",", 1)[1]
    if image_input.startswith("http://") or image_input.startswith("https://"):
        with httpx.Client(timeout=60) as client:
            resp = client.get(image_input)
            if resp.status_code // 100 != 2:
                return None
            return resp.content
    try:
        return base64.b64decode(image_input, validate=True)
    except Exception:
        return None


def _normalize_images_bytes(image_input: Any) -> list[bytes]:
    out: list[bytes] = []
    if isinstance(image_input, list):
        for item in image_input:
            data = _normalize_image_bytes(item)
            if data:
                out.append(data)
        return out
    data = _normalize_image_bytes(image_input)
    if data:
        out.append(data)
    return out


def _sanitize_aspect_ratio(ratios: Any) -> str:
    value = str(ratios or "").strip()
    return value or "1:1"


def _build_gemini_request(payload: Dict[str, Any]) -> Dict[str, Any]:
    parts = [{"text": (payload.get("prompt") or "").strip()}]
    for image_bytes in _normalize_images_bytes(payload.get("image")):
        parts.append(
            {
                "inlineData": {
                    "mimeType": _get_image_mime(image_bytes),
                    "data": base64.b64encode(image_bytes).decode("ascii"),
                }
            }
        )
    return {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "responseModalities": ["TEXT", "IMAGE"],
            "imageConfig": {
                "aspectRatio": _sanitize_aspect_ratio(payload.get("ratios")),
                "imageSize": _sanitize_image_size(payload.get("size")),
            },
        },
    }


def _extract_gemini_image(body: Dict[str, Any]) -> tuple[bytes, str]:
    if isinstance(body, dict) and isinstance(body.get("response"), dict):
        body = body["response"]
    candidates = body.get("candidates") or []
    for candidate in candidates:
        content = candidate.get("content") or {}
        parts = content.get("parts") or []
        for part in parts:
            inline_data = part.get("inlineData") or {}
            data = inline_data.get("data")
            mime_type = inline_data.get("mimeType") or "image/png"
            if isinstance(data, str) and data.strip():
                try:
                    return base64.b64decode(data), mime_type
                except Exception as exc:
                    raise ValueError(f"failed to decode Gemini image: {exc}") from exc
    raise ValueError("no image output returned by Gemini")


def _iter_sse_payloads(raw_text: str) -> list[Dict[str, Any]]:
    payloads: list[Dict[str, Any]] = []
    for line in raw_text.splitlines():
        line = line.strip()
        if not line or not line.startswith("data:"):
            continue
        json_str = line[5:].strip()
        if not json_str or json_str == "[DONE]" or not json_str.startswith("{"):
            continue
        try:
            payload = json.loads(json_str)
        except Exception:
            continue
        payloads.append(payload)
    return payloads


def _build_upstream_url(model: str) -> str:
    return f"{UPSTREAM_BASE_URL}/models/{model}:streamGenerateContent?alt=sse"


def _build_generation_result(body: Any) -> Dict[str, Any]:
    candidates_to_try: list[Dict[str, Any]] = []
    if isinstance(body, str):
        candidates_to_try.extend(_iter_sse_payloads(body))
    elif isinstance(body, dict):
        candidates_to_try.append(body)

    last_error: Optional[Exception] = None
    for candidate_body in candidates_to_try:
        try:
            image_data, mime_type = _extract_gemini_image(candidate_body)
            return {
                "success": True,
                "mime_type": mime_type,
                "b64_json": base64.b64encode(image_data).decode("ascii"),
                "raw": body,
            }
        except ValueError as exc:
            last_error = exc

    if last_error is not None:
        raise last_error

    raise ValueError("no image output returned by Gemini")


def _run_generate_image(task_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    model = _validate_model(payload.get("model"))
    request_body = _build_gemini_request(payload)
    headers = {
        "Authorization": f"Bearer {UPSTREAM_API_KEY}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    }
    url = _build_upstream_url(model)
    attempt = 0
    last_error: Dict[str, Any] = {"success": False, "error": "gemini upstream unknown error"}
    retryable_status_codes = {408, 429, 500, 502, 503, 504}

    while attempt <= UPSTREAM_RETRY_TIMES:
        attempt += 1
        try:
            with httpx.Client(timeout=UPSTREAM_TIMEOUT) as client:
                resp = client.post(url, json=request_body, headers=headers)
            raw_text = resp.text
            if resp.status_code // 100 != 2:
                last_error = {
                    "success": False,
                    "error": "gemini upstream returned error",
                    "attempt": attempt,
                    "status_code": resp.status_code,
                    "raw": raw_text,
                }
                if resp.status_code in retryable_status_codes and attempt <= UPSTREAM_RETRY_TIMES:
                    time.sleep(UPSTREAM_RETRY_INTERVAL)
                    continue
                return last_error
            return _build_generation_result(raw_text)
        except Exception as exc:
            last_error = {
                "success": False,
                "error": "gemini upstream request failed",
                "attempt": attempt,
                "exception": str(exc),
            }
            if attempt <= UPSTREAM_RETRY_TIMES:
                time.sleep(UPSTREAM_RETRY_INTERVAL)
                continue
            return last_error
    return last_error


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
    p = _task_file(RUNNING_DIR, task_id)
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


def _build_completed_response(result_data: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "status": "completed",
        "result": result_data,
    }


def _push_callback(task_id: str, final_data: Dict[str, Any], callback_url: str) -> None:
    if not callback_url:
        return

    callback_payload = _build_completed_response(final_data)
    try:
        _debug_log(f"[callback] task_id={task_id} url={callback_url} payload={json.dumps(callback_payload, ensure_ascii=False)}")
        with httpx.Client(timeout=CALLBACK_TIMEOUT) as client:
            resp = client.post(callback_url, json=callback_payload)
            _debug_log(
                f"[callback] task_id={task_id} url={callback_url} status_code={resp.status_code} body={resp.text}"
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
            "source": payload.get("source", "antigravity_image"),
            "status": "success" if cdn_url else "error",
            "cdn_url": cdn_url,
            "file_type": "cdn_url" if cdn_url else "none",
            "updated_at": int(time.time()),
        }
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)


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
    try:
        payload["model"] = _validate_model(body.model)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
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
    is_continue = bool(request.client_id)
    prompt = (request.prompt or "").strip()

    if action != "generate_image":
        return {"status": "error", "message": "无效的操作"}
    if not prompt:
        return {"status": "error", "message": "prompt 不能为空"}

    try:
        model = _validate_model(request.model)
    except ValueError as exc:
        return {"status": "error", "message": str(exc)}

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
    port = int(os.getenv("PORT", "9093"))
    uvicorn.run(app, host=host, port=port)
