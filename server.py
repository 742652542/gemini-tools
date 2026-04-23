from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
import base64
from typing import Dict, Optional
import uvicorn
import json
import random
import uuid
import os
import time
import glob
from datetime import datetime, timedelta
import subprocess
from collections import deque
import asyncio
import httpx
import boto3
from botocore.client import Config
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.requests import Request

# pip install fastapi uvicorn pydantic httpx boto3
# pip install "uvicorn[standard]" fastapi

# Load S3 configuration
try:
    with open('config.json') as f:
        config = json.load(f)
    s3_config = config.get('s3', {})
    S3_ACCESS_KEY_ID = s3_config.get('access_key_id')
    S3_SECRET_ACCESS_KEY = s3_config.get('secret_access_key')
    S3_ENDPOINT_URL = s3_config.get('endpoint_url')
    S3_BUCKET_NAME = s3_config.get('bucket_name')
except (FileNotFoundError, json.JSONDecodeError) as e:
    print(f"Error loading S3 configuration: {e}")
    # Set to None so we can handle it gracefully
    S3_ACCESS_KEY_ID = S3_SECRET_ACCESS_KEY = S3_ENDPOINT_URL = S3_BUCKET_NAME = None

app = FastAPI()
DEBUG = False
@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    # 获取原始请求体
    body = await request.body()
    print("--- 422 Validation Error ---")
    print(f"Errors: {exc.errors()}")
    print(f"Raw Body: {body.decode()}")
    print("---------------------------")
    return JSONResponse(
        status_code=422,
        content={"detail": exc.errors(), "body": body.decode()},
    )

# === 配置：路径 ===
RESULTS_DIR = "task_results"
FILES_DIR = "task_files"
WAIT_DIR = "task_wait"  # 排队任务保持扁平结构，方便排序

for directory in [RESULTS_DIR, FILES_DIR, WAIT_DIR]:
    if not os.path.exists(directory):
        os.makedirs(directory)

# === 请求体模型 ===
class TaskRequest(BaseModel):
    action: str
    prompt: str
    source: str = "gemini"
    model: str
    image: Optional[object] = None
    client_id: Optional[str] = None

# === [新增] 辅助函数：跨日期文件夹查找文件 ===
def find_file_path(base_dir: str, task_id: str) -> Optional[str]:
    """
    在 base_dir 中查找 {task_id}.json
    策略：只检查【今天】和【昨天】的文件夹，提升性能
    """
    target_filename = f"{task_id}.json"
    
    # 获取当前时间对象
    now = datetime.now()
    
    # 生成待检查的日期列表：[今天, 昨天]
    # 如果你想查近3天，就在 range(2) 改成 range(3)
    check_dates = []
    for i in range(2): 
        date_str = (now - timedelta(days=i)).strftime("%Y-%m-%d")
        check_dates.append(date_str)
    
    # 遍历检查
    for date_folder in check_dates:
        full_path = os.path.join(base_dir, date_folder, target_filename)
        # 只要找到一个存在的，立即返回
        if os.path.exists(full_path):
            return full_path

    # 如果这两天都没找到
    return None

def get_image_extension(image_data: bytes) -> str:
    """根据图片二进制数据的头部特征（魔数）判断图片格式，并返回相应的扩展名"""
    if image_data.startswith(b'\xff\xd8'):
        return '.jpg'
    elif image_data.startswith(b'\x89PNG\r\n\x1a\n'):
        return '.png'
    elif image_data.startswith(b'GIF87a') or image_data.startswith(b'GIF89a'):
        return '.gif'
    elif image_data.startswith(b'RIFF') and image_data[8:12] == b'WEBP':
        return '.webp'
    return '.png'  # 默认降级为 png

def upload_to_s3(file_path: str, object_name: str) -> Optional[str]:
    """Upload a file to an S3 bucket and return the public URL."""
    if not all([S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_ENDPOINT_URL, S3_BUCKET_NAME]):
        print("S3 credentials are not configured. Skipping upload.")
        return None

    s3_client = boto3.client(
        's3',
        aws_access_key_id=S3_ACCESS_KEY_ID,
        aws_secret_access_key=S3_SECRET_ACCESS_KEY,
        endpoint_url=S3_ENDPOINT_URL,
        region_name='ap-southeast-1',
        verify=False, 
        config=Config(s3={'addressing_style': 'path'})
    )
    try:
        s3_client.upload_file(file_path, S3_BUCKET_NAME, object_name)
        # Construct the public URL
        public_url = f"https://d.ixspy.cn/{object_name}"
        print(f"Successfully uploaded {object_name} to {public_url}")
        return public_url
    except Exception as e:
        print(f"Error uploading to S3: {e}")
        return None

# === 连接与状态管理器 ===
class ConnectionManager:
    def __init__(self):
        # 存储 客户端ID -> WebSocket 对象
        self.active_connections: Dict[str, WebSocket] = {}
        # 核心：使用双端队列维护“空闲”客户端的顺序
        self.idle_queue = deque()
        # 记录哪些客户端正在忙碌，防止重复入队
        self.busy_clients = set()

    async def connect(self, websocket: WebSocket, client_id: str):
        await websocket.accept()
        self.active_connections[client_id] = websocket
        # 新上线且不在忙碌列表中的，加入空闲队列尾部
        if client_id not in self.busy_clients and client_id not in self.idle_queue:
            self.idle_queue.append(client_id)
        
        print(f"Client connected: {client_id} | Current idle queue: {list(self.idle_queue)}")
        await check_and_dispatch_task(client_id)

    def disconnect(self, client_id: str):
        if client_id in self.active_connections:
            del self.active_connections[client_id]
        # 从空闲队列中移除
        if client_id in self.idle_queue:
            self.idle_queue.remove(client_id)
        # 从忙碌集合中移除
        if client_id in self.busy_clients:
            self.busy_clients.remove(client_id)
        print(f"Client disconnected: {client_id}")

    def get_idle_client(self, specific_client_id: Optional[str] = None) -> Optional[str]:
        """
        根据轮询逻辑获取客户端
        """
        # 如果指定了 ID
        if specific_client_id:
            if specific_client_id in self.idle_queue:
                self.idle_queue.remove(specific_client_id)
                return specific_client_id
            return None 
        
        # 轮询逻辑：弹出队列第一个
        if self.idle_queue:
            return self.idle_queue.popleft()
        return None

    def mark_busy(self, client_id: str):
        self.busy_clients.add(client_id)
        # 确保它不在空闲队列中
        if client_id in self.idle_queue:
            self.idle_queue.remove(client_id)

    def mark_idle(self, client_id: str):
        """
        任务完成，回到队列尾部，等待下次轮班
        """
        if client_id in self.busy_clients:
            self.busy_clients.remove(client_id)
        
        if client_id in self.active_connections and client_id not in self.idle_queue:
            self.idle_queue.append(client_id)
            print(f"Client {client_id} is idle, returning to the end of the polling queue")

    async def send_task_payload(self, message: dict, client_id: str):
        if client_id in self.active_connections:
            ws = self.active_connections[client_id]
            try:
                # 在发送前标记忙碌（get_idle_client 已经 pop 出来了，这里双重保险）
                self.mark_busy(client_id)
                await ws.send_text(json.dumps(message))
                return True
            except Exception as e:
                print(f"Failed to send message: {e}")
                self.disconnect(client_id)
                return False
        return False

manager = ConnectionManager()

# === 辅助函数：排队逻辑 (Wait 目录保持不变) ===
def get_waiting_count():
    return len(glob.glob(os.path.join(WAIT_DIR, "*.json")))

def save_to_queue(task_payload: dict):
    timestamp = int(time.time() * 1000)
    task_id = task_payload['task_id']
    file_path = os.path.join(WAIT_DIR, f"{timestamp}_{task_id}.json")
    try:
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(task_payload, f, ensure_ascii=False, indent=2)
        print(f"Task [{task_id}] added to queue, current queue size: {get_waiting_count()}")
        return True
    except Exception as e:
        print(f"Failed to write to queue: {e}")
        return False

def pop_next_task():
    files = sorted(glob.glob(os.path.join(WAIT_DIR, "*.json")))
    if not files:
        return None
    oldest_file = files[0]
    try:
        with open(oldest_file, "r", encoding="utf-8") as f:
            task_data = json.load(f)
        os.remove(oldest_file)
        return task_data
    except Exception as e:
        print(f"Failed to read queue file: {e}")
        return None

async def check_and_dispatch_task(client_id: str):
    # 只有当该客户端确实在“空闲队列”里时，才触发自动调度
    if client_id not in manager.idle_queue:
        return
        
    next_task = pop_next_task()
    if next_task:
        # 因为 get_idle_client 会 pop 元素，这里我们手动从队列移除
        if client_id in manager.idle_queue:
            manager.idle_queue.remove(client_id)
            
        print(f"Circular dispatch: Sending queued task [{next_task['task_id']}] to -> {client_id}")
        success = await manager.send_task_payload(next_task, client_id)
        if not success:
            print(f"Send failed, task [{next_task['task_id']}] re-queued")
            save_to_queue(next_task)
            # 发送失败的话，disconnect 会处理清理工作

# === [新增] 辅助函数：异步推送结果到 webhook ===
async def push_result_to_ixspy(task_id: str, result_data: dict):
    """
    当任务完成后，将最终结果以与 /api/result/{task_id} 相同的格式
    推送到指定的 webhook 地址。
    """
    if DEBUG:
        return
    
    url = "https://ixspy.com/api/gemini/receive-result"
    
    # 构造与 get_task_result 相同的返回结构
    payload = {
        "status": "completed",
        "result": result_data
    }
    # print(payload)
    try:
        async with httpx.AsyncClient() as client:
            # 发送 POST 请求
            response = await client.post(url, json=payload, timeout=30.0)
            # print(response.text)
            # 检查响应状态
            if response.status_code == 200:
                print(f"Successfully pushed result to {url} (Task ID: {task_id})")
            else:
                print(f"Push to {url} failed (Task ID: {task_id}). Status code: {response.status_code}. Response: {response.text}")

    except httpx.HTTPError as e:
        print(f"Push to {url} request exception (Task ID: {task_id}): {e}")
    except Exception as e:
        print(f"Unknown error during push (Task ID: {task_id}): {e}")


# === [修改] 辅助函数：按日期保存结果 ===
def save_task_result(task_id: str, client_id: str, data: dict):
    # 获取任务 action
    action = data.get("action", "generate_image") # 默认为图片，兼容旧代码
    
    # 确定最终 JSON 存放目录
    date_folder = datetime.now().strftime("%Y-%m-%d")
    target_dir = os.path.join(RESULTS_DIR, date_folder)
    os.makedirs(target_dir, exist_ok=True)
    
    # 1. 预处理水印和上传：只有图片任务才处理
    if action == "generate_image" and data.get("status") == "success" and "data" in data:
        raw_images = data["data"]
        cdn_urls = []

        if isinstance(raw_images, list):
            # 建立任务专用的临时图片目录
            temp_img_dir = os.path.join(target_dir, "temp_imgs", task_id)
            os.makedirs(temp_img_dir, exist_ok=True)

            print(f"Processing images and uploading for task {task_id}")

            for idx, img_b64 in enumerate(raw_images):
                temp_file_path = None
                try:
                    # A. Base64 解码
                    if "," in img_b64:
                        img_b64 = img_b64.split(",")[1]
                    image_data = base64.b64decode(img_b64)
                    
                    # 动态获取扩展名
                    ext = get_image_extension(image_data)
                    temp_file_path = os.path.join(temp_img_dir, f"{str(idx)}{ext}")
                    
                    # 保存为文件
                    with open(temp_file_path, "wb") as f:
                        f.write(image_data)

                    # B. 调用水印工具
                    subprocess.run(f'GeminiWatermarkTool "{temp_file_path}"', shell=True, check=True)
                    
                    # C. 上传到 S3
                    object_name = f"ai/img/task_results/{date_folder}/{task_id+str(datetime.now().timestamp())}{ext}"
                    cdn_url = upload_to_s3(temp_file_path, object_name)
                    if cdn_url:
                        cdn_urls.append(cdn_url)
                        print(f"Image {task_id+str(idx)} processed and uploaded successfully.")
                    else:
                        print(f"Image {task_id+str(idx)} processed but upload failed.")

                except Exception as e:
                    print(f"Image {task_id+str(idx)} processing/upload exception: {e}")
                finally:
                    if temp_file_path and os.path.exists(temp_file_path):
                        os.remove(temp_file_path)
                        # print(f"Image {task_id+str(idx)} processed but file removal failed.")
            
            # 清理临时任务文件夹
            try: os.rmdir(temp_img_dir)
            except: pass

            # 更新数据：用CDN URL列表替换base64数据
            data["data"] = cdn_urls

    # 保存最终结果 JSON
    data["client_id"] = client_id
    file_path = os.path.join(target_dir, f"{task_id}.json")
    try:
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print(f"Task result saved: {file_path}")
        
        # 异步推送结果
        asyncio.create_task(push_result_to_ixspy(task_id, data))
        
        return True
    except Exception as e:
        print(f"Failed to save result: {e}")
        return False

def save_task_file(task_id: str, data: dict):
    # 获取任务 action 和文件路径
    action = data.get("action", "generate_image")
    image_disk_path = data.get("file_path")
    
    # 确定日期目录
    date_folder = datetime.now().strftime("%Y-%m-%d")
    target_dir = os.path.join(FILES_DIR, date_folder)
    os.makedirs(target_dir, exist_ok=True)

    cdn_url = None
    
    if image_disk_path and os.path.exists(image_disk_path):
        _, file_extension = os.path.splitext(image_disk_path)
        if not file_extension:
            file_extension = ".bin"
        
        if action == "generate_image":
            try:
                subprocess.run(f'GeminiWatermarkTool "{image_disk_path}"', shell=True, check=True)
                print(f"Watermark processing successful: {image_disk_path}")
            except subprocess.CalledProcessError as e:
                print(f"Failed to execute GeminiWatermarkTool: {e}")
        elif action == "generate_video":
            try:
                subprocess.run(f'GeminiWatermarkTool-Video.exe "{image_disk_path}"', shell=True, check=True)
                print(f"Video watermark processing successful: {image_disk_path}")
            except subprocess.CalledProcessError as e:
                print(f"Failed to execute GeminiWatermarkTool-Video.exe: {e}")
        
        object_name = f"ai/img/task_results/{date_folder}/{task_id}{str(datetime.now().timestamp())}{file_extension}"        
        cdn_url = upload_to_s3(image_disk_path, object_name)

    # 更新或创建要保存的 result_data
    result_data = data
    if cdn_url:
        result_data["cdn_url"] = cdn_url
        result_data["file_type"] = "cdn_url"
        # 移除现在已多余的本地路径和base64(如果存在)
        result_data.pop("file_path", None)
        result_data.pop("files", None)
    
    # 保存任务文件记录 JSON
    file_path = os.path.join(target_dir, f"{task_id}.json")
    try:
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(result_data, f, ensure_ascii=False, indent=2)
        print(f"Task file metadata saved: {file_path}")
        
        # 异步推送包含 cdn_url 的结果
        asyncio.create_task(push_result_to_ixspy(task_id, result_data))
        return True
    except Exception as e:
        print(f"Failed to save file metadata: {e}")
        return False


# === WebSocket 路由 ===
@app.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str):
    await manager.connect(websocket, client_id)
    try:
        while True:
            data = await websocket.receive_text()
            try:
                response = json.loads(data)
                
                # 心跳
                if response.get("type") == "ping":
                    await websocket.send_text(json.dumps({"type": "pong"}))
                    continue

                # 下载完成通知 -> 保存到 task_files/日期/xxx.json
                elif response.get("type") == "download_complete":
                    task_id = response.get("task_id", "Unknown")
                    # 这里假设客户端发回的 file_path 是文件名或相对路径
                    # 如果需要保存详细信息，可以直接保存整个 response
                    save_task_file(task_id, response)     
                    continue 
                      
                # 任务完成通知 -> 保存到 task_results/日期/xxx.json
                status = response.get("status")
                if status in ["success", "error"]:
                    task_id = response.get("task_id", "Unknown")
                    print(f"[{client_id}] Task completed: {task_id} (Status: {status})")
                    
                    save_task_result(task_id, client_id, response)
                    
                    manager.mark_idle(client_id)
                    await check_and_dispatch_task(client_id)
                else:
                    pass

            except json.JSONDecodeError:
                pass
    except WebSocketDisconnect:
        manager.disconnect(client_id)
    except Exception as e:
        print(f"WebSocket exception: {e}")
        manager.disconnect(client_id)

# === HTTP 下发任务接口 ===
@app.post("/api/ask")
async def send_task(request: TaskRequest):
    print(f"[{request.client_id}] Task received: {request.action}")
    if request.client_id:
        is_continue = True
    else:
        is_continue = False
        
    action = request.action    
    if not action:
        action = "generate_image" 

    model = request.model    
    if not model:
        model = "Pro" 
        
    task_id = f"task_{uuid.uuid4().hex[:8]}"
    
    if action == "generate_image":
        task_payload = {
        "action": "generate_image" ,
        "is_continue": is_continue,
        "task_id": task_id,
        "model": model,
        "prompt": request.prompt,
        "source": request.source,
        "image": request.image 
        }
    elif action == "generate_text":
        task_payload = {
        "action": "generate_text" ,
        "model": model,
        "is_continue": is_continue,
        "task_id": task_id,
        "prompt": request.prompt,
        "source": request.source,
        "image": request.image 
        }
    elif action == "generate_video":
        task_payload = {
        "action": "generate_video" ,
        "model": model,
        "is_continue": is_continue,
        "task_id": task_id,
        "prompt": request.prompt,
        "source": request.source,
        "image": request.image
        }    
    else:
        return {"status": "error", "message": "无效的操作"}     

    target_client = manager.get_idle_client(request.client_id)

    if target_client:
        print(f"Immediate task dispatch [{task_id}] -> {target_client}")
        await manager.send_task_payload(task_payload, target_client)
        return {
            "status": "processing",
            "message": "任务已发送给客户端",
            "task_id": task_id,
            "queue_position": 0
        }
    
    else:
        print(f"All clients busy or offline, task [{task_id}] queued...")
        save_to_queue(task_payload)
        waiting_count = get_waiting_count()
        return {
            "status": "queued",
            "message": "任务已排队",
            "task_id": task_id,
            "waiting_count": waiting_count,
            "query_url": f"/api/result/{task_id}"
        }

# === [修改] 查询结果接口 ===
@app.get("/api/result/{task_id}")
async def get_task_result(task_id: str):
    # 使用新函数查找文件路径 (支持日期子文件夹)
    file_path = find_file_path(RESULTS_DIR, task_id)
    
    if file_path:
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                result_data = json.load(f)
            return {"status": "completed", "result": result_data}
        except Exception:
            return {"status": "error", "message": "读取失败"}
    
    # 如果结果没找到，检查排队列表
    # (注意：Wait 目录我们保持了扁平结构，所以直接glob查找)
    queue_files = glob.glob(os.path.join(WAIT_DIR, f"*_{task_id}.json"))
    if queue_files:
        return {"status": "queued", "message": "任务正在排队中"}
        
    return {"status": "processing", "message": "任务处理中或不存在"}


@app.get("/api/files/{task_id}")
async def get_task_files(task_id: str):
    # 使用新函数在 FILES_DIR 中查找任务的JSON记录
    json_file_path = find_file_path(FILES_DIR, task_id)
    
    if json_file_path:
        try:
            # 直接返回记录了 cdn_url 的 JSON 文件内容
            with open(json_file_path, "r", encoding="utf-8") as f:
                result_data = json.load(f)
            return {"status": "completed", "result": result_data}

        except Exception as e:
            return {"status": "error", "message": f"读取失败: {str(e)}"}
    
    # 检查排队
    queue_files = glob.glob(os.path.join(WAIT_DIR, f"*_{task_id}.json"))
    if queue_files:
        return {"status": "queued", "message": "任务正在排队中"}
        
    return {"status": "processing", "message": "文件生成中或不存在"}
@app.get("/api/resources/status")
async def get_all_resources_status():
    """
    返回资源状态快照：
    - total_count: 总客户端数
    - resources: 每个客户端的具体名称与状态
    - queue_backlog: 队列积压数
    """
    resources_list = []
    
    # 遍历所有已连接的客户端
    for client_id in manager.active_connections.keys():
        # 判断状态
        if client_id in manager.busy_clients:
            status = "busy"
        elif client_id in manager.idle_queue:
            status = "idle"
        else:
            status = "connecting" # 刚刚连接尚未进入队列的状态
            
        resources_list.append({
            "resource_name": client_id,
            "status": status
        })

    return {
        "status": "success",
        "data": {
            "summary": {
                "total_connected": len(manager.active_connections),
                "total_idle": len(manager.idle_queue),
                "total_busy": len(manager.busy_clients),
                "queue_backlog": get_waiting_count()
            },
            "resources": resources_list
        }
    }

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=9091, use_colors=False)
   
