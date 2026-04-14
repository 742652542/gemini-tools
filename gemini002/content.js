

console.log("🤖 [Gemini Bot] Content Script Loaded (Final Version)");

// ==========================================
// 1. 初始化：注入 injected.js
// ==========================================
const s = document.createElement('script');
s.src = chrome.runtime.getURL('injected.js');
s.onload = function() { this.remove(); };
(document.head || document.documentElement).appendChild(s);


// ==========================================
// 2. 核心：流程控制函数
// ==========================================

/**
 * 等待图片上传完成信号 (来自 injected.js)
 */
function waitForUploadSuccess(timeoutMs = 600000) {
    return new Promise((resolve) => {
        console.log("⏳ [2/5] 开始监听上传信号...");
        const handler = () => {
            console.log("✅ 收到上传成功信号");
            clearTimeout(timer);
            window.removeEventListener('GEMINI_UPLOAD_COMPLETE', handler);
            resolve(true);
        };
        window.addEventListener('GEMINI_UPLOAD_COMPLETE', handler);
        const timer = setTimeout(() => {
            window.removeEventListener('GEMINI_UPLOAD_COMPLETE', handler);
            console.warn("⚠️ 等待上传超时 (可能这次没发图片，或网络太慢)");
            resolve(false); 
        }, timeoutMs);
    });
}




/**
 * 专门用于等待视频生成完成的函数
 * 因为视频生成需要 5-10 分钟，不能用简单的"停止生成"按钮判定
 */
function waitForVideoReady(timeoutMs = 900000) { // 默认 15 分钟
    return new Promise((resolve) => {
        console.log(`⏳ [3/5] 开始持续监控视频生成状态 (最长等待 ${timeoutMs/60000} 分钟)...`);
        
        const startTime = Date.now();
        let lastLoggedStatus = "";
        
        const observer = new MutationObserver(() => {
            const timeElapsed = Date.now() - startTime;
            
            // 查找最新的回复区块
            const responseBlocks = document.querySelectorAll('message-content');
            if (responseBlocks.length === 0) return;
            const lastBlock = responseBlocks[responseBlocks.length - 1];
            
            const textContent = lastBlock.textContent ? lastBlock.textContent.toLowerCase() : "";
            
            // 判定 1：生成失败 (Error)
            if (textContent.includes("无法生成该视频") || textContent.includes("can't generate that video") || textContent.includes("生成视频时出错") || textContent.includes("error generating video")) {
                console.warn(`❌ 视频生成失败: ${textContent.substring(0, 100)}...`);
                observer.disconnect();
                clearTimeout(timer);
                resolve({ status: 'error', data: lastBlock.textContent }); // 返回原始文本
                return;
            }

            // 判定 2：明确的成功提示 (Success)
            const downloadBtn = lastBlock.querySelector('button[aria-label="下载视频"]') || 
                                lastBlock.querySelector('button[aria-label="Download video"]');
                                
            if (textContent.includes("您的视频已准备就绪") || textContent.includes("your video is ready") || downloadBtn) {
                console.log("✅ 视频生成完毕！");

                observer.disconnect();
                clearTimeout(timer);
                resolve({ status: 'success', data: lastBlock.textContent });
                return;
            }
            
            // 判定 3：正在生成 (Waiting)
            if (textContent.includes("正在生成视频") || textContent.includes("generating your video") || textContent.includes("请稍后回来查看") || textContent.includes("check back later")) {
                if (lastLoggedStatus !== "generating") {
                    console.log("🔄 正在努力生成视频中，请耐心等待...");
                    lastLoggedStatus = "generating";
                }
                return; // 继续等待
            }
        });

        observer.observe(document.body, { childList: true, subtree: true, characterData: true });

        const timer = setTimeout(() => {
            observer.disconnect();
            console.error(`⚠️ 视频监控超时 (${timeoutMs/60000}分钟)`);
            resolve({ status: 'timeout', data: '等待超时' });
        }, timeoutMs);
    });
}

/**
 * 等待回答生成完成 (监听 DOM 按钮 - 适用于文本和图片)
 */
function waitForReplyComplete(timeoutMs = 240000) {
    return new Promise((resolve) => {
        console.log("⏳ [3/5] 监听回答生成中...");
        
        // 标记开始时间
        const startTime = Date.now();

        const observer = new MutationObserver(() => {
            // 查找"停止"按钮 (覆盖中英文)
            const stopBtn = document.querySelector('button[aria-label="Stop generating"]') || 
                            document.querySelector('button[aria-label="停止生成"]');
            
            // 查找"发送"按钮
            const sendBtn = document.querySelector('button[aria-label="Send"]') || 
                            document.querySelector('button[aria-label="发送"]');

            // 逻辑：停止按钮不存在 + 发送按钮存在 = 空闲/完成
            // 且必须确保距离开始监听已经过了一小段时间(防止刚点击发送还没来得及变状态)
            if (!stopBtn && sendBtn && (Date.now() - startTime > 1000)) {
                const responses = document.querySelectorAll('message-content');
                if (responses.length > 0) {
                    observer.disconnect();
                    clearTimeout(timer);
                    resolve(true);
                }else{
                    const container = document.querySelectorAll("response-container");
                    if (container.length == 0) {
                        console.warn("⚠️ 没有生成内容");
                        observer.disconnect();
                        clearTimeout(timer);
                        resolve(true);
                    }else{
                        console.log("✅ 生成失败");
                    }
                }
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });

        const timer = setTimeout(() => {
            observer.disconnect();
            console.warn("⚠️ 等待回答超时");
            resolve(false);
        }, timeoutMs);
    });
}


// ==========================================
// 3. 核心：数据处理 (Canvas 缓存直读版)
// ==========================================

// Base64 -> File (保持不变)
function base64ToFile(base64Data, filename, mimeType) {
    if (base64Data.includes(',')) base64Data = base64Data.split(',')[1];
    const byteCharacters = atob(base64Data);
    const byteArrays = [];
    for (let offset = 0; offset < byteCharacters.length; offset += 512) {
        const slice = byteCharacters.slice(offset, offset + 512);
        const byteNumbers = new Array(slice.length);
        for (let i = 0; i < slice.length; i++) { byteNumbers[i] = slice.charCodeAt(i); }
        byteArrays.push(new Uint8Array(byteNumbers));
    }
    return new File([new Blob(byteArrays, { type: mimeType })], filename, { type: mimeType });
}

/**
 * 辅助：从 img 标签获取最高清的 URL
 */
function getHighestResUrl(img) {
    if (img.srcset) {
        const sources = img.srcset.split(',').map(str => {
            const [url, widthDesc] = str.trim().split(/\s+/);
            const width = widthDesc ? parseInt(widthDesc.replace('w', '')) : 0;
            return { url, width };
        });
        sources.sort((a, b) => b.width - a.width);
        if (sources.length > 0) return sources[0].url;
    }
    return img.src || img.getAttribute('data-src');
}

/**
 * 核心魔法：将图片转换为 Canvas 并导出 Base64
 * 这会利用浏览器缓存，避免网络请求，且绕过 CORS 凭证问题
 */
function convertImgToCanvasBase64(url) {
    return new Promise((resolve) => {
        const img = new Image();
        // 关键1：开启跨域匿名模式。Google 图片服务器允许匿名访问，且 header 为 *
        // 这样设置后，Canvas 就不会被污染（Tainted）
        img.crossOrigin = "anonymous"; 
        
        img.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                // 导出数据
                const dataURL = canvas.toDataURL('image/png');
                resolve(dataURL);
            } catch (err) {
                console.warn("⚠️ Canvas 导出失败 (CORS 依然受限):", err);
                resolve(null);
            }
        };

        img.onerror = () => {
            console.warn("⚠️ 匿名加载图片失败:", url);
            resolve(null);
        };

        // 关键2：赋值 URL 触发加载 (通常会命中浏览器缓存)
        img.src = url;
        
        // 超时保护
        setTimeout(() => resolve(null), 3000);
    });
}

async function imageUrlToBase64(url) {
    const maxRetries = 15;
    const intervalMs = 2000;

    if (!url) return null;
    if (url.startsWith("data:")) return url;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const result = await new Promise(async (resolve) => {
            // --- 核心修复：处理 blob: URL ---
            // 特别说明只兼容blob:https://gemini.google.com/，其他的参考之前的
            if (url.startsWith("blob:https://gemini.google.com/")) {
                try {
                    console.log(`📦 [Content] 检测到 Blob URL，正在本地转换... (第 ${attempt}/${maxRetries} 次尝试)`);
                    const response = await fetch(url);
                    const blob = await response.blob();
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result);
                    reader.onerror = () => {
                        console.error("❌ [Content] FileReader 转换失败");
                        resolve(null);
                    };
                    reader.readAsDataURL(blob);
                    return;
                } catch (err) {
                    console.error("❌ [Content] Blob 获取失败:", err);
                    return resolve(null);
                }
            }
            // -------------------------------

            console.log(`🛰️ 请求新 Tab 抓取: ${url.substring(0, 40)}... (第 ${attempt}/${maxRetries} 次尝试)`);

            // 发送给 Background，让它去开 Tab
            chrome.runtime.sendMessage(
            {
                action: "downloadImageViaTab",
                url: url,
            },
            (response) => {
                // 错误处理
                if (chrome.runtime.lastError) {
                console.warn("通信错误:", chrome.runtime.lastError.message);
                resolve(null);
                return;
                }

                if (response && response.success) {
                console.log("✅ Tab 抓取成功!");
                resolve(response.data);
                } else {
                console.warn(
                    "❌ Tab 抓取失败:",
                    response ? response.error : "未知错误"
                );
                resolve(null);
                }
            }
            );
        });

        // 只要返回的不是 null (即成功拿到结果)，直接 return
        if (result) {
            return { status: "success", data: result };
        }

        // 如果没拿到正确结果，且不是最后一次尝试，则等待后重试
        if (attempt < maxRetries) {
            console.log(`⏳ 获取图片数据失败，等待 2 秒后进行第 ${attempt + 1} 次重试...`);
            await new Promise(r => setTimeout(r, intervalMs));
        }
    }

    console.error(`❌ 图片抓取彻底失败，已重试 ${maxRetries} 次。`);
    return { status: "error", data: '图片抓取彻底失败' };
}

/**
 * 确保图片已完全加载且具有真实的宽高
 */
function ensureImageLoaded(img, timeoutMs = 30000) {
    return new Promise((resolve) => {
        // 如果已经加载完成且有尺寸，直接返回
        if (img.complete && img.naturalWidth > 0) return resolve(true);

        const startTime = Date.now();
        const check = () => {
            // 检查是否有有效的 src (排除占位图) 且尺寸大于 0
            const hasValidSrc = img.src && !img.src.includes('data:image/gif;base64') && !img.src.includes('placeholder');
            if (hasValidSrc && img.naturalWidth > 0) {
                resolve(true);
            } else if (Date.now() - startTime > timeoutMs) {
                console.warn("⚠️ 等待图片加载超时 (30s):", img.src);
                resolve(false);
            } else {
                setTimeout(check, 500); // 每 500ms 轮询一次
            }
        };
        
        // 同时也监听事件作为补充
        img.addEventListener('load', () => { if (img.naturalWidth > 0) resolve(true); }, { once: true });
        img.addEventListener('error', () => resolve(false), { once: true });
        
        check();
    });
}

async function getLatestReplyImages(task_id) {
    await new Promise(r => setTimeout(r, 1000)); // 基础缓冲

    const responseBlocks = document.querySelectorAll('message-content');
    if (responseBlocks.length === 0){
        const container = document.querySelectorAll("response-container");
        if (container.length === 0) {
            console.log("触发限制，请检查提示词");
            return { status: 'error', data: 'show-触发限制，请检查提示词' };
        }
        console.log("未找到回答");
        return { status: 'error', data: '未找到回答' };
    } 

    const lastBlock = responseBlocks[responseBlocks.length - 1];
    
    // 1. 获取图片
    const originalImages = lastBlock.querySelectorAll('img');
    const textContent = lastBlock.textContent ? lastBlock.textContent : "";
    // 如果没有图片，直接返回包含文本的错误对象
    if (originalImages.length === 0) {
        return { status: 'error', data: 'show-'+textContent };
    }
    console.log(`🖼️ 检测到 ${originalImages.length} 张图片`);
    
    // 确保图片加载完成（为了获取 naturalWidth/Height）
    await Promise.all(Array.from(originalImages).map(img => ensureImageLoaded(img)));
    
    // 2. 并发处理图片转换
    // 使用 map 返回 Promise，最后由 Promise.all 统一收集结果
    const processingPromises = Array.from(originalImages).map(async (img) => {
        const w = img.naturalWidth;
        const h = img.naturalHeight;

        // --- 过滤逻辑 (示例) ---
        // if (w < 200 || h < 200) return null; 
        
        const bestUrl = getHighestResUrl(img);
        
        console.log(`⚡ 正在从显存提取图片: ${w}x${h}  ${bestUrl}`);
        
        try {
            // 假设 imageUrlToBase64 是你外部定义的函数
            const base64 = await imageUrlToBase64(bestUrl);
            if (base64.status === 'error') {
                console.warn("❌ 图片转码失败");
                return null;
            }else{
                console.log("✅ 图片转码成功!");
            }
            return base64.data; // 直接返回结果，如果是失败或过滤掉的，返回 null/undefined
        } catch (e) {
            console.warn("❌ 图片转码异常", e);
            return null;
        }
    });

    // 等待所有转换完成
    const results = await Promise.all(processingPromises);

    if (results.length === 0) {
        return { status: 'error', data: 'show-图片生成失败，请重试。' };
    }else{
      // 3. 过滤掉失败的(null)或未定义的项，得到纯净的 base64 数组
      const validBase64Images = results.filter((item) => item);

      return { status: "success", data: validBase64Images,message: 'show-'+textContent };
    }
}

async function downloadImage(task_id) {
    console.log("开始下载图片...");
    await new Promise(r => setTimeout(r, 1000)); // 基础缓冲

    const responseBlocks = document.querySelectorAll('message-content');
    if (responseBlocks.length === 0) return "未找到回答";

    const lastBlock = responseBlocks[responseBlocks.length - 1];
    
    // 1. 获取原始 DOM 中的图片
    const originalImages = lastBlock.querySelectorAll('img');
    
    if (originalImages.length > 0) {
        console.log(`🖼️ 检测到 ${originalImages.length} 张图片`);
        
        // 为了不破坏页面显示，我们操作克隆节点
        const cloneBlock = lastBlock.cloneNode(true);
        const cloneImages = cloneBlock.querySelectorAll('img');

        // 查找下载按钮 (Gemini 的下载按钮通常有这个 data-test-id)
        const sendBtn = lastBlock.querySelector('button[data-test-id="download-generated-image-button"]');
    
        if (sendBtn) {
            console.log("🖱️ 找到下载按钮，准备点击...");

            // ==========================================
            // 核心填空部分：监听并获取
            // ==========================================
            try {
                // 1. 告诉 Background: "我要点按钮了，注意拦截！"
                // 我们构建一个 Promise 来等待 Background 的反馈
                const interceptPromise = new Promise((resolve, reject) => {
                    chrome.runtime.sendMessage({ action: "prepare_intercept" ,task_id: task_id}, (response) => {
                        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
                        if (response && response.success) {
                            resolve(response.data); // 拿到了 Base64
                        } else {
                            reject(new Error(response ? response.error : "Unknown error"));
                        }
                    });
                });
                
                await new Promise(r => setTimeout(r, 1000)); // 基础缓冲

                // 2. 触发点击 (这会触发浏览器的下载事件，被 Background 捕获)
                sendBtn.click();
                console.log("🚀 发送按钮已点击，等待拦截数据...");
            } catch (error) {
                console.error("❌ 拦截下载失败:", error);
                // 失败了不要紧，代码继续往下走，返回原始的缩略图 HTML 也是可以接受的
            }

        } else {
            // throw new Error("找不到发送按钮"); 
            // 建议改为 warn，因为有时候 Gemini 可能没生成完按钮，或者被风控
            console.warn("⚠️ 找不到下载按钮，将使用原始预览图");
        }
        
        // 返回处理过的（包含 Base64 的）HTML
        return cloneBlock.innerHTML;
    }
    
    return lastBlock.innerHTML;
}


/**
 * 视频专用下载逻辑
 */
async function downloadVideo(task_id) {
    console.log("开始触发视频下载...");
    await new Promise(r => setTimeout(r, 1000)); // 基础缓冲

    const responseBlocks = document.querySelectorAll('message-content');
    if (responseBlocks.length === 0) return "未找到回答";

    const lastBlock = responseBlocks[responseBlocks.length - 1];
    
    // 查找包含“下载视频”属性的按钮
    const downloadBtn = lastBlock.querySelector('button[aria-label="下载视频"]') || 
                        lastBlock.querySelector('button[aria-label="Download video"]');
                        
    if (downloadBtn) {
        console.log("🖱️ 找到'下载视频'按钮，准备触发拦截...");

        try {
            const interceptPromise = new Promise((resolve, reject) => {
                chrome.runtime.sendMessage({ 
                    action: "prepare_intercept",
                    task_id: task_id,
                    task_action: "generate_video" 
                }, (response) => {
                    if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
                    if (response && response.success) {
                        resolve(response.data);
                    } else {
                        reject(new Error(response ? response.error : "Unknown error"));
                    }
                });
            });
            
            await new Promise(r => setTimeout(r, 1000)); 

            // 触发点击
            downloadBtn.click();
            console.log("🚀 '下载视频'已点击，由 Background 处理文件...");
        } catch (error) {
            console.error("❌ 拦截下载失败:", error);
        }
    } else {
        console.warn("⚠️ 页面未找到'下载视频'按钮");
    }
}

// ==========================================
// 4. 动作执行 (粘贴、发送)
// ==========================================

const MIME_EXTENSION_MAP = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg',
    'image/avif': 'avif',
    'image/heic': 'heic'
};

function extractMimeFromBase64(base64Str) {
    if (typeof base64Str !== 'string') return null;
    const match = base64Str.match(/^data:([^;]+);base64,/i);
    return match ? match[1].toLowerCase() : null;
}

function normalizeFilenameWithExtension(nameHint, extension) {
    let baseName = 'image';
    if (typeof nameHint === 'string' && nameHint.trim()) {
        baseName = nameHint.trim();
        const queryIndex = baseName.search(/[?#]/);
        if (queryIndex !== -1) baseName = baseName.slice(0, queryIndex);
        baseName = baseName.replace(/\.[^/.]+$/, '');
        if (!baseName.trim()) baseName = 'image';
    }
    return `${baseName}.${extension}`;
}

function inferImageFileInfo(base64Str, nameHint) {
    const mimeFromData = extractMimeFromBase64(base64Str);
    let extension = null;

    if (mimeFromData && MIME_EXTENSION_MAP[mimeFromData]) {
        extension = MIME_EXTENSION_MAP[mimeFromData];
    } else if (mimeFromData && mimeFromData.includes('/')) {
        extension = mimeFromData.split('/').pop();
    }

    if (!extension && typeof nameHint === 'string') {
        const extMatch = nameHint.match(/\.([a-z0-9]+)$/i);
        if (extMatch && extMatch[1]) {
            extension = extMatch[1].toLowerCase();
        }
    }

    if (!extension) extension = 'png';
    if (extension === 'jpeg') extension = 'jpg';

    let mimeType = mimeFromData;
    if (!mimeType) {
        mimeType = extension === 'jpg' ? 'image/jpeg' : `image/${extension}`;
    } else if (mimeType === 'image/jpg') {
        mimeType = 'image/jpeg';
    }

    const filename = normalizeFilenameWithExtension(nameHint, extension);
    return { mimeType, filename };
}

async function pasteImage(base64Str,name="image1.png") {
    console.log("📋 准备模拟粘贴图片...");

    // 尝试重新获取输入框，防止 DOM 刷新导致元素失效
    const inputBox = document.querySelector('div[contenteditable="true"]') || 
                     document.querySelector('rich-textarea div[role="textbox"]');

    if (!inputBox) throw new Error("找不到输入框");

    const { mimeType, filename } = inferImageFileInfo(base64Str, name);

    console.log("🚀 图片信息:", mimeType, filename);

    // 转换文件
    const file = base64ToFile(base64Str, filename, mimeType);
    const dt = new DataTransfer();
    dt.items.add(file);

    // 强制聚焦流程
    inputBox.blur(); // 先失焦
    await new Promise(r => setTimeout(r, 100)); // 微小停顿
    inputBox.focus(); // 再聚焦
    await new Promise(r => setTimeout(r, 300)); // 等待聚焦动画完成

    // 发送粘贴事件
    const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt
    });
    
    inputBox.dispatchEvent(pasteEvent);
    console.log("📋 粘贴事件已触发");
}


async function sendPrompt(text) {
    console.log("📝 输入文字并发送...");
    const inputBox = document.querySelector('div[contenteditable="true"]') || 
                     document.querySelector('rich-textarea div[role="textbox"]');
    
    inputBox.focus();
    document.execCommand('insertText', false, text); 
    
    await new Promise(r => setTimeout(r, 500)); // UI 缓冲

    const sendBtn = document.querySelector('button[aria-label="Send"]') || 
                    document.querySelector('button[aria-label="发送"]');
    
    if (sendBtn) {
        sendBtn.click();
        console.log("🚀 发送按钮已点击");
    } else {
        throw new Error("找不到发送按钮");
    }
}

async function createNewChat(action, modelName) {
    console.log(`📝 开启新对话 (动作: ${action}, 模型: ${modelName || '默认 Pro'})`);
    
    await new Promise(r => setTimeout(r, 500)); // UI 缓冲

    const sendBtn = document.querySelector('button[aria-label*="New chat"]') || 
                    document.querySelector('button[aria-label*="发起新对话"]') ||   document.querySelector('a[aria-label*="发起新对话"]');
    
    if (sendBtn) {
        sendBtn.click();
        console.log("🚀 开启新对话已点击");

        // 查找class中有"toolbox-drawer-button"的元素进行点击
        await new Promise(r => setTimeout(r, 1000));
        
        // 只有 generate_image 和 generate_video 才去点击左下角的菜单
        if (action === "generate_image" || action === "generate_video") {
            let toolboxBtn = document.querySelector(".toolbox-drawer-button");  
            if (!toolboxBtn) {
               toolboxBtn = document.querySelector('button[aria-label="打开输入区域菜单，以选择工具和上传内容类型"]');
            }
            if (toolboxBtn) {
                toolboxBtn.click();
                console.log("🚀 工具箱按钮已点击");
                 // 查找class中有"cdk-overlay-pane"的div 中 button 的文本进行点击
                await new Promise(r => setTimeout(r, 1000));
                const overlayPanes = document.querySelectorAll('.cdk-overlay-pane');
                let foundImageBtn = false;
                
                // 动态设定需要查找的按钮文本
                const targetBtnText = action === "generate_video" ? "视频" : "图片";
                
                for (const pane of overlayPanes) {
                    const buttons = pane.querySelectorAll('button');
                    for (const btn of buttons) {
                        if (btn.textContent.includes(targetBtnText)) {
                            btn.click();
                            console.log(`🚀 '${targetBtnText}'按钮已点击`);
                            foundImageBtn = true;
                            break;
                        }
                    }
                    if (foundImageBtn) break;
                }
                if (!foundImageBtn) console.warn(`⚠️ 未找到'${targetBtnText}'按钮`);
                
            } else {
                console.warn("⚠️ 未找到工具箱按钮");
            }
            await new Promise(r => setTimeout(r, 1000));
        }

        // 切换模式逻辑 (通用)
        let modeBtn = document.querySelector('div[aria-label*="打开模式选择器"]') 
        if (!modeBtn) {
            modeBtn = document.querySelector('button[aria-label*="打开模式选择器"]') 
        }

        if (modeBtn) {
            modeBtn.click();
            console.log("🚀 模式选择已点击");

            await new Promise(r => setTimeout(r, 1000));
            
            const menuContents = document.querySelectorAll('.mat-mdc-menu-content');
            let foundTargetBtn = false;
            let quantityLimitReached = false;
            
            // 如果服务端没传模型名字，或者传的是错的，默认尝试 Pro
            const targetModel = (modelName && modelName.trim() !== '') ? modelName : "Pro";

            // 1. 尝试寻找目标模型
            for (const content of menuContents) {
                const buttons = content.querySelectorAll('button');
                for (const btn of buttons) {
                    if (btn.textContent && btn.textContent.includes(targetModel)) {
                        // 检查用量限额
                        const hasLimitText = btn.textContent.includes("用量限额");
                        const hasLimitDiv = btn.querySelector('.main-text.gds-body-m') && btn.querySelector('.main-text.gds-body-m').textContent.includes("数量上限");
                        
                        if(hasLimitText || hasLimitDiv) {
                            console.warn(`⚠️ [5/5] ${targetModel} 模式用量限额/数量上限`);
                            quantityLimitReached = true;
                            break; // 触发外层降级逻辑
                        } else {
                            btn.click();
                            console.log(`🚀 [5/5] 已切换至 ${targetModel} 模式`);
                            foundTargetBtn = true;
                            break;
                        }
                    }
                }
                if (foundTargetBtn || quantityLimitReached) break;
            }

            // 特殊处理：如果是 generate_video，且遇到限额或者找不到模型，直接抛出错误，不降级
            if (action === "generate_video" && !foundTargetBtn) {
                const reason = quantityLimitReached ? "该模型数量上限" : "未找到指定的模型";
                throw new Error(`视频生成模式选择失败: ${reason}`);
            }

            // 2. 降级逻辑：(仅非视频模式，或视频模式未配置上述阻断时，其实上一步已经抛出错误了)
            // 如果没有找到目标模型（或者限额了），尝试寻找“思考”
            if (!foundTargetBtn && targetModel !== "思考") {
                console.log("⚠️ 准备降级至 '思考' 模式...");
                for (const content of menuContents) {
                    const buttons = content.querySelectorAll('button');
                    for (const btn of buttons) {
                        if (btn.textContent && btn.textContent.includes("思考")) {
                            if(btn.textContent.includes("用量限额") || (btn.querySelector('.main-text.gds-body-m') && btn.querySelector('.main-text.gds-body-m').textContent.includes("数量上限"))){
                                console.warn("⚠️ [5/5] '思考' 模式用量限额 (全部限额了)");
                                break;
                            } else {
                                btn.click();
                                console.log("🚀 [5/5] 降级成功，已切换至 '思考' 模式");
                                foundTargetBtn = true;
                                break;
                            }
                        }
                    }
                    if (foundTargetBtn) break;
                }
            }

            if (!foundTargetBtn) console.warn(`⚠️ [5/5] 模式切换失败: 未找到任何可用模型`);
        } else {
            console.warn("⚠️ 未找到模式按钮");
        }
       
    } else {
        throw new Error("找不到开启新对话");
    }
}

// ==========================================
// 5. 流程编排 (测试入口)
// ==========================================

async function typeAndSend(text = "根据图片，生成一张有年代感的图片", task_id = 0, image=[], is_continue = false, action = "generate_image", model = "Pro") {
    const log = document.getElementById('status-log');
    if(log) log.innerText = `🚀 任务启动: ${task_id} (${action})`;
    let urlId = null;
    try {
        // ==========================================
        // 1. 完整流程 (解开注释)
        // ==========================================
        // Step 1: 开启上传监听 (确保你注入了 injected.js 并能触发事件)
        console.log(`1/5 创建新聊天窗口... [Action: ${action}, Model: ${model}]`);
        if(log) log.innerText = "1/5 创建新聊天窗口...";
        await createNewChat(action, model);
        await new Promise(r => setTimeout(r, 2000));
        
        // if(!is_continue) {
        //     console.log("1/5 创建新聊天窗口...");
        //     if(log) log.innerText = "1/5 创建新聊天窗口...";
        //     await createNewChat();
        //     await new Promise(r => setTimeout(r, 2000));
        // }
        //查找 aria-label="同意（关闭对话框并同意免责声明）" 的button 并且点击


       
        if (image) {
            console.log("一共上传的图片数量: " + image.length + "张");
            for (let i = 0; i < image.length; i++) {
                console.log("⏳ [2/5] 正在处理第 " + (i + 1) + " 张图片...");
                if (log) log.innerText = "正在上传第 " + (i + 1) + "/" + image.length + " 张...";
        
                // 1. 先创建监听 Promise (这步顺序是对的，要在动作发生前监听)
                const uploadPromise = waitForUploadSuccess(); 
        
                // 2. 执行粘贴
                // 【建议】粘贴前也加一个小缓冲，确保输入框是聚焦的
                await new Promise(r => setTimeout(r, 1000)); 
                console.log('image '+(i+1)+".png粘贴图片...");
                await pasteImage(image[i],'image '+(i+1)+".png"); 
                //间隔1秒 执行
                const uploadTimer = setInterval(function(){
                    const agreeButton = document.querySelector('button[aria-label="同意（关闭对话框并同意免责声明）"]');
                    if (agreeButton) {
                        agreeButton.click();
                        console.log("点击了同意按钮");
                    } else {
                        console.log("未找到同意按钮");
                    }
                },1000)
                

                // 3. 等待上传信号
                const isUploaded = await uploadPromise;
                if (!isUploaded) throw new Error("第 " + (i+1) + " 张图片上传超时");
                clearInterval(uploadTimer);


                console.log("✅ 第 " + (i + 1) + " 张上传完毕");
        
                // ============================================================
                // 核心修复：这里必须加延迟！
                // 给 Gemini UI 一点时间来渲染缩略图并重置输入框状态
                // ============================================================
                if (i < image.length - 1) { // 如果不是最后一张，就需要等待
                    console.log("💤 冷却 1 秒，等待 UI 恢复...");
                    await new Promise(r => setTimeout(r, 1000)); 
                }
            }
        }
        // return {status: "success", message: "任务完成"};
        // Step 5: 发送文字
        console.log("2/5 正在发送...");
        if(log) log.innerText = "2/5 正在发送...";

        // 额外缓冲：Gemini 前端渲染缩略图需要时间
        await new Promise(r => setTimeout(r, 5000));
        await sendPrompt(text);

        // Step 6: 等待回答
        console.log(`3/5 等待回答... [Action: ${action}]`);
        if(log) log.innerText = "3/5 等待回答...";
        
        // 缓冲：让 Stop 按钮先出现
        await new Promise(r => setTimeout(r, 3000));
        
        let is_finnal = false;
        
        let return_data = null;
        let return_message = null;

        if (action === "generate_video") {
            // 视频需要使用超长、定制的监控逻辑 (15分钟)
            const videoResult = await waitForVideoReady(900000); 
            
            if (videoResult.status === 'error') {
                throw new Error(videoResult.data || "生成视频失败"); // 直接抛出错误文字
            } else if (videoResult.status === 'timeout') {
                throw new Error("任务超时 (视频生成等待超过 15 分钟)");
            } else if (videoResult.status === 'success') {
                is_finnal = true;
                return_data = videoResult.data; // 保存 URL ID
            }
        } else {
            // 图片和文本使用常规监听 (3分钟)
            is_finnal = await waitForReplyComplete(); 
        }

        const currentUrl = window.location.href;
        const appMatch = currentUrl.match(/\/app\/([a-zA-Z0-9]+)/);
        if (appMatch && appMatch[1]) {
           urlId = appMatch[1];
           console.log(`🔗 提取到对话 URL ID: ${urlId}`);
        }
        if (!is_finnal) throw new Error("任务超时 (生成等待失败)");

        // ==========================================
        // 2. 抓取结果
        // ==========================================
        console.log("4/5 处理结果...");
        if(log) log.innerText = "4/5 处理结果...";
        
        if (action === "generate_image") {
            // 获取图片处理 (保持原有逻辑)
            imageResult = await getLatestReplyImages(task_id);
            if (imageResult.status === "error") {
                throw new Error(imageResult.data || "show-生成图片失败,请重试。"); // 直接抛出错误文字
            } else if (imageResult.status === "success") {
                return_data = imageResult.data;
                return_message = imageResult.message;
                console.log("🎉 任务完成！提取了图片:", imageResult.data ? imageResult.data.length : 0, "张");
            }
        } else if (action === "generate_text") {
            // 文本处理：获取最后一条消息的 HTML
            await new Promise(r => setTimeout(r, 1000)); // 基础缓冲
            const responseBlocks = document.querySelectorAll('message-content');
            if (responseBlocks.length > 0) {
                 const lastBlock = responseBlocks[responseBlocks.length - 1];
                 return_data = lastBlock.innerHTML;
            } else {
                throw new Error("获取回复数据为空或出错");
            }
            console.log("🎉 任务完成！提取了文本/HTML");
        } else if (action === "generate_video") {
            // 视频处理：获取最后一条消息的内容
            console.log("🎉 任务完成！...等待下载");
        }

        // ==========================================
        // 3. 发送成功消息给 Background
        // ==========================================
        await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
              {
                action: "task_completed",
                data: return_data,
                task_id: task_id,
                message: return_message,
                task_action: action, // 告诉 background 当前是什么任务
                url_id: urlId, // 携带提取到的 URL ID
                error: null, // 明确表示没有错误
              },
              (response) => {
                if (chrome.runtime.lastError) {
                  console.warn("通信错误:", chrome.runtime.lastError.message);
                  // 通信错误通常不影响 Python 接收（只要 bg 没死），resolve 即可
                  resolve();
                } else {
                  console.log("✅ Background 已确认收到数据");
                  resolve();
                }
              }
            );
        });
        
        if(log) log.innerText = "✅ 完成! 任务ID: " + task_id;
        
        // 如果是生成图片，且包含原有下载逻辑，则执行下载
        if (action === "generate_image") {
             downloadImage(task_id); 
        } else if (action === "generate_video") {
             downloadVideo(task_id);
        }
    } catch (err) {
        console.error("❌ 任务失败:", err);
        if(log) log.innerText = "❌ 错误: " + err.message;

        // ==========================================
        // 4. 发送错误消息给 Background (新增)
        // ==========================================
        // 即使失败，也要告诉 Python 解锁 task_id
        chrome.runtime.sendMessage({ 
            action: "task_completed", 
            data: null,
            message: null,
            task_id: task_id,
            task_action: action, 
            url_id: urlId, // 携带提取到的 URL ID
            error: err.message
        });
    }
}

async function typeAndSendTest() {

    console.log("📝 开启新对话");
    
    await new Promise(r => setTimeout(r, 500)); // UI 缓冲

    const sendBtn = document.querySelector('button[aria-label*="New chat"]') || 
                    document.querySelector('button[aria-label*="发起新对话"]') ||   document.querySelector('a[aria-label*="发起新对话"]');
    
    if (sendBtn) {
        sendBtn.click();
        const theAction = "generate_image"; // 或者修改为您想要的默认测试动作
        const theModel = "Pro";
        
        console.log(`🚀 开启新对话已点击 [测试动作: ${theAction}, 测试模型: ${theModel}]`);

        // 查找class中有"toolbox-drawer-button"的元素进行点击
        await new Promise(r => setTimeout(r, 1000));
        
        if (theAction === "generate_image" || theAction === "generate_video") {
             let toolboxBtn = document.querySelector(".toolbox-drawer-button");  
            if (!toolboxBtn) {
               toolboxBtn = document.querySelector('button[aria-label="打开输入区域菜单，以选择工具和上传内容类型"]');
            }
            if (toolboxBtn) {
                toolboxBtn.click();
                console.log("🚀 工具箱按钮已点击");
                 // 查找class中有"cdk-overlay-pane"的div 中 button 的文本进行点击
                await new Promise(r => setTimeout(r, 1000));
                const overlayPanes = document.querySelectorAll('.cdk-overlay-pane');
                let foundImageBtn = false;
                
                // 动态设定需要查找的按钮文本
                const targetBtnText = theAction === "generate_video" ? "视频" : "图片";
                
                for (const pane of overlayPanes) {
                    const buttons = pane.querySelectorAll('button');
                    for (const btn of buttons) {
                        if (btn.textContent.includes(targetBtnText)) {
                            btn.click();
                            console.log(`🚀 '${targetBtnText}'按钮已点击`);
                            foundImageBtn = true;
                            break;
                        }
                    }
                    if (foundImageBtn) break;
                }
                if (!foundImageBtn) console.warn(`⚠️ 未找到'${targetBtnText}'按钮`);
                
            } else {
                console.warn("⚠️ 未找到工具箱按钮"); 
            }
            await new Promise(r => setTimeout(r, 1000));
        }
        // 切换模式逻辑 (通用)
        let modeBtn = document.querySelector('div[aria-label*="打开模式选择器"]') 
        if (!modeBtn) {
            modeBtn = document.querySelector('button[aria-label*="打开模式选择器"]') 
        }

        if (modeBtn) {
            modeBtn.click();
            console.log("🚀 模式选择已点击");

            await new Promise(r => setTimeout(r, 1000));
            
            const menuContents = document.querySelectorAll('.mat-mdc-menu-content');
            let foundTargetBtn = false;
            let quantityLimitReached = false;
            
            const targetModel = (theModel && theModel.trim() !== '') ? theModel : "Pro";

            // 1. 尝试寻找目标模型
            for (const content of menuContents) {
                const buttons = content.querySelectorAll('button');
                for (const btn of buttons) {
                    if (btn.textContent && btn.textContent.includes(targetModel)) {
                        // 检查用量限额
                        const hasLimitText = btn.textContent.includes("用量限额");
                        const hasLimitDiv = btn.querySelector('.main-text.gds-body-m') && btn.querySelector('.main-text.gds-body-m').textContent.includes("数量上限");
                        
                        if(hasLimitText || hasLimitDiv) {
                            console.warn(`⚠️ [5/5] ${targetModel} 模式用量限额/数量上限`);
                            quantityLimitReached = true;
                            break; 
                        } else {
                            btn.click();
                            console.log(`🚀 [5/5] 已切换至 ${targetModel} 模式`);
                            foundTargetBtn = true;
                            break;
                        }
                    }
                }
                if (foundTargetBtn || quantityLimitReached) break;
            }

            // 特殊处理：如果是 generate_video，且遇到限额或者找不到模型，直接抛出错误，不降级
            if (theAction === "generate_video" && !foundTargetBtn) {
                const reason = quantityLimitReached ? "该模型数量上限" : "未找到指定的模型";
                throw new Error(`视频生成模式选择失败: ${reason}`);
            }

            // 2. 降级逻辑：如果没有找到目标模型（或者限额了），尝试寻找“思考”
            if (!foundTargetBtn && targetModel !== "思考") {
                console.log("⚠️ 准备降级至 '思考' 模式...");
                for (const content of menuContents) {
                    const buttons = content.querySelectorAll('button');
                    for (const btn of buttons) {
                        if (btn.textContent && btn.textContent.includes("思考")) {
                            if(btn.textContent.includes("用量限额") || (btn.querySelector('.main-text.gds-body-m') && btn.querySelector('.main-text.gds-body-m').textContent.includes("数量上限"))){
                                console.warn("⚠️ [5/5] '思考' 模式用量限额 (全部限额了)");
                                break;
                            } else {
                                btn.click();
                                console.log("🚀 [5/5] 降级成功，已切换至 '思考' 模式");
                                foundTargetBtn = true;
                                break;
                            }
                        }
                    }
                    if (foundTargetBtn) break;
                }
            }

            if (!foundTargetBtn) console.warn(`⚠️ [5/5] 模式切换失败: 未找到任何可用模型`);
        } else {
            console.warn("⚠️ 未找到模式按钮");
        }
       
       
    } else {
        throw new Error("找不到开启新对话");
    }

    console.log("📝 开启新对话");
}

chrome.runtime.onMessage.addListener(async (request, sender, sendResponse) => {
    if (request.action === "type_and_send") {
        console.log("⌨️ [Content] 收到输入任务:", request.text);
        console.log("⌨️ [Content] 收到任务ID:", request.task_id);
        console.log("⌨️ [Content] 收到任务类型:", request.task_action, "模型:", request.task_model);
        await typeAndSend(request.text, request.task_id, request.image, request.is_continue, request.task_action, request.task_model);
        sendResponse({ success: true });
    }
});


// ==========================================
// 6. UI 控制面板
// ==========================================
function createPanel() {
    const div = document.createElement('div');
    div.innerHTML = `
        <div style="position:fixed; bottom:80px; left:20px; z-index:99999; background:#202124; padding:15px; border-radius:8px; border:1px solid #5f6368; color:white; font-family:sans-serif; width:220px; box-shadow:0 4px 12px rgba(0,0,0,0.5);">
            <h3 style="margin:0 0 10psx 0; font-size:14px; color:#e8eaed;">Gemini 全自动机器人</h3>
            <div id="status-log" style="margin-top:10px; font-size:12px; color:#9aa0a6;">就绪</div>
        </div>
    `;
    document.body.appendChild(div);
}


function createPanel() {
    const div = document.createElement('div');
    div.innerHTML = `
        <div style="position:fixed; bottom:80px; left:20px; z-index:99999; background:#202124; padding:15px; border-radius:8px; border:1px solid #5f6368; color:white; font-family:sans-serif; width:220px; box-shadow:0 4px 12px rgba(0,0,0,0.5);">
            <h3 style="margin:0 0 10psx 0; font-size:14px; color:#e8eaed;">Gemini 全自动机器人</h3>
            <button id="btn-test" style="width:100%; padding:8px; background:#8ab4f8; border:none; border-radius:4px; cursor:pointer; color:#202124; font-weight:bold;">⚡ 运行全流程测试</button>
           
            <div id="status-log" style="margin-top:10px; font-size:12px; color:#9aa0a6;">就绪</div>
        </div>
    `;
    document.body.appendChild(div);
    document.getElementById('btn-test').onclick = typeAndSendTest;
}

// 启动面板
setTimeout(createPanel, 2000);
