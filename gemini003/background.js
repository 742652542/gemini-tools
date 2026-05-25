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
let preloadTabId = null;
let preloadState = "idle";
let preloadModel = null;
let preloadRestoreTimer = null;
let preloadLoadListener = null;
let preloadPrepareTimer = null;
let preloadAttemptId = 0;
let preloadPrepareStarted = false;
const ENABLE_PRELOAD = true;
const PRELOAD_MODEL = "Pro";
const PRELOAD_PREPARE_TIMEOUT = 20000;
const CONVERSATION_LOST_ERROR = "对话窗口丢失了。";
const MAX_CONVERSATION_LOST_RETRY = 1;
const GEMINI_USAGE_URL = "https://gemini.google.com/usage";
const GEMINI_USAGE_POST_URL = "https://ixspy.com/api/gemini/receive-line-info";
const GEMINI_USAGE_INTERVAL_MS = 10 * 60 * 1000;
const GEMINI_USAGE_PAGE_TIMEOUT = 30000;
const GEMINI_USAGE_MESSAGE_TIMEOUT = 20000;

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
let usagePollingTimer = null;
let usageCollectionInProgress = false;
let usageTabId = null;
let usageLoadListener = null;
let usageTimeoutId = null;

function clearUsageRuntime() {
    if (usageLoadListener) {
        chrome.tabs.onUpdated.removeListener(usageLoadListener);
        usageLoadListener = null;
    }

    if (usageTimeoutId) {
        clearTimeout(usageTimeoutId);
        usageTimeoutId = null;
    }
}

function cleanupUsageCollection() {
    const tabId = usageTabId;
    console.log(`[Usage] 清理本轮状态, tabId=${tabId || "none"}`);
    clearUsageRuntime();
    usageCollectionInProgress = false;
    usageTabId = null;

    if (tabId) {
        chrome.tabs.remove(tabId, () => {
            if (chrome.runtime.lastError) {}
        });
    }
}

async function postUsageSnapshot(snapshot) {
    console.log("[Usage] 准备推送 usage 数据:", snapshot);
    await fetch(GEMINI_USAGE_POST_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            ...snapshot,
            clientId: CLIENT_ID
        })
    });
    console.log("[Usage] usage 数据推送完成");
}

function requestUsageSnapshot(tabId) {
    return new Promise((resolve, reject) => {
        console.log(`[Usage] 向 tab ${tabId} 请求页面采集`);
        const timer = setTimeout(() => {
            reject(new Error("Usage snapshot request timed out"));
        }, GEMINI_USAGE_MESSAGE_TIMEOUT);

        chrome.tabs.sendMessage(tabId, { action: "collect_usage_snapshot" }).then((response) => {
            clearTimeout(timer);
            if (!response || response.success !== true || !response.data) {
                const detail = response ? JSON.stringify(response) : "no response payload";
                reject(new Error(`Usage snapshot collection failed: ${detail}`));
                return;
            }

            resolve(response.data);
        }).catch((error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

async function collectUsageFromTab(tabId) {
    try {
        console.log(`[Usage] 开始从 tab ${tabId} 采集 usage`);
        const snapshot = await requestUsageSnapshot(tabId);
        console.log("[Usage] 页面采集成功:", snapshot);
        console.log("[Usage] 页面采集结果(JSON):", JSON.stringify(snapshot));
        await postUsageSnapshot(snapshot);
    } catch (error) {
        console.warn("[Usage] 本轮采集或推送失败，等待下一轮:", error);
    } finally {
        cleanupUsageCollection();
    }
}

function openUsageTabAndCollect() {
    usageCollectionInProgress = true;
    console.log("[Usage] 当前空闲，准备打开 usage 页面");

    chrome.tabs.create({ url: GEMINI_USAGE_URL, active: false }, (newTab) => {
        if (chrome.runtime.lastError || !newTab || !newTab.id) {
            console.warn("[Usage] usage 页面打开失败", chrome.runtime.lastError);
            cleanupUsageCollection();
            return;
        }

        const tabId = newTab.id;
        let hasCollected = false;
        usageTabId = tabId;
        console.log(`[Usage] usage 页面已打开, tabId=${tabId}`);
        usageTimeoutId = setTimeout(() => {
            console.warn(`[Usage] usage 页面等待超时, tabId=${tabId}`);
            cleanupUsageCollection();
        }, GEMINI_USAGE_PAGE_TIMEOUT);

        const collectOnce = () => {
            if (hasCollected) return;
            hasCollected = true;
            collectUsageFromTab(tabId);
        };

        const onUsageTabReady = (updatedTabId, changeInfo) => {
            if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
            console.log(`[Usage] usage 页面加载完成, tabId=${tabId}`);

            if (usageLoadListener === onUsageTabReady) {
                chrome.tabs.onUpdated.removeListener(onUsageTabReady);
                usageLoadListener = null;
            }

            collectOnce();
        };

        usageLoadListener = onUsageTabReady;
        chrome.tabs.onUpdated.addListener(onUsageTabReady);

        chrome.tabs.get(tabId, (tab) => {
            if (chrome.runtime.lastError || !tab || tab.id !== tabId) return;
            if (tab.status === "complete") {
                if (usageLoadListener === onUsageTabReady) {
                    chrome.tabs.onUpdated.removeListener(onUsageTabReady);
                    usageLoadListener = null;
                }
                collectOnce();
            }
        });
    });
}

function runUsageCollection() {
    console.log(`[Usage] 触发轮询检查, inProgress=${usageCollectionInProgress}, taskCount=${taskRegistry.size}`);
    if (usageCollectionInProgress) {
        console.log("[Usage] 已有采集进行中，跳过本轮");
        return;
    }
    if (taskRegistry.size > 0) {
        console.log("[Usage] 当前有任务执行中，跳过本轮");
        return;
    }

    openUsageTabAndCollect();
}

function startUsagePolling() {
    if (usagePollingTimer) {
        clearInterval(usagePollingTimer);
    }

    console.log("[Usage] 启动 usage 轮询：立即执行一次，之后每 10 分钟一次");
    runUsageCollection();
    usagePollingTimer = setInterval(runUsageCollection, GEMINI_USAGE_INTERVAL_MS);
}

function isGeminiImageTask(task) {
    return task && task.action === "generate_image" && (task.source || "gemini") !== "chatgpt";
}

function clearPreloadRuntime() {
    if (preloadLoadListener) {
        chrome.tabs.onUpdated.removeListener(preloadLoadListener);
        preloadLoadListener = null;
    }
    if (preloadPrepareTimer) {
        clearTimeout(preloadPrepareTimer);
        preloadPrepareTimer = null;
    }
    if (preloadRestoreTimer) {
        clearTimeout(preloadRestoreTimer);
        preloadRestoreTimer = null;
    }
}

function clearPreloadState() {
    clearPreloadRuntime();
    preloadTabId = null;
    preloadState = "idle";
    preloadModel = null;
    preloadPrepareStarted = false;
}

function detachPreloadTab(nextState = "idle") {
    const tabId = preloadTabId;
    clearPreloadRuntime();
    preloadTabId = null;
    preloadModel = null;
    preloadState = nextState;
    preloadPrepareStarted = false;
    return tabId;
}

function isManagedPreloadTab(tabId) {
    return !!tabId && preloadTabId === tabId && (preloadState === "preparing" || preloadState === "ready");
}

function clearPreloadTab() {
    const tabId = preloadTabId;
    clearPreloadState();
    if (tabId) {
        chrome.tabs.remove(tabId, () => {
            if (chrome.runtime.lastError) {}
        });
    }
}

function schedulePreloadRestore(delay = 500) {
    if (!ENABLE_PRELOAD) return;

    if (preloadRestoreTimer) {
        clearTimeout(preloadRestoreTimer);
    }
    preloadRestoreTimer = setTimeout(() => {
        preloadRestoreTimer = null;
        ensurePreloadTab();
    }, delay);
}

function canReusePreloadForTask(task) {
    if (!ENABLE_PRELOAD) return false;

    return isGeminiImageTask(task) && preloadState === "ready" && preloadModel === PRELOAD_MODEL && !!preloadTabId;
}

function startPreloadPrepare(attemptId, attemptTabId, loadListener) {
    if (preloadAttemptId !== attemptId || preloadTabId !== attemptTabId || preloadState !== "preparing" || preloadPrepareStarted) return;
    preloadPrepareStarted = true;

    if (loadListener) {
        chrome.tabs.onUpdated.removeListener(loadListener);
        if (preloadLoadListener === loadListener) {
            preloadLoadListener = null;
        }
    }

    setTimeout(() => {
        if (preloadAttemptId !== attemptId || preloadTabId !== attemptTabId || preloadState !== "preparing") return;
        chrome.tabs.sendMessage(attemptTabId, { action: "prepare_gemini_image_preload" }).then((response) => {
            if (preloadAttemptId !== attemptId || preloadTabId !== attemptTabId || preloadState !== "preparing") return;
            if (response && response.success === true) {
                preloadState = "ready";
                preloadModel = PRELOAD_MODEL;
                if (preloadPrepareTimer) {
                    clearTimeout(preloadPrepareTimer);
                    preloadPrepareTimer = null;
                }
                console.log(`✅ [Preload] Gemini 预加载页已就绪: ${attemptTabId}`);
                return;
            }

            throw new Error("Preload content script did not confirm success");
        }).catch((err) => {
            if (preloadAttemptId !== attemptId || preloadTabId !== attemptTabId) return;
            console.error("❌ [Preload] 预加载初始化失败:", err);
            clearPreloadTab();
            schedulePreloadRestore(3000);
        });
    }, 3000);
}

function ensurePreloadTab() {
    if (!ENABLE_PRELOAD) return;

    if (preloadState === "preparing" || preloadState === "ready") return;

    const attemptId = ++preloadAttemptId;
    preloadState = "preparing";
    preloadPrepareStarted = false;
    chrome.tabs.create({ url: "https://gemini.google.com/app", active: true }, (newTab) => {
        if (preloadAttemptId !== attemptId) {
            if (newTab && newTab.id) {
                chrome.tabs.remove(newTab.id, () => {
                    if (chrome.runtime.lastError) {}
                });
            }
            return;
        }

        if (chrome.runtime.lastError || !newTab || !newTab.id) {
            console.error("❌ [Preload] 预加载页创建失败", chrome.runtime.lastError);
            clearPreloadState();
            schedulePreloadRestore(3000);
            return;
        }

        const attemptTabId = newTab.id;
        preloadTabId = attemptTabId;
        preloadPrepareTimer = setTimeout(() => {
            if (preloadAttemptId !== attemptId || preloadTabId !== attemptTabId || preloadState !== "preparing") return;
            console.error(`❌ [Preload] 预加载准备超时: ${attemptTabId}`);
            clearPreloadTab();
            schedulePreloadRestore(3000);
        }, PRELOAD_PREPARE_TIMEOUT);

        const loadListener = (updatedTabId, changeInfo) => {
            if (preloadAttemptId !== attemptId || preloadTabId !== attemptTabId || updatedTabId !== attemptTabId || changeInfo.status !== "complete") return;
            startPreloadPrepare(attemptId, attemptTabId, loadListener);
        };

        preloadLoadListener = loadListener;
        chrome.tabs.onUpdated.addListener(loadListener);

        chrome.tabs.get(attemptTabId, (tab) => {
            if (chrome.runtime.lastError || !tab || tab.id !== attemptTabId) return;
            if (tab.status === "complete") {
                startPreloadPrepare(attemptId, attemptTabId, loadListener);
            }
        });
    });
}


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
        schedulePreloadRestore(500);
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
startUsagePolling();


// ==========================================
// 2. 核心：任务处理与 Tab 管理 (已修改)
// ==========================================

async function handleGenerateTask(task) {
    const taskId = task.task_id;
    const taskSource = task.source === "chatgpt" ? "chatgpt" : "gemini";
    const targetUrl = taskSource === "chatgpt" ? "https://chatgpt.com/" : "https://gemini.google.com/app";
    console.log(`🚀 [Task: ${taskId}] 收到新任务，准备分发到任务页...`);
    console.log(`🧭 [Task: ${taskId}] 来源: ${taskSource}, 目标页面: ${targetUrl}`);

    if (canReusePreloadForTask(task)) {
        const preloadTaskTabId = detachPreloadTab("in_use");
        if (preloadTaskTabId) {
            console.log(`♻️ [Task: ${taskId}] 复用预加载 Tab: ${preloadTaskTabId}`);
            registerTaskTabAndDispatch(task, preloadTaskTabId, false, true);
            return;
        }
    }

    if (ENABLE_PRELOAD && preloadTabId) {
        console.log(`🧹 [Task: ${taskId}] 当前任务不复用预加载页，先关闭预加载 Tab`);
        clearPreloadTab();
    }

    openTaskTabAndDispatch(task, targetUrl);
}

function openTaskTabAndDispatch(task, targetUrl) {
    const taskId = task.task_id;

    chrome.tabs.create({ url: targetUrl, active: true }, (newTab) => {
        if (!newTab || !newTab.id) {
            sendToPython({ status: "error", task_id: taskId, error: "Tab 创建失败" });
            schedulePreloadRestore();
            return;
        }

        const tabId = newTab.id;
        console.log(`📌 [Task: ${taskId}] 绑定 Tab ID: ${tabId}`);
        registerTaskTabAndDispatch(task, tabId, true, false);
    });
}

function clearTaskRuntime(taskId) {
    const taskData = taskRegistry.get(taskId);
    if (!taskData) return null;

    if (taskData.download_timer) {
        clearTimeout(taskData.download_timer);
    }

    if (taskData.timeout_id) {
        clearTimeout(taskData.timeout_id);
    }

    taskRegistry.delete(taskId);
    return taskData;
}

function retryTaskAfterConversationLost(taskId) {
    const taskData = taskRegistry.get(taskId);
    if (!taskData || !taskData.original_task) return false;

    const currentRetryCount = Number(taskData.retry_count || 0);
    if (currentRetryCount >= MAX_CONVERSATION_LOST_RETRY) {
        return false;
    }

    const retryTask = {
        ...taskData.original_task,
        _conversationLostRetryCount: currentRetryCount + 1
    };
    const tabId = taskData.tab_id;

    console.warn(`↩️ [Task: ${taskId}] 检测到"${CONVERSATION_LOST_ERROR}"，关闭当前窗口后立即重试 (${currentRetryCount + 1}/${MAX_CONVERSATION_LOST_RETRY})`);

    clearTaskRuntime(taskId);

    if (tabId) {
        chrome.tabs.remove(tabId, () => {
            if (chrome.runtime.lastError) {}
        });
    }

    setTimeout(() => {
        handleGenerateTask(retryTask);
    }, 0);

    return true;
}

function registerTaskTabAndDispatch(task, tabId, waitForLoad = true, isPreloadReuse = false) {
    const taskId = task.task_id;
    const taskSource = task.source === "chatgpt" ? "chatgpt" : "gemini";
    const timeoutDuration = task.action === "generate_video" ? 900000 : 360000;
    const timeoutId = setTimeout(() => {
        if (taskRegistry.has(taskId)) {
            console.error(`⏰ [Task: ${taskId}] 任务执行超时 (${timeoutDuration/60000}分钟)，强制关闭!`);
            const payload = { status: "error", task_id: taskId, action: task.action, data: "", error: "Content script 执行超时" };
            sendToPython(payload);
            closeTabAndCleanup(taskId);
        }
    }, timeoutDuration);

    taskRegistry.set(taskId, {
        tab_id: tabId,
        task_action: task.action,
        task_source: taskSource,
        original_task: task,
        retry_count: Number(task._conversationLostRetryCount || 0),
        download_timer: null,
        is_waiting_download: true,
        timeout_id: timeoutId
    });

    const dispatchToTab = () => {
        console.log(`✅ [Task: ${taskId}] Tab 已就绪，发送执行指令...`);
        setTimeout(() => {
            chrome.tabs.sendMessage(tabId, {
                action: "type_and_send",
                is_continue: task.is_continue,
                text: task.prompt,
                image: task.image,
                task_id: taskId,
                task_action: task.action,
                task_model: task.model,
                targetRatio: task.targetRatio,
                source: taskSource,
                use_preloaded_tab: isPreloadReuse
            }).catch(err => {
                if (!taskRegistry.has(taskId)) {
                    console.log(`ℹ️ [Task: ${taskId}] Content script 响应通道已关闭，但任务已结束，忽略通信失败误报`);
                    return;
                }

                console.error(`❌ [Task: ${taskId}] 发送指令失败:`, err);

                if (isPreloadReuse) {
                    console.warn(`↩️ [Task: ${taskId}] 预加载复用失败，降级为新开页重试`);
                    clearTaskRuntime(taskId);
                    chrome.tabs.remove(tabId, () => {
                        if (chrome.runtime.lastError) {}
                        openTaskTabAndDispatch(task, "https://gemini.google.com/app");
                    });
                    return;
                }

                const payload = {
                    status: "error",
                    task_id: taskId,
                    action: task.action,
                    data: "",
                    error: "Content script 通信失败"
                };
                sendToPython(payload);
                closeTabAndCleanup(taskId);
            });
        }, waitForLoad ? 3000 : 0);
    };

    if (!waitForLoad) {
        dispatchToTab();
        return;
    }

    const listener = (updatedTabId, changeInfo) => {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            dispatchToTab();
        }
    };

    chrome.tabs.onUpdated.addListener(listener);

    chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab || tab.id !== tabId) return;
        if (tab.status === "complete") {
            chrome.tabs.onUpdated.removeListener(listener);
            dispatchToTab();
        }
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
    const taskData = clearTaskRuntime(taskId);
    if (!taskData) return; 

    console.log(`🧹 [Task: ${taskId}] 清理资源并关闭 Tab`);

    // 2. 关闭 Tab
    if (taskData.tab_id) {
        chrome.tabs.remove(taskData.tab_id, () => {
             if (chrome.runtime.lastError) {}
        });
    }

    // 3. 恢复预加载页
    schedulePreloadRestore();
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
            if (error === CONVERSATION_LOST_ERROR && retryTaskAfterConversationLost(task_id)) {
                sendResponse({ success: true });
                return;
            }

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
            } else if (taskData.task_source === "chatgpt") {
                console.log(`🧹 [Task: ${task_id}] ChatGPT 图片任务已直接回传 base64，立即清理资源并关闭 Tab`);
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
    if (request.action === "downloadImageViaTab" || request.action === "downloadImageDirect") {
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

chrome.tabs.onRemoved.addListener((tabId) => {
    if (isManagedPreloadTab(tabId)) {
        clearPreloadState();
        schedulePreloadRestore(3000);
    }

    if (usageTabId && tabId === usageTabId) {
        clearUsageRuntime();
        usageCollectionInProgress = false;
        usageTabId = null;
    }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (!isManagedPreloadTab(tabId) || preloadState !== "ready") return;
    if (!changeInfo.url && changeInfo.status !== "loading") return;

    console.warn(`⚠️ [Preload] 预加载页状态失效: ${tabId}`);
    clearPreloadTab();
    schedulePreloadRestore(3000);
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
