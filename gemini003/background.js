// background.js

// ==========================================
// 0. 全局状态管理
// ==========================================
const CLIENT_ID = "bot_003";
const WS_URL = `ws://127.0.0.1:9091/ws/${CLIENT_ID}`;
let socket = null;
let heartbeatInterval = null;
let reconnectTimer = null;
let isConnecting = false;

// --- 核心：任务生命周期注册表 ---
// Key: task_id (String)
// Value: { 
//    tab_id: Number, 
//    download_timer: Number|null, 
//    is_waiting_download: Boolean 
// }
const taskRegistry = new Map();

// --- 辅助：下载ID与任务ID的映射 ---
// Key: downloadId (Number), Value: task_id (String)
const downloadIdMap = new Map();

// --- 辅助：跨域抓图请求暂存 (保留原有功能) ---
// Key: tabId (Number), Value: sendResponse (Function)
const pendingRequests = new Map();

// 用于标记当前正在尝试发起下载的任务
let currentPendingDownloadTask = null;


// ==========================================
// 1. WebSocket 模块 (保持原样)
// ==========================================
function connectWebSocket() {
    if (isConnecting) return;
    isConnecting = true;
    if (socket) { try { socket.close(); } catch(e) {} socket = null; }

    console.log(`🔌 [WS] 正在连接服务端...`);
    try { socket = new WebSocket(WS_URL); } catch (e) { retryConnect(); }

    socket.onopen = () => {
        console.log("✅ [WS] 连接成功");
        isConnecting = false;
        socket.send(JSON.stringify({ type: "login", msg: "I am ready" }));
        startHeartbeat();
    };

    socket.onmessage = async (event) => {
        try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'pong') return;
            if (msg.action === "generate_image") {
                await handleGenerateTask(msg);
            }else if (msg.action === "generate_text") {
                await handleGenerateTask(msg);
            }else if (msg.action === "generate_video") {
                await handleGenerateTask(msg);
            }else{
                const payload = {
                    status: "error",
                    task_id: msg.task_id, 
                    data: "", 
                    error: "没有定义的消息类型"
                };
                sendToPython(payload);
                closeTabAndCleanup(msg.task_id);
            }
    
        } catch (e) { console.error("解析消息失败", e); }
    };

    socket.onclose = () => {
        console.warn(`⚠️ [WS] 断开，重连中...`);
        cleanupConnection();
        isConnecting = false;
        retryConnect();
    };
    socket.onerror = () => {}; 
}

function retryConnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWebSocket, 3000);
}

function startHeartbeat() {
    stopHeartbeat();
    heartbeatInterval = setInterval(() => {
        if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
    }, 20000);
}

function stopHeartbeat() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
}

function cleanupConnection() {
    stopHeartbeat();
    socket = null;
}

// Service Worker 保活
setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);

connectWebSocket();


// ==========================================
// 2. 核心：任务处理与 Tab 管理 (已修改)
// ==========================================

async function handleGenerateTask(task) {
    const taskId = task.task_id;
    console.log(`🚀 [Task: ${taskId}] 收到新任务，准备创建独立 Tab...`);

    // 1. 创建新 Tab
    chrome.tabs.create({ url: "https://gemini.google.com/app", active: true }, (newTab) => {
        if (!newTab || !newTab.id) {
            sendToPython({ status: "error", task_id: taskId, error: "Tab 创建失败" });
            return;
        }

        const tabId = newTab.id;
        console.log(`📌 [Task: ${taskId}] 绑定 Tab ID: ${tabId}`);

        // 2. 注册任务状态
        // 针对视频生成设置 15 分钟超时，其他默认 5 分钟
        const timeoutDuration = task.action === "generate_video" ? 900000 : 300000;
        const timeoutId = setTimeout(() => {
            if (taskRegistry.has(taskId)) { // Check if task is still running
                console.error(`⏰ [Task: ${taskId}] 任务执行超时 (${timeoutDuration/60000}分钟)，强制关闭!`);
                const payload = { status: "error", task_id: taskId, action: task.action, data: "", error: "Content script 执行超时" };
                sendToPython(payload);
                closeTabAndCleanup(taskId);
            }
        }, timeoutDuration);

        taskRegistry.set(taskId, {
            tab_id: tabId,
            task_action: task.action, // 保存 action 到注册表中
            download_timer: null,
            is_waiting_download: true,
            timeout_id: timeoutId
        });

        // 3. 监听 Tab 加载完成
        const listener = (updatedTabId, changeInfo, tab) => {
            if (updatedTabId === tabId && changeInfo.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(listener);
                
                console.log(`✅ [Task: ${taskId}] Tab 加载完毕，发送执行指令...`);
                
                // 4. 发送指令给 Content Script
                setTimeout(() => {
                    chrome.tabs.sendMessage(tabId, {
                        action: "type_and_send",
                        is_continue: task.is_continue,
                        text: task.prompt,
                        image: task.image,
                        task_id: taskId,
                        task_action: task.action,  // 透传 action
                        task_model: task.model     // 透传 model
                    }).catch(err => {
                        console.error(`❌ [Task: ${taskId}] 发送指令失败:`, err);
                        // --- 修改点 1: 拆分调用 ---
                        const payload = {
                            status: "error",
                            task_id: taskId, 
                            action: task.action, // 透传 action
                            data: "", 
                            error: "Content script 通信失败"
                        };
                        sendToPython(payload);
                        closeTabAndCleanup(taskId);
                    });
                }, 3000); 
            }
        };

        chrome.tabs.onUpdated.addListener(listener);
    });
}

/**
 * 功能拆分 1: 发送结果给 Python
 */
function sendTaskResult(taskId, status, messageOrData, action, url_id) {
    console.log(`📡 [Task: ${taskId}] 发送结果: ${status}`);
    
    if (socket && socket.readyState === WebSocket.OPEN) {
        const payload = {
            task_id: taskId,
            status: status,
            action: action // 增加 action 字段
        };
        
        // 增加 url_id 字段 (如果有)
        if (url_id) {
            payload.url_id = url_id;
        }
        
        if (status === 'success') {
            // 简单判断是文件路径还是HTML数据
            if (messageOrData && typeof messageOrData === 'string' && messageOrData.length < 300 && messageOrData.includes('.')) {
                 payload.file_path = messageOrData; 
            } else {
                 payload.data = messageOrData;
            }
        } else {
            payload.error = messageOrData;
        }

        socket.send(JSON.stringify(payload));
    }
}

/**
 * 功能拆分 2: 关闭 Tab 和清理资源
 */
function closeTabAndCleanup(taskId) {
    const taskData = taskRegistry.get(taskId);
    if (!taskData) return; 

    console.log(`🧹 [Task: ${taskId}] 清理资源并关闭 Tab`);

    // 1. 清理下载定时器
    if (taskData.download_timer) {
        clearTimeout(taskData.download_timer);
    }

    // --- 新增：清理整体任务超时计时器 ---
    if (taskData.timeout_id) {
        clearTimeout(taskData.timeout_id);
    }

    // 2. 关闭 Tab
    if (taskData.tab_id) {
        chrome.tabs.remove(taskData.tab_id, () => {
             if (chrome.runtime.lastError) {}
        });
    }

    // 3. 清理内存
    taskRegistry.delete(taskId);
}


// ==========================================
// 3. 消息监听 (包含 新逻辑 + 原有辅助逻辑)
// ==========================================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    
    // ------------------------------------------------
    // A. 准备下载 (Content Script 点击下载按钮前触发)
    // ------------------------------------------------
    if (request.action === "prepare_intercept") {
        const taskId = request.task_id;
        const taskData = taskRegistry.get(taskId);

        if (taskData) {
            console.log(`🎣 [Task: ${taskId}] 收到下载预警，启动超时监控...`);
            
            taskData.is_waiting_download = true;
            currentPendingDownloadTask = taskId; 
            
            // 视频也使用 15 分钟下载监控时长
            const task_action = request.task_action;
            const timeoutDuration = task_action === "generate_video" ? 900000 : 180000;

            // 设置超时销毁
            taskData.download_timer = setTimeout(() => {
                console.error(`⏰ [Task: ${taskId}] 下载超时 (${timeoutDuration/60000}分钟)，强制关闭!`);
                // --- 修改点 2: 拆分调用 ---
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ 
                    type: "download_complete",
                    task_id: taskId, 
                    action: taskData.task_action, // 从任务注册表中取出 action 发送
                    file_path: '' 
                }));
            }

                closeTabAndCleanup(taskId);
            }, timeoutDuration); 

            taskRegistry.set(taskId, taskData);
        }
        
        sendResponse({ success: true });
        return false;
    }

    // ------------------------------------------------
    // B. 任务基本完成 (Content Script 流程走完)
    // ------------------------------------------------
    if (request.action === "task_completed") {
        const { task_id, data, error, task_action, url_id ,message } = request;
      
        const taskData = taskRegistry.get(task_id);

        if (!taskData) {
            sendResponse({ success: true }); 
            return;
        }

       

        if (error) {
            console.log(`❌ 任务 [${task_id}] 执行出错了，全部流程结束，回传 Python`);
            const payload = {
                status: "error",
                task_id: task_id, 
                action: task_action, // 加上 action
                data: data || "", 
                error: error || null,
                message: message || null
            };
            if(url_id) payload.url_id = url_id;
            sendToPython(payload);
            closeTabAndCleanup(task_id);
        } else {
            // 成功分支
            console.log(`🎉 任务 [${task_id}] (${task_action}) 在页面执行成功，回传 Python`);
            const payload = {
                status: "success",
                task_id: task_id, 
                action: task_action, // 加上 action
                data: data || "", 
                error: null,
                message: message || null
            };
            if(url_id) payload.url_id = url_id;
            sendToPython(payload);
            
            // 文本任务没有后续的下载动作，直接清理
            if (task_action === "generate_text") {
                console.log(`🧹 [Task: ${task_id}] 文本任务无需等待下载，立即清理资源并关闭 Tab`);
                closeTabAndCleanup(task_id);
            } else {
                console.log(`⏳ [Task: ${task_id}] 等待图片下载完成...`);
            }
        }
        sendResponse({ success: true });
    }

    // ------------------------------------------------
    // C. 辅助：新开 Tab 下载图片 (恢复原有逻辑)
    // ------------------------------------------------
    if (request.action === "downloadImageViaTab") {
        const targetUrl = request.url;
        console.log("🚀 [Background] 准备打开辅助 Tab 下载:", targetUrl);

        chrome.tabs.create({ url: targetUrl, active: false }, (newTab) => {
            if (newTab && newTab.id) {
                // 保存回调，等待 image_grabber.js 发回数据
                pendingRequests.set(newTab.id, sendResponse);
            } else {
                sendResponse({ success: false, error: "Tab create failed" });
            }
        });
        return true; // 保持异步等待
    }

    // ------------------------------------------------
    // D. 辅助：图片数据回传 (恢复原有逻辑)
    // ------------------------------------------------
    if (request.action === "imageCaptured") {
        const { data, error } = request;
        const tabId = sender.tab ? sender.tab.id : null;

        if (tabId && pendingRequests.has(tabId)) {
            const originalSendResponse = pendingRequests.get(tabId);
            if (error) {
                originalSendResponse({ success: false, error });
            } else {
                originalSendResponse({ success: true, data });
            }
            pendingRequests.delete(tabId);
            chrome.tabs.remove(tabId); // 这里的 remove 是关闭辅助 Tab，不影响主任务
        }
    }
});


// ==========================================
// 4. 下载管理器 (已修改)
// ==========================================

// 监听下载创建，绑定 DownloadID <-> TaskID
chrome.downloads.onCreated.addListener((item) => {
    if (currentPendingDownloadTask) {
        console.log(`📥 [Download] ID:${item.id} 归属于 Task:${currentPendingDownloadTask}`);
        downloadIdMap.set(item.id, currentPendingDownloadTask);
        currentPendingDownloadTask = null; 
    }else {
        console.log(`📥 [Download] 监听到其他下载任务`);
    }
});

// 监听下载状态变化
chrome.downloads.onChanged.addListener((delta) => {
    const downloadId = delta.id;
    const taskId = downloadIdMap.get(downloadId);

    // if (!taskId) return; 

    // 1. 下载完成
    if (delta.state && delta.state.current === 'complete') {
        console.log(`✅ [Task: ${taskId}] 下载完成!`);
        
        chrome.downloads.search({ id: downloadId }, (results) => {
            const filePath = (results && results[0]) ? results[0].filename : "unknown_file";
            // --- 修改点 5: 拆分调用 (下载成功) ---
            if (!taskId) {
                console.log(`其他任务下载完成，忽略`);
                console.log(`📂 文件路径: ${filePath}`);
            } else{
                const taskData = taskRegistry.get(taskId) || {}; // 取出 taskData 拿 action
                console.log(`📂 文件路径: ${filePath}`);
                if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(
                    JSON.stringify({
                    type: "download_complete",
                    task_id: taskId,
                    action: taskData.task_action, // 从注册表获取 action 传给 Python
                    file_path: filePath,
                    })
                );
                }
                closeTabAndCleanup(taskId);

                downloadIdMap.delete(downloadId);
            }

           
        });
    }

    // 2. 下载中断/失败
    else if (delta.state && delta.state.current === 'interrupted') {
        console.warn(`❌ [Task: ${taskId}] 下载中断!`);
        // --- 修改点 6: 拆分调用 (下载失败) ---
        if (!taskId) {
            // ... (无关的可以不管)
        } else {
            const taskData = taskRegistry.get(taskId) || {};
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(
                    JSON.stringify({
                         type: "download_complete",
                         task_id: taskId,
                         action: taskData.task_action,
                         file_path: "",
                        })
                    );
            }
            closeTabAndCleanup(taskId);
            downloadIdMap.delete(downloadId);
        }
       
    }
});

// 辅助：发送数据回 Python (这个保留用于 handleGenerateTask 里的简单错误回传，或者也可以统一用 sendTaskResult)
function sendToPython(data) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(data));
    }
}