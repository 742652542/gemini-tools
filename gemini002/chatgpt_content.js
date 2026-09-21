console.log('[ChatGPT Bot] Content Script Loaded');

let uploadRequestCompletedCount = 0;
let uploadRequestLastDetail = null;
let imageReplyFailureText = '';
let libraryDeleteRequestStartedCount = 0;
let libraryDeleteRequestCompletedCount = 0;
let libraryDeleteRequestActiveCount = 0;
let libraryDeleteRequestFailedCount = 0;
let libraryDeleteRequestLastFailureStatus = 0;
let libraryCleanupRunning = false;

const CHATGPT_LIBRARY_URL = 'https://chatgpt.com/library?tab=all';
const LIBRARY_CLEANUP_STORAGE_KEY = 'chatgpt_library_cleanup_active';
const LIBRARY_CLEANUP_RELOAD_COUNT_KEY = 'chatgpt_library_cleanup_reload_count';

const injectedScript = document.createElement('script');
injectedScript.src = chrome.runtime.getURL('chatgpt_injected.js');
injectedScript.onload = function() {
  this.remove();
};
(document.head || document.documentElement).appendChild(injectedScript);

window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data) {
    return;
  }

  if (event.data.type === 'CHATGPT_UPLOAD_COMPLETE') {
    uploadRequestCompletedCount += 1;
    uploadRequestLastDetail = event.data;
    console.log('✅ 收到上传成功消息', event.data);
    return;
  }

  if (event.data.type === 'CHATGPT_LIBRARY_DELETE_BATCH') {
    if (event.data.phase === 'start') {
      libraryDeleteRequestStartedCount += 1;
      libraryDeleteRequestActiveCount += 1;
    } else if (event.data.phase === 'complete') {
      libraryDeleteRequestCompletedCount += 1;
      libraryDeleteRequestActiveCount = Math.max(0, libraryDeleteRequestActiveCount - 1);
      if (event.data.status < 200 || event.data.status >= 300) {
        libraryDeleteRequestFailedCount += 1;
        libraryDeleteRequestLastFailureStatus = event.data.status;
      }
    }
    console.log('🗂️ 资料库批量删除请求状态', event.data, {
      started: libraryDeleteRequestStartedCount,
      completed: libraryDeleteRequestCompletedCount,
      active: libraryDeleteRequestActiveCount
    });
  }
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function triggerElementClick(element) {
  if (!element) return false;

  try {
    element.scrollIntoView({ block: 'center', inline: 'center' });
  } catch (err) {}

  try {
    element.focus();
  } catch (err) {}

  const mouseEvents = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
  mouseEvents.forEach((eventName) => {
    try {
      element.dispatchEvent(
        new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window
        })
      );
    } catch (err) {}
  });

  try {
    element.click();
  } catch (err) {}

  return true;
}

function getPromptInput() {
  return document.querySelector('#prompt-textarea') || document.querySelector('div[contenteditable="true"]');
}

async function ensureChatInterfaceSelected(targetSurface = 'chat', timeoutMs = 5000) {
  console.log('开始切换工作模式!')
  const normalizedTarget = targetSurface === 'work' ? 'work' : 'chat';
  const strictMode = normalizedTarget === 'work';
  const targetLabels = normalizedTarget === 'work' ? ['工作', 'work'] : ['聊天', 'chat'];
  const targetName = normalizedTarget === 'work' ? '工作/Work' : '聊天/Chat';
  const start = Date.now();
  let foundTargetButton = false;

  while (Date.now() - start < timeoutMs) {
    const group = document.querySelector('[role="radiogroup"]');
    if (!group) {
      await sleep(200);
      continue;
    }

    const radios = Array.from(group.querySelectorAll('button[role="radio"]'));
    const targetButton = radios.find((button) => {
      const text = (button.textContent || '').replace(/\s+/g, '').trim().toLowerCase();
      return targetLabels.includes(text);
    });

    if (!targetButton) {
      throw new Error(`找不到 ChatGPT ${targetName} 界面选项`);
    }
    foundTargetButton = true;

    if (targetButton.getAttribute('aria-checked') === 'true' || targetButton.getAttribute('data-state') === 'on') {
      console.log(`✅ ChatGPT 当前已选择${targetName}界面`);
      return true;
    }

    console.log(`🔁 ChatGPT 当前不是${targetName}界面，准备切换`);
    triggerElementClick(targetButton);
    await sleep(500);
  }

  if (strictMode) {
    throw new Error(foundTargetButton ? `ChatGPT ${targetName} 界面切换失败` : `未检测到 ChatGPT ${targetName} 界面切换器`);
  }

  console.warn('⚠️ 未检测到 ChatGPT 聊天/工作切换器，继续执行任务');
  return false;
}

function getUploadPreviewCount() {
  const selectors = [
    'button[aria-label*="Remove attachment"]',
    'button[aria-label*="删除附件"]',
    'button[aria-label*="Remove image"]',
    'button[aria-label*="删除图片"]',
    '[data-testid*="attachment"]',
    'img[src^="blob:"]'
  ];

  const elements = new Set();
  selectors.forEach((selector) => {
    document.querySelectorAll(selector).forEach((element) => elements.add(element));
  });

  return elements.size;
}

function hasUploadingIndicator() {
  const selectors = [
    '[data-testid*="loading"]',
    '[aria-label*="Uploading"]',
    '[aria-label*="上传"]',
    'svg.animate-spin',
    '.animate-spin'
  ];

  return selectors.some((selector) => document.querySelector(selector));
}

function waitForUploadSuccess(previousCount = 0, timeoutMs = 60000) {
  return new Promise((resolve) => {
    console.log('⏳ 开始监听 ChatGPT 图片上传状态...');
    const initialCompletedCount = uploadRequestCompletedCount;

    const cleanup = () => {
      observer.disconnect();
      clearTimeout(timer);
      window.removeEventListener('CHATGPT_UPLOAD_COMPLETE', requestHandler);
    };

    const finish = (success) => {
      cleanup();
      resolve(success);
    };

    const requestHandler = (event) => {
      const detail = event && event.detail ? event.detail : {};
      const currentCount = getUploadPreviewCount();
      const uploadCompleted = currentCount > previousCount && !hasUploadingIndicator();

      if (!uploadCompleted) {
        console.warn('⚠️ 已收到 PUT 201，但页面附件预览尚未就绪');
      }

      console.log('✅ 捕获到上传请求完成事件', detail);
      finish(true);
    };

    const check = () => {
      if (uploadRequestCompletedCount > initialCompletedCount) {
        const currentCount = getUploadPreviewCount();
        const uploadCompleted = currentCount > previousCount && !hasUploadingIndicator();
        if (!uploadCompleted) {
          console.warn('⚠️ 根据 PUT 201 判定成功，但 DOM 复查未通过，仍按上传成功处理');
        }
        console.log('✅ 根据 PUT 201 判定图片上传完成', uploadRequestLastDetail || {});
        finish(true);
      }
    };

    const observer = new MutationObserver(() => {
      check();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true
    });

    window.addEventListener('CHATGPT_UPLOAD_COMPLETE', requestHandler);

    const timer = setTimeout(() => {
      console.error('❌ 等待 PUT 201 超时，判定上传失败');
      finish(false);
    }, timeoutMs);

    check();
  });
}

function base64ToFile(base64Data, filename, mimeType) {
  const cleanBase64 = base64Data.includes(',') ? base64Data.split(',')[1] : base64Data;
  const byteCharacters = atob(cleanBase64);
  const byteArrays = [];

  for (let offset = 0; offset < byteCharacters.length; offset += 512) {
    const slice = byteCharacters.slice(offset, offset + 512);
    const byteNumbers = new Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
      byteNumbers[i] = slice.charCodeAt(i);
    }
    byteArrays.push(new Uint8Array(byteNumbers));
  }

  return new File([new Blob(byteArrays, { type: mimeType })], filename, { type: mimeType });
}

function extractMimeFromBase64(base64Str) {
  if (typeof base64Str !== 'string') return null;
  const match = base64Str.match(/^data:([^;]+);base64,/i);
  return match ? match[1].toLowerCase() : 'image/png';
}

async function pasteImage(base64Str, name = 'image.png') {
  console.log('📋 准备向 ChatGPT 粘贴图片...');

  const inputBox = getPromptInput();
  if (!inputBox) throw new Error('找不到 ChatGPT 输入框');

  const mimeType = extractMimeFromBase64(base64Str);
  const previousCount = getUploadPreviewCount();
  const uploadPromise = waitForUploadSuccess(previousCount);

  const file = base64ToFile(base64Str, name, mimeType);
  const dt = new DataTransfer();
  dt.items.add(file);

  inputBox.focus();
  await sleep(200);

  const pasteEvent = new ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
    clipboardData: dt
  });

  inputBox.dispatchEvent(pasteEvent);
  console.log('📋 粘贴事件已触发，等待上传完成...');

  const uploaded = await uploadPromise;
  if (!uploaded) {
    throw new Error('图片上传超时');
  }

  return true;
}

function getSendButton() {
  return (
    document.querySelector('button[data-testid="send-button"]') ||
    document.querySelector('button[aria-label*="Send prompt"]') ||
    document.querySelector('button[aria-label*="Send message"]') ||
    document.querySelector('button[aria-label*="发送"]')
  );
}

function getStopButton() {
  return (
    document.querySelector('button[data-testid="stop-button"]') ||
    document.querySelector('button[aria-label*="Stop generating"]') ||
    document.querySelector('button[aria-label*="Stop"]') ||
    document.querySelector('button[aria-label*="停止"]')
  );
}

function getAssistantTurnSections() {
  const legacyTurnSelector = 'section[data-testid^="conversation-turn-"][data-turn="assistant"]';
  const turnEntries = document.querySelectorAll(
    `${legacyTurnSelector}, [data-chatgpt-agent-turn-start]`
  );
  const turns = [];
  const seen = new Set();

  turnEntries.forEach((entry) => {
    // 新版页面用隐藏的 agent-turn-start 节点标记 assistant 回复起点；
    // 它的父节点就是当前回复区块。若同时存在旧版 section，仍优先复用旧区块。
    const turn = entry.matches(legacyTurnSelector)
      ? entry
      : entry.closest(legacyTurnSelector) || entry.parentElement;

    if (turn && !seen.has(turn)) {
      seen.add(turn);
      turns.push(turn);
    }
  });

  return turns;
}

function getLatestAssistantTurnSection() {
  const turns = getAssistantTurnSections();
  return turns.length > 0 ? turns[turns.length - 1] : null;
}

function getLatestAssistantTurnSectionMatching(predicate) {
  const turns = getAssistantTurnSections();
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    try {
      if (predicate(turn)) return turn;
    } catch (err) {}
  }
  return null;
}

function isImageGeneratingTurn(turnSection) {
  if (!turnSection) return false;
  return !!(
    turnSection.querySelector('[data-testid="image-gen-loading-state"]') ||
    turnSection.querySelector('[data-testid="image-gen-loading-state-frame"]') ||
    turnSection.querySelector('[data-testid="image-gen-loading-state-headline"]')
  );
}

function isImageReadyTurn(turnSection) {
  if (!turnSection) return false;

  const imageCandidates = getImageCandidatesFromTurn(turnSection);
  return imageCandidates.length > 0 && !isImageGeneratingTurn(turnSection);
}

function normalizeAssistantText(text) {
  if (!text || typeof text !== 'string') return '';

  const normalized = text
    .replace(/\s+/g, ' ')
    .replace(/^ChatGPT\s*[说:：]?\s*/i, '')
    .replace(/^ChatGPT said:?\s*/i, '')
    .trim();

  const meaninglessTexts = new Set([
    '',
    'ChatGPT',
    'ChatGPT 说',
    'ChatGPT 说：',
    'ChatGPT said',
    '复制回复',
    '更多操作'
  ]);

  if (/^Thought for\b/i.test(normalized)) return '';
  if (/^已思考\b/i.test(normalized)) return '';
  if (/^思考了\b/i.test(normalized)) return '';

  return meaninglessTexts.has(normalized) ? '' : normalized;
}

function isImageAnalysisProgressText(text) {
  if (!text || typeof text !== 'string') return false;
  return /正在分析\s*\d*\s*幅图片/.test(text);
}

function getMeaningfulAssistantTextFromTurn(turnSection) {
  if (!turnSection) return '';

  const markdownNode =
    turnSection.querySelector('[data-message-author-role="assistant"] .markdown') ||
    turnSection.querySelector('[data-message-author-role="assistant"]') ||
    turnSection.querySelector('.markdown');

  if (markdownNode) {
    const directText = normalizeAssistantText(markdownNode.textContent || '');
    if (directText) return directText;
  }

  const clone = turnSection.cloneNode(true);
  clone.querySelectorAll(
    '.sr-only, button, svg, img, picture, video, canvas, [aria-label="回复操作"], [role="group"], script, style'
  ).forEach((node) => node.remove());

  return normalizeAssistantText(clone.textContent || '');
}

function getTurnIdentity(turnSection) {
  if (!turnSection) return '';
  const directIdentity =
    turnSection.getAttribute('data-turn-id') ||
    turnSection.getAttribute('data-testid');
  if (directIdentity) return directIdentity;

  const keyedTurn = turnSection.closest('[data-turn-key]');
  if (keyedTurn) return keyedTurn.getAttribute('data-turn-key') || '';

  const searchableTurn = turnSection.closest('[data-content-search-turn-key]');
  return searchableTurn ? searchableTurn.getAttribute('data-content-search-turn-key') || '' : '';
}

function getAssistantMessages() {
  const selectors = [
    'article[data-message-author-role="assistant"]',
    '[data-message-author-role="assistant"]',
    'div[data-testid^="conversation-turn-"] [data-message-author-role="assistant"]'
  ];

  const nodes = new Set();
  selectors.forEach((selector) => {
    document.querySelectorAll(selector).forEach((node) => nodes.add(node));
  });

  return Array.from(nodes);
}

function getLatestAssistantMessage() {
  const messages = getAssistantMessages();
  return messages.length > 0 ? messages[messages.length - 1] : null;
}

function getLastAssistantTextContent() {
  const turn = getLatestAssistantTurnSection();
  return getMeaningfulAssistantTextFromTurn(turn);
}

function getLastAssistantHtmlContent() {
  const turn = getLatestAssistantTurnSection();
  if (!turn) return '';

  const markdownNode =
    turn.querySelector('[data-message-author-role="assistant"] .markdown') ||
    turn.querySelector('[data-message-author-role="assistant"]') ||
    turn.querySelector('.markdown');
  if (!markdownNode) return '';

  return markdownNode.innerHTML || '';
}

function isImageCandidateTurn(turnSection) {
  if (!turnSection) return false;
  return !!(
    isImageGeneratingTurn(turnSection) ||
    isImageReadyTurn(turnSection) ||
    hasImageTransitionSurface(turnSection) ||
    getImageCandidatesFromTurn(turnSection).length > 0 ||
    turnSection.querySelector('img[alt*="已生成图片"], img[alt*="Generated image"]')
  );
}

function getLatestImageAssistantTurnSection() {
  const regularTurn = getLatestAssistantTurnSectionMatching((turn) => isImageCandidateTurn(turn));
  if (regularTurn) return regularTurn;

  // 部分新版页面会把 agent activity 和最终图片拆成相邻的两个区块。
  // 仅在原有区块识别失败时，查找同一轮内且位于 agent 起点之后的图片区域，
  // 避免把 agent 起点之前的用户上传图片当作生成结果。
  const imageSurfaces = Array.from(
    document.querySelectorAll([
      '[data-testid="generated-image-gallery"]',
      '[data-testid="generated-image-preview"]',
      '[data-testid="image-gen-loading-state"]',
      '[data-testid="image-gen-loading-state-frame"]',
      '[data-testid="image-gen-loading-state-headline"]'
    ].join(', '))
  );
  const latestAssistantTurn = getLatestAssistantTurnSection();
  const latestAssistantIdentity = getTurnIdentity(latestAssistantTurn);

  for (let i = imageSurfaces.length - 1; i >= 0; i--) {
    const surface = imageSurfaces[i];
    const keyedTurn =
      surface.closest('[data-turn-key]') ||
      surface.closest('[data-content-search-turn-key]');
    if (!keyedTurn) continue;

    const surfaceTurnIdentity =
      keyedTurn.getAttribute('data-turn-key') ||
      keyedTurn.getAttribute('data-content-search-turn-key') ||
      '';
    if (latestAssistantIdentity && surfaceTurnIdentity !== latestAssistantIdentity) continue;

    const markers = Array.from(keyedTurn.querySelectorAll('[data-chatgpt-agent-turn-start]'));
    const isAfterAgentStart = markers.some((marker) => (
      marker.compareDocumentPosition(surface) & Node.DOCUMENT_POSITION_FOLLOWING
    ));
    if (!isAfterAgentStart) continue;

    const imageRoot = surface.closest('[data-testid="generated-image-gallery"]') || surface;
    return imageRoot.parentElement || imageRoot;
  }

  return null;
}

function hasImageInAssistantMessage(node) {
  if (!node) return false;
  const images = Array.from(node.querySelectorAll('img'));
  return images.some((img) => {
    const src = img.getAttribute('src') || '';
    if (!src) return false;
    if (src.startsWith('data:image')) return true;
    if (src.startsWith('blob:')) return true;
    if (src.includes('oaiusercontent.com')) return true;
    return img.naturalWidth > 32 && img.naturalHeight > 32;
  });
}

function getHighestResUrl(img) {
  if (!img) return '';
  if (img.srcset) {
    const sources = img.srcset
      .split(',')
      .map((item) => {
        const [url, widthDesc] = item.trim().split(/\s+/);
        const width = widthDesc ? parseInt(widthDesc.replace('w', ''), 10) : 0;
        return { url, width: Number.isNaN(width) ? 0 : width };
      })
      .filter((item) => !!item.url)
      .sort((a, b) => b.width - a.width);
    if (sources.length > 0) return sources[0].url;
  }
  return img.currentSrc || img.src || '';
}

function ensureImageLoaded(img, timeoutMs = 30000) {
  return new Promise((resolve) => {
    if (!img) return resolve(false);
    if (img.complete && img.naturalWidth > 0) return resolve(true);

    const startAt = Date.now();
    const timer = setInterval(() => {
      if (img.complete && img.naturalWidth > 0) {
        clearInterval(timer);
        resolve(true);
        return;
      }
      if (Date.now() - startAt >= timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 250);

    img.addEventListener('load', () => {
      clearInterval(timer);
      resolve(img.naturalWidth > 0);
    }, { once: true });
    img.addEventListener('error', () => {
      clearInterval(timer);
      resolve(false);
    }, { once: true });
  });
}

async function imageUrlToBase64(url) {
  if (!url) return { status: 'error', data: '图片 URL 为空' };
  if (url.startsWith('data:image')) return { status: 'success', data: url };

  const isChatgptEstuaryUrl =
    url.startsWith('https://chatgpt.com/backend-api/estuary/content') ||
    url.startsWith('https://chat.openai.com/backend-api/estuary/content');

  if (isChatgptEstuaryUrl) {
    try {
      console.log('🌐 [图片转码] 尝试在页面上下文直接抓取 estuary 图片');
      const controller = new AbortController();
      const fetchTimer = setTimeout(() => controller.abort(), 15000);
      const response = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        signal: controller.signal,
        cache: 'no-store'
      });
      clearTimeout(fetchTimer);

      if (!response.ok) {
        return { status: 'error', data: `页面直抓失败: HTTP ${response.status}` };
      }

      const blob = await response.blob();
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('FileReader 转换失败'));
        reader.readAsDataURL(blob);
      });

      console.log('✅ [图片转码] 页面直抓成功');
      return { status: 'success', data: base64 };
    } catch (err) {
      console.warn(`⚠️ [图片转码] 页面直抓失败，准备回退 background: ${err && err.message ? err.message : err}`);
    }
  }

  const isBlobUrl =
    url.startsWith('blob:https://chatgpt.com/') ||
    url.startsWith('blob:https://chat.openai.com/');

  if (isBlobUrl) {
    try {
      const controller = new AbortController();
      const fetchTimer = setTimeout(() => controller.abort(), 15000);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(fetchTimer);
      const blob = await response.blob();
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('FileReader 转换失败'));
        reader.readAsDataURL(blob);
      });
      return { status: 'success', data: base64 };
    } catch (err) {
      return { status: 'error', data: `Blob 转换失败: ${err && err.message ? err.message : err}` };
    }
  }

  const maxRetries = 10;
  const intervalMs = 1500;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`🛰️ [图片转码] 第 ${attempt}/${maxRetries} 次抓取: ${url.slice(0, 120)}`);
    const result = await new Promise((resolve) => {
      let settled = false;
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ status: 'error', data: 'downloadImageDirect 超时未返回' });
      }, 15000);

      chrome.runtime.sendMessage(
        {
          action: 'downloadImageDirect',
          url
        },
        (response) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);

          if (chrome.runtime.lastError) {
            resolve({ status: 'error', data: chrome.runtime.lastError.message });
            return;
          }
          if (response && response.success && response.data) {
            resolve({ status: 'success', data: response.data });
            return;
          }
          resolve({ status: 'error', data: (response && response.error) || '未知抓取错误' });
        }
      );
    });

    if (result.status === 'success') {
      console.log('✅ [图片转码] 抓取成功');
      return result;
    }
    console.warn(`⚠️ [图片转码] 抓取失败: ${result.data}`);
    if (attempt < maxRetries) await sleep(intervalMs);
  }

  return { status: 'error', data: `图片抓取失败，已重试 ${maxRetries} 次` };
}

function getImageCandidatesFromTurn(turnSection) {
  if (!turnSection) return [];
  const selectors = [
    '[data-testid="generated-image-preview"] img',
    '[data-testid="generated-image-gallery"] img',
    '[class*="group/imagegen-image"] img',
    'img[alt*="已生成图片"]',
    'img[alt*="Generated image"]',
    'img[src^="data:image/"]',
    'img[src^="blob:"]',
    'img[src*="oaiusercontent.com"]'
  ];

  const nodes = new Set();
  selectors.forEach((selector) => {
    turnSection.querySelectorAll(selector).forEach((img) => nodes.add(img));
  });

  const all = Array.from(nodes);
  if (all.length === 0) return [];

  const primaryByAlt = all.filter((img) => {
    const alt = (img.getAttribute('alt') || '').trim();
    if (!alt) return false;
    return alt.includes('已生成图片') || alt.toLowerCase().includes('generated image');
  });

  const preferred = primaryByAlt.length > 0 ? primaryByAlt : all;
  const visiblePreferred = preferred.filter((img) => img.getAttribute('aria-hidden') !== 'true');
  const source = visiblePreferred.length > 0 ? visiblePreferred : preferred;

  const uniqueByUrl = new Map();
  source.forEach((img) => {
    const url = getHighestResUrl(img);
    if (!url) return;
    if (!uniqueByUrl.has(url)) uniqueByUrl.set(url, img);
  });

  return Array.from(uniqueByUrl.values());
}

function hasImageTransitionSurface(turnSection) {
  if (!turnSection) return false;
  return !!(
    turnSection.querySelector('[data-testid="generated-image-gallery"]') ||
    turnSection.querySelector('[data-testid="generated-image-preview"]') ||
    turnSection.querySelector('[class*="group/imagegen-image"]') ||
    turnSection.querySelector('[id^="image-"]') ||
    turnSection.querySelector('button[aria-label*="喜欢此图片"]') ||
    turnSection.querySelector('button[aria-label*="Like this image"]')
  );
}

async function waitForReplyImagesMaterialized(turnSection, timeoutMs = 60000) {
  const startAt = Date.now();
  let lastLogAt = 0;
  let loopCount = 0;

  console.log(`⏳ [图片落地] 开始等待图片节点渲染，超时 ${timeoutMs}ms`);

  while (Date.now() - startAt < timeoutMs) {
    loopCount += 1;
    const images = getImageCandidatesFromTurn(turnSection);
    const elapsed = Date.now() - startAt;
    if (Date.now() - lastLogAt > 2000) {
      console.log(`🔍 [图片落地] 轮询中: elapsed=${elapsed}ms, rawCandidates=${images.length}`);
      lastLogAt = Date.now();
    }

    if (images.length > 0) {
      await Promise.all(images.map((img) => ensureImageLoaded(img, 15000)));
      const loadedImages = images.filter((img) => {
        const src = img.getAttribute('src') || img.currentSrc || '';
        if (!src) return false;
        if (src.startsWith('data:image')) return true;
        if (src.startsWith('blob:')) return true;
        if (src.includes('oaiusercontent.com')) return true;
        return img.naturalWidth >= 64 && img.naturalHeight >= 64;
      });

      if (loadedImages.length > 0) {
        console.log(`✅ [图片落地] 图片节点就绪: loaded=${loadedImages.length}, raw=${images.length}, elapsed=${Date.now() - startAt}ms, loops=${loopCount}`);
        return { status: 'success', images: loadedImages };
      }

      console.warn(`⚠️ [图片落地] 检测到候选图片但未就绪: candidates=${images.length}, elapsed=${Date.now() - startAt}ms`);
    }

    await sleep(600);
  }

  console.error(`❌ [图片落地] 超时: elapsed=${Date.now() - startAt}ms, loops=${loopCount}`);
  return { status: 'error', data: '图片处于过渡态，等待图片节点加载超时' };
}

async function getLatestReplyImages() {
  await sleep(1000);
  console.log('🖼️ 开始提取生图结果并转 base64...');

  const latestTurn = getLatestImageAssistantTurnSection() || getLatestAssistantTurnSection();
  if (!latestTurn) {
    return { status: 'error', data: '未找到 assistant 回复区块' };
  }

  const materialized = await waitForReplyImagesMaterialized(latestTurn, 180000);
  if (materialized.status !== 'success') {
    console.warn('⚠️ [图片提取] 图片落地失败，准备按分支返回错误:', materialized.data);
    if (hasImageTransitionSurface(latestTurn)) {
      return { status: 'error', data: materialized.data };
    }
    return { status: 'error', data: getLastAssistantTextContent() || '未检测到图片输出' };
  }

  const allImages = materialized.images;
  console.log(`🧩 [图片提取] 落地完成，候选图片总数: ${allImages.length}`);

  const imageCandidates = allImages.filter((img) => {
    const src = img.getAttribute('src') || img.currentSrc || '';
    if (!src) return false;
    if (src.startsWith('data:image')) return true;
    if (src.startsWith('blob:')) return true;
    if (src.includes('oaiusercontent.com')) return true;
    return img.naturalWidth >= 128 && img.naturalHeight >= 128;
  });

  if (imageCandidates.length === 0) {
    console.warn('⚠️ [图片提取] 候选图片筛选后为 0');
    return { status: 'error', data: getLastAssistantTextContent() || '未检测到可用图片' };
  }

  const selectedImages = [imageCandidates[0]];
  console.log(`🧪 [图片提取] 候选=${imageCandidates.length}，实际转码=1（仅主图）`);

  const converted = await Promise.all(
    selectedImages.map(async (img, index) => {
      const bestUrl = getHighestResUrl(img);
      console.log(`🔗 [图片转码] #${index + 1} URL:`, bestUrl ? bestUrl.slice(0, 160) : '(empty)');
      const base64 = await imageUrlToBase64(bestUrl);
      if (base64.status !== 'success') {
        console.warn(`⚠️ [图片转码] #${index + 1} 失败: ${base64.data}`);
      } else {
        const size = typeof base64.data === 'string' ? base64.data.length : 0;
        console.log(`✅ [图片转码] #${index + 1} 成功: base64Length=${size}`);
      }
      return base64.status === 'success' ? base64.data : null;
    })
  );

  const validBase64Images = converted.filter((item) => !!item);
  if (validBase64Images.length === 0) {
    console.error('❌ [图片提取] 所有图片转码失败');
    return { status: 'error', data: '图片转 base64 失败' };
  }

  console.log(`✅ [图片提取] 转码完成: success=${validBase64Images.length}, total=${selectedImages.length}`);

  return {
    status: 'success',
    data: validBase64Images,
    message: getLastAssistantTextContent() || ''
  };
}

function waitForTextReplyComplete(timeoutMs = 180000) {
  return new Promise((resolve) => {
    console.log('⏳ [文本分支] 开始等待对话回复完成...');
    const initialTurnIdentity = getTurnIdentity(getLatestAssistantTurnSection());
    const startTime = Date.now();
    const stableDelayMs = 2200;
    let stableStartAt = 0;
    let lastTextLength = -1;

    const cleanup = () => {
      observer.disconnect();
      clearInterval(pollTimer);
      clearTimeout(timer);
    };

    const finish = (ok) => {
      cleanup();
      resolve(ok);
    };

    const check = () => {
      const stopBtn = getStopButton();
      const latestTurn = getLatestAssistantTurnSection();
      const latestTurnIdentity = getTurnIdentity(latestTurn);
      const hasNewAssistantReply = !!latestTurnIdentity && latestTurnIdentity !== initialTurnIdentity;
      const textLength = getLastAssistantTextContent().length;
      const hasText = textLength > 0;

      const baseReady = !stopBtn && hasNewAssistantReply && hasText && Date.now() - startTime > 1000;
      if (!baseReady) {
        stableStartAt = 0;
        lastTextLength = -1;
        return;
      }

      if (textLength !== lastTextLength) {
        lastTextLength = textLength;
        stableStartAt = Date.now();
        return;
      }

      if (stableStartAt > 0 && Date.now() - stableStartAt >= stableDelayMs) {
        console.log(`✅ [文本分支] 检测到对话回复完成（稳定 ${stableDelayMs}ms）`);
        finish(true);
      }
    };

    const observer = new MutationObserver(() => check());
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });

    const pollTimer = setInterval(() => check(), 1000);

    const timer = setTimeout(() => {
      console.warn('⚠️ [文本分支] 等待回复超时');
      finish(false);
    }, timeoutMs);

    check();
  });
}

function waitForImageReplyComplete(timeoutMs = 240000) {
  return new Promise((resolve) => {
    console.log('⏳ [生图分支] 开始等待图片回复完成...');
    imageReplyFailureText = '';
    const initialTurn = getLatestImageAssistantTurnSection() || getLatestAssistantTurnSection();
    const initialTurnIdentity = getTurnIdentity(initialTurn);
    const initialTurnWasReady = isImageReadyTurn(initialTurn);
    const initialTurnWasGenerating = isImageGeneratingTurn(initialTurn);
    const startTime = Date.now();
    const sameTurnReadyGraceMs = 3000;
    const imageStableBypassStopMs = 5000;
    const textStableDelayMs = 2200;
    let textStableStartAt = 0;
    let imageStableStartAt = 0;
    let lastTextLength = -1;
    let lastStateKey = '';

    const cleanup = () => {
      observer.disconnect();
      clearInterval(pollTimer);
      clearTimeout(timer);
    };

    const finish = (ok) => {
      cleanup();
      resolve(ok);
    };

    const check = () => {
      const stopBtn = getStopButton();
      const latestAssistantTurn = getLatestAssistantTurnSection();
      const latestTurn = getLatestImageAssistantTurnSection() || latestAssistantTurn;
      const latestAssistantTurnIdentity = getTurnIdentity(latestAssistantTurn);
      const latestTurnIdentity = getTurnIdentity(latestTurn);
      const hasNewAssistantReply = !!latestAssistantTurnIdentity && latestAssistantTurnIdentity !== initialTurnIdentity;
      const hasNewImageReply = !!latestTurnIdentity && latestTurnIdentity !== initialTurnIdentity;
      const readyNow = isImageReadyTurn(latestTurn);
      const loadingNow = isImageGeneratingTurn(latestTurn);
      const hasTransitionSurface = hasImageTransitionSurface(latestTurn);
      const becameReadyOnSameTurn = !!latestTurnIdentity && latestTurnIdentity === initialTurnIdentity && !initialTurnWasReady && readyNow;
      const hasImageFallback = !!(latestTurn && (hasImageInAssistantMessage(latestTurn) || latestTurn.querySelector('img')));
      const hasActualImageOutput = readyNow || hasImageFallback;
      const imageCandidateCount = latestTurn ? getImageCandidatesFromTurn(latestTurn).length : 0;
      const sameTurnAlreadyUsable =
        !!latestTurnIdentity &&
        latestTurnIdentity === initialTurnIdentity &&
        initialTurnWasReady &&
        hasActualImageOutput &&
        !loadingNow &&
        Date.now() - startTime >= sameTurnReadyGraceMs;
      const latestAssistantText = getMeaningfulAssistantTextFromTurn(latestAssistantTurn);
      const textLength = latestAssistantText.length;
      const isAnalysisProgressText = isImageAnalysisProgressText(latestAssistantText);
      const textCandidateReady = !stopBtn && !loadingNow && !hasActualImageOutput && textLength > 0 && !isAnalysisProgressText;
      const canUseSameTurnFallback = !!latestTurnIdentity && latestTurnIdentity === initialTurnIdentity && initialTurnWasGenerating && !loadingNow;

      const stateKey = [
        stopBtn ? 'stop:1' : 'stop:0',
        loadingNow ? 'loading:1' : 'loading:0',
        readyNow ? 'ready:1' : 'ready:0',
        hasTransitionSurface ? 'trans:1' : 'trans:0',
        hasNewAssistantReply ? 'new:1' : 'new:0',
        hasNewImageReply ? 'imgnew:1' : 'imgnew:0',
        hasImageFallback ? 'imgfb:1' : 'imgfb:0',
        `txt:${textLength}`
      ].join('|');

      if (stateKey !== lastStateKey) {
        lastStateKey = stateKey;
        console.log('🧭 [生图分支] 状态变化:', {
          elapsed: Date.now() - startTime,
          latestAssistantTurnIdentity,
          latestTurnIdentity,
          hasNewAssistantReply,
          hasNewImageReply,
          loadingNow,
          readyNow,
          hasTransitionSurface,
          hasImageFallback,
          imageCandidateCount,
          textLength,
          isAnalysisProgressText,
          becameReadyOnSameTurn,
          canUseSameTurnFallback,
          sameTurnAlreadyUsable
        });
      }

      if (loadingNow) {
        textStableStartAt = 0;
        imageStableStartAt = 0;
        lastTextLength = -1;
        return;
      }

      if (hasActualImageOutput) {
        if (imageStableStartAt === 0) {
          imageStableStartAt = Date.now();
        }
      } else {
        imageStableStartAt = 0;
      }

      if (!stopBtn && (hasNewImageReply || becameReadyOnSameTurn || sameTurnAlreadyUsable) && hasActualImageOutput && Date.now() - startTime > 1000) {
        console.log('✅ [生图分支] 检测到图片回复完成');
        finish(true);
        return;
      }

      if (
        stopBtn &&
        hasActualImageOutput &&
        imageStableStartAt > 0 &&
        Date.now() - imageStableStartAt >= imageStableBypassStopMs
      ) {
        console.warn(`⚠️ [生图分支] stop 按钮未恢复，但图片已稳定 ${imageStableBypassStopMs}ms，直接提取首图返回`);
        finish(true);
        return;
      }

      if ((hasNewAssistantReply || canUseSameTurnFallback) && textCandidateReady && Date.now() - startTime > 1000) {
        if (textLength !== lastTextLength) {
          lastTextLength = textLength;
          textStableStartAt = Date.now();
          return;
        }

        if (textStableStartAt > 0 && Date.now() - textStableStartAt >= textStableDelayMs) {
          imageReplyFailureText = latestAssistantText || '生图失败：返回了文本错误信息';
          console.warn(`❌ [生图分支] 图片未产出，判定失败（稳定 ${textStableDelayMs}ms）`);
          finish(false);
        }
      } else {
        textStableStartAt = 0;
        lastTextLength = -1;
      }
    };

    const observer = new MutationObserver(() => check());
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });

    const pollTimer = setInterval(() => check(), 1000);

    const timer = setTimeout(() => {
      const latestAssistantTurn = getLatestAssistantTurnSection();
      const finalText = getMeaningfulAssistantTextFromTurn(latestAssistantTurn);
      const latestTurn = getLatestImageAssistantTurnSection() || latestAssistantTurn;
      const hasTransitionSurface = hasImageTransitionSurface(latestTurn);
      if (finalText && !hasTransitionSurface && !imageReplyFailureText && !isImageAnalysisProgressText(finalText)) {
        imageReplyFailureText = finalText;
        console.warn('⚠️ [生图分支] 超时时检测到文本输出，按文本失败返回');
      }
      console.warn('⚠️ [生图分支] 等待生图超时');
      finish(false);
    }, timeoutMs);

    check();
  });
}

async function waitForReplyByAction(action) {
  if (action === 'generate_image') {
    return waitForImageReplyComplete();
  }
  return waitForTextReplyComplete();
}

async function pasteTextToPrompt(text) {
  console.log('📋 准备向 ChatGPT 粘贴文本...');
  const inputBox = getPromptInput();
  if (!inputBox) throw new Error('找不到 ChatGPT 输入框');

  inputBox.focus();
  await sleep(80);

  const dt = new DataTransfer();
  dt.setData('text/plain', text || '');

  const pasteEvent = new ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
    clipboardData: dt
  });
  await setPromptText(text);
  // const pasted = inputBox.dispatchEvent(pasteEvent);
  // if (!pasted) {
  //   console.warn('⚠️ 文本粘贴事件被拦截，准备走输入兜底');
  // await setPromptText(text);
  // }
}

async function setPromptText(text) {
  const inputBox = getPromptInput();
  if (!inputBox) throw new Error('找不到 ChatGPT 输入框');

  inputBox.focus();
  await sleep(80);

  if (inputBox.tagName === 'TEXTAREA') {
    inputBox.value = text || '';
    inputBox.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }

  if (inputBox.isContentEditable) {
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text || '');
    inputBox.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text || '' }));
    return;
  }

  inputBox.textContent = text || '';
  inputBox.dispatchEvent(new Event('input', { bubbles: true }));
}

async function clickSendButton(timeoutMs = 10000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const sendButton = getSendButton();
    if (sendButton && !sendButton.disabled && sendButton.getAttribute('aria-disabled') !== 'true') {
      sendButton.click();
      console.log('🚀 文本发送按钮已点击');
      return true;
    }

    await sleep(200);
  }

  throw new Error('找不到可点击的发送按钮');
}

async function sendPrompt(text, usePaste = true) {
  if (typeof text !== 'string') {
    throw new Error('发送文本必须是字符串');
  }

  if (usePaste) {
    await pasteTextToPrompt(text);
  } else {
    await setPromptText(text);
  }

  await sleep(300);
  await clickSendButton();
}

function extractConversationId() {
  const currentUrl = window.location.href;
  const match = currentUrl.match(/\/c\/([a-zA-Z0-9_-]+)/);
  return match && match[1] ? match[1] : null;
}

async function notifyTaskCompleted(taskId, action, data, message, urlId, error) {
  await new Promise((resolve) => {
    chrome.runtime.sendMessage(
      {
        action: 'task_completed',
        data,
        task_id: taskId,
        message,
        task_action: action,
        url_id: urlId,
        error
      },
      () => resolve()
    );
  });
}

async function typeAndSend(
  text = '帮我查询一下今天的天气',
  task_id = '',
  image = [],
  is_continue = false,
  action = 'generate_text',
  model = '',
  source = 'chatgpt',
  chatSurface = 'chat'
) {
  const log = document.getElementById('status-log');
  if (log) log.innerText = `🚀 任务启动: ${task_id || '-'} (${action || '-'})`;
  const taskStartAt = Date.now();
  let urlId = null;

  try {
    console.log('🚀 [任务] 启动参数:', {
      task_id,
      action,
      model,
      source,
      chatSurface,
      is_continue,
      textLength: typeof text === 'string' ? text.length : 0,
      imageCount: Array.isArray(image) ? image.length : 0
    });
    imageReplyFailureText = '';

    await sleep(2000);
    await ensureChatInterfaceSelected(chatSurface);

    if (Array.isArray(image) && image.length > 0) {
      for (let i = 0; i < image.length; i++) {
        if (log) log.innerText = `⏳ 正在上传第 ${i + 1}/${image.length} 张图片...`;
        await pasteImage(image[i], `image_${i + 1}.png`);
        await sleep(1000);
      }
    }

    if (log) log.innerText = '⏳ 正在粘贴并发送文本...';
    await sendPrompt(text, true);

    if (log) {
      log.innerText = action === 'generate_image' ? '⏳ 正在等待生图完成...' : '⏳ 正在等待对话完成...';
    }
    const completed = await waitForReplyByAction(action);
    if (!completed) {
      if (action === 'generate_image' && imageReplyFailureText) {
        throw new Error('show-'+imageReplyFailureText);
      }
      throw new Error(action === 'generate_image' ? '等待生图完成超时' : '等待对话完成超时');
    }

    urlId = extractConversationId();

    let returnData = null;
    let returnMessage = null;

    if (action === 'generate_image') {
      const imageResult = await getLatestReplyImages();
      if (imageResult.status !== 'success') {
        throw new Error(imageResult.data || '图片转 base64 失败');
      }
      returnData = imageResult.data;
      returnMessage = imageResult.message || '';
    } else {
      const assistantResultHtml = getLastAssistantHtmlContent();
      const assistantResultText = getLastAssistantTextContent();
      returnData = assistantResultHtml || assistantResultText;
      returnMessage = assistantResultText || '';
      if (!returnData) {
        throw new Error('获取回复数据为空或出错');
      }
    }

    await notifyTaskCompleted(task_id, action, returnData, returnMessage, urlId, null);

    if (log) log.innerText = action === 'generate_image' ? '✅ 生图分支完成' : '✅ 对话分支完成';
    console.log(`✅ [任务] 完成，总耗时 ${Date.now() - taskStartAt}ms`);
  } catch (err) {
    console.error('❌ 任务失败:', err);
    console.error(`❌ [任务] 失败，总耗时 ${Date.now() - taskStartAt}ms`);
    if (log) log.innerText = '❌ 错误: ' + err.message;
    await notifyTaskCompleted(task_id, action, null, null, urlId, err.message);
    throw err;
  }
}

async function typeAndSendTest(
  text = '帮我查询一下今天的天气',
  task_id = '',
  image = [],
  is_continue = false,
  action = 'generate_text',
  model = '',
  source = 'chatgpt',
  chatSurface = 'chat'
) {
  return typeAndSend(text, task_id, image, is_continue, action, model, source, chatSurface);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'type_and_send') {
    typeAndSend(
      request.text,
      request.task_id,
      request.image,
      request.is_continue,
      request.task_action,
      request.task_model,
      request.source,
      request.chat_surface
    ).then(() => {
      sendResponse({ success: true });
    }).catch((err) => {
      sendResponse({ success: false, error: err && err.message ? err.message : String(err) });
    });
    return true;
  }
});

function isVisibleElement(element) {
  if (!element || !element.isConnected) return false;
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
}

function normalizedElementText(element) {
  return (element && (element.innerText || element.textContent) || '').replace(/\s+/g, '').trim().toLowerCase();
}

function clickElementOnce(element) {
  if (!element) return false;
  try {
    element.scrollIntoView({ block: 'center', inline: 'center' });
  } catch (err) {}
  try {
    element.focus({ preventScroll: true });
  } catch (err) {}
  element.click();
  return true;
}

function clickLibraryConfirmInPageContext(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const requestId = `library-delete-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener('message', onResult);
    };
    const onResult = (event) => {
      if (event.source !== window || !event.data || event.data.type !== 'CHATGPT_LIBRARY_CONFIRM_DELETE_RESULT') return;
      if (event.data.requestId !== requestId) return;
      cleanup();
      if (event.data.success) resolve(true);
      else reject(new Error(event.data.error || '页面上下文触发确认删除失败'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('等待页面上下文触发确认删除超时'));
    }, timeoutMs);

    window.addEventListener('message', onResult);
    window.postMessage({ type: 'CHATGPT_LIBRARY_CONFIRM_DELETE', requestId }, '*');
  });
}

async function waitForCondition(check, timeoutMs = 15000, intervalMs = 250) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = check();
    if (result) return result;
    await sleep(intervalMs);
  }
  return null;
}

function getLibrarySelectAllCheckbox() {
  const exactCheckbox = document.querySelector(
    '[data-testid="artifacts-surface-library-list-header"] input[type="checkbox"][aria-label="选择全部"], ' +
    '[data-testid="artifacts-surface-library-list-header"] input[type="checkbox"][aria-label="Select all"]'
  );
  if (exactCheckbox) return exactCheckbox;

  const checkboxSelectors = [
    'input[type="checkbox"]',
    'button[role="checkbox"]',
    '[role="checkbox"]',
    'button[data-state="checked"]',
    'button[data-state="unchecked"]'
  ];
  const candidates = Array.from(document.querySelectorAll(checkboxSelectors.join(',')))
    .filter(isVisibleElement);

  const labeled = candidates.find((element) => {
    const label = [
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.closest('label') && element.closest('label').innerText
    ].filter(Boolean).join(' ').toLowerCase();
    return /select\s*all|全选|选择全部/.test(label);
  });
  if (labeled) return labeled;

  // 资料库表格的全选框位于所有可见复选框的最上方。
  return candidates.sort((a, b) => {
    const rectA = a.getBoundingClientRect();
    const rectB = b.getBoundingClientRect();
    return rectA.top - rectB.top || rectA.left - rectB.left;
  })[0] || null;
}

function getLibrarySelectAllClickTarget(checkbox) {
  if (!checkbox) return null;
  const checkboxCell = checkbox.parentElement && checkbox.parentElement.parentElement;
  const bridgeButton = checkboxCell && checkboxCell.querySelector(':scope > button[aria-hidden="true"]');
  return bridgeButton || checkbox;
}

function getLibraryFileRowCount() {
  return document.querySelectorAll('[data-page-table-selectable-row="true"]').length;
}

function getSelectedLibraryRowIds() {
  return Array.from(document.querySelectorAll(
    '[data-page-table-selectable-row="true"][data-selected="true"]'
  )).map((row) => row.getAttribute('data-page-table-selection-id')).filter(Boolean);
}

function getLibraryScrollContainer() {
  const firstRow = document.querySelector('[data-page-table-selectable-row="true"]');
  const candidates = [document.scrollingElement];
  let current = firstRow && firstRow.parentElement;

  while (current) {
    const style = window.getComputedStyle(current);
    if (/auto|scroll/.test(style.overflowY) && current.scrollHeight > current.clientHeight) {
      candidates.push(current);
    }
    current = current.parentElement;
  }

  return candidates.filter(Boolean).sort((a, b) => (
    (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight)
  ))[0] || document.scrollingElement;
}

async function scrollLibraryPageBeforeSelectAll() {
  const scrollContainer = getLibraryScrollContainer();
  if (!scrollContainer || scrollContainer.scrollHeight <= scrollContainer.clientHeight) return;

  updateLibraryCleanupStatus('↕️ 正在向下翻页 5 次以加载文件...');
  scrollContainer.scrollTop = 0;
  await sleep(1000);
  for (let page = 1; page <= 5; page += 1) {
    const pageDistance = Math.max(scrollContainer.clientHeight * 0.9, 600);
    scrollContainer.scrollTop += pageDistance;
    updateLibraryCleanupStatus(`↕️ 正在加载第 ${page}/5 页...`);
    await sleep(2000);
  }
  await sleep(1000);
  scrollContainer.scrollTop = 0;
  await sleep(1000);
}

function isCheckboxSelected(element) {
  return !!element && (
    element.checked === true ||
    element.getAttribute('aria-checked') === 'true' ||
    element.getAttribute('data-state') === 'checked'
  );
}

function findVisibleButtonByText(labels, root = document) {
  const normalizedLabels = labels.map((label) => label.replace(/\s+/g, '').toLowerCase());
  return Array.from(root.querySelectorAll('button, [role="button"]')).find((element) => {
    if (!isVisibleElement(element) || element.disabled || element.getAttribute('aria-disabled') === 'true') return false;
    const text = normalizedElementText(element);
    const ariaLabel = (element.getAttribute('aria-label') || '').replace(/\s+/g, '').toLowerCase();
    return normalizedLabels.includes(text) || normalizedLabels.includes(ariaLabel);
  }) || null;
}

function hasVisibleLibraryDeleteFailureNotice() {
  const candidates = document.querySelectorAll(
    '[role="alert"], [role="status"], [data-sonner-toast], [data-testid*="toast"]'
  );
  return Array.from(candidates).some((element) => {
    if (!isVisibleElement(element)) return false;
    const text = (element.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    return text.includes('无法删除文件') || text.includes('failed to delete file');
  });
}

async function waitForLibraryBatchDelete(previousStartedCount, previousCompletedCount, previousFailedCount, timeoutMs = 120000) {
  const startedAt = Date.now();
  const requestStartTimeoutMs = 15000;
  let idleSince = 0;
  let failureReason = '';

  while (Date.now() - startedAt < timeoutMs) {
    if (!failureReason && hasVisibleLibraryDeleteFailureNotice()) {
      failureReason = '页面提示无法删除文件';
      updateLibraryCleanupStatus('⚠️ 检测到删除失败，正在等待本轮其他删除请求完成...');
    }
    if (!failureReason && libraryDeleteRequestFailedCount > previousFailedCount) {
      const statusText = libraryDeleteRequestLastFailureStatus || '网络错误';
      failureReason = `资料库删除请求失败（HTTP ${statusText}）`;
      updateLibraryCleanupStatus('⚠️ 检测到删除请求失败，正在等待本轮其他删除请求完成...');
    }

    const hasStarted = libraryDeleteRequestStartedCount > previousStartedCount;
    const startedInRound = libraryDeleteRequestStartedCount - previousStartedCount;
    const completedInRound = libraryDeleteRequestCompletedCount - previousCompletedCount;
    const allStartedRequestsCompleted = hasStarted && completedInRound >= startedInRound;

    if (!hasStarted && Date.now() - startedAt >= requestStartTimeoutMs) {
      throw new Error(failureReason || '确认删除后未检测到 delete-batch 请求');
    }

    if (allStartedRequestsCompleted && libraryDeleteRequestActiveCount === 0) {
      if (!idleSince) idleSince = Date.now();
      // ChatGPT 会把一次全选删除拆成多个请求；连续静默后才认为本轮全部结束。
      if (Date.now() - idleSince >= 10000) {
        if (failureReason) throw new Error(failureReason);
        return true;
      }
    } else {
      idleSince = 0;
    }

    await sleep(200);
  }

  throw new Error('等待资料库批量删除请求完成超时');
}

function updateLibraryCleanupStatus(message) {
  const log = document.getElementById('status-log');
  if (log) log.innerText = message;
  console.log(`[资料库清理] ${message}`);
}

function isRecoverableLibraryCleanupError(errorMessage) {
  return [
    '等待资料库列表加载超时',
    '未找到资料库的“选择全部”复选框',
    '等待文件选择完成超时',
    '全选后未找到页面底部的删除按钮',
    '检测到残留删除确认框',
    '未找到删除确认框中的删除按钮',
    '页面提示无法删除文件',
    '资料库删除请求失败',
    '确认删除后未检测到 delete-batch 请求',
    '等待资料库批量删除请求完成超时',
    '删除请求完成，但资料库列表未及时刷新'
  ].some((message) => errorMessage.includes(message));
}

function reloadLibraryCleanupAndResume(errorMessage) {
  const previousReloadCount = Number(sessionStorage.getItem(LIBRARY_CLEANUP_RELOAD_COUNT_KEY)) || 0;
  const reloadCount = previousReloadCount + 1;
  const reloadDelay = Math.min(1000 + (reloadCount - 1) * 500, 5000);

  sessionStorage.setItem(LIBRARY_CLEANUP_STORAGE_KEY, '1');
  sessionStorage.setItem(LIBRARY_CLEANUP_RELOAD_COUNT_KEY, String(reloadCount));
  updateLibraryCleanupStatus(`🔄 ${errorMessage}，正在刷新页面后继续（第 ${reloadCount} 次恢复）...`);
  setTimeout(() => window.location.reload(), reloadDelay);
}

async function runLibraryCleanup() {
  if (libraryCleanupRunning) {
    return;
  }
  libraryCleanupRunning = true;
  let completedRounds = 0;

  const cleanupButton = document.getElementById('btn-library-cleanup');
  if (cleanupButton) cleanupButton.disabled = true;

  try {
    sessionStorage.setItem(LIBRARY_CLEANUP_STORAGE_KEY, '1');

    if (window.location.hostname !== 'chatgpt.com' || window.location.pathname !== '/library' || new URLSearchParams(window.location.search).get('tab') !== 'all') {
      updateLibraryCleanupStatus('↗️ 正在打开资料库...');
      window.location.assign(CHATGPT_LIBRARY_URL);
      return;
    }

    let round = 0;
    let consecutiveEmptyChecks = 0;
    while (sessionStorage.getItem(LIBRARY_CLEANUP_STORAGE_KEY) === '1') {
      round += 1;
      updateLibraryCleanupStatus(`⏳ 第 ${round} 轮：等待文件列表加载...`);

      const listReady = await waitForCondition(() => (
        document.querySelector('[data-testid="artifacts-surface-library-list-header"]') ||
        document.querySelector('[data-testid="page-table-background"]')
      ), 30000, 500);
      if (!listReady) throw new Error('等待资料库列表加载超时');

      if (getLibraryFileRowCount() === 0) {
        consecutiveEmptyChecks += 1;
        if (consecutiveEmptyChecks < 3) {
          await sleep(2500);
          continue;
        }
        sessionStorage.removeItem(LIBRARY_CLEANUP_STORAGE_KEY);
        sessionStorage.removeItem(LIBRARY_CLEANUP_RELOAD_COUNT_KEY);
        updateLibraryCleanupStatus(`✅ 清理完成，共执行 ${completedRounds} 轮`);
        break;
      }
      consecutiveEmptyChecks = 0;

      await scrollLibraryPageBeforeSelectAll();

      const selectAll = await waitForCondition(() => getLibrarySelectAllCheckbox(), 10000, 250);
      if (!selectAll) throw new Error('未找到资料库的“选择全部”复选框');

      const rows = Array.from(document.querySelectorAll('[data-page-table-selectable-row="true"]'));
      if (!isCheckboxSelected(selectAll)) {
        clickElementOnce(getLibrarySelectAllClickTarget(selectAll));
      }

      const expectedSelectedCount = rows.length;
      const selectionReady = await waitForCondition(() => (
        getSelectedLibraryRowIds().length >= expectedSelectedCount
      ), 10000, 250);
      if (!selectionReady) throw new Error('等待文件选择完成超时');

      const deleteButton = await waitForCondition(() => {
        const dialog = document.querySelector('[role="dialog"], [role="alertdialog"], [data-radix-dialog-content]');
        if (dialog && isVisibleElement(dialog)) return null;
        return findVisibleButtonByText(['删除', 'Delete']);
      }, 10000);
      if (!deleteButton) {
        const staleDialog = Array.from(document.querySelectorAll(
          '[role="dialog"], [role="alertdialog"], [data-radix-dialog-content]'
        )).find(isVisibleElement);
        if (staleDialog) throw new Error('检测到残留删除确认框');
        throw new Error('全选后未找到页面底部的删除按钮');
      }

      updateLibraryCleanupStatus(`🗑️ 第 ${round} 轮：已全选，正在请求删除...`);
      const selectedRowIds = getSelectedLibraryRowIds();
      clickElementOnce(deleteButton);

      const confirmDeleteButton = await waitForCondition(() => {
        const dialog = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], [data-radix-dialog-content]'))
          .find(isVisibleElement);
        if (!dialog) return null;
        const exactConfirmButton = dialog.querySelector('button[data-testid="confirm-delete-recall-file-button"]');
        return exactConfirmButton && isVisibleElement(exactConfirmButton)
          ? exactConfirmButton
          : findVisibleButtonByText(['删除', 'Delete'], dialog);
      }, 10000);
      if (!confirmDeleteButton) throw new Error('未找到删除确认框中的删除按钮');

      const previousStartedCount = libraryDeleteRequestStartedCount;
      const previousCompletedCount = libraryDeleteRequestCompletedCount;
      const previousFailedCount = libraryDeleteRequestFailedCount;
      updateLibraryCleanupStatus(`🗑️ 第 ${round} 轮：正在页面上下文确认删除...`);
      await clickLibraryConfirmInPageContext();
      await waitForLibraryBatchDelete(previousStartedCount, previousCompletedCount, previousFailedCount);

      const listRefreshed = await waitForCondition(() => {
        const stillSelected = document.querySelector(
          '[data-page-table-selectable-row="true"][data-selected="true"]'
        );
        const oldRowStillPresent = selectedRowIds.some((rowId) => (
          document.querySelector(`[data-page-table-selection-id="${CSS.escape(rowId)}"]`)
        ));
        return !stillSelected && !oldRowStillPresent;
      }, 30000, 500);
      if (!listRefreshed) throw new Error('删除请求完成，但资料库列表未及时刷新');

      completedRounds += 1;
      sessionStorage.removeItem(LIBRARY_CLEANUP_RELOAD_COUNT_KEY);

      updateLibraryCleanupStatus(`✅ 第 ${round} 轮删除完成，准备检查剩余文件...`);
      await waitForCondition(() => {
        const dialog = document.querySelector('[role="dialog"], [role="alertdialog"], [data-radix-dialog-content]');
        return !dialog || !isVisibleElement(dialog);
      }, 10000);
      await sleep(1500);
    }
  } catch (err) {
    const errorMessage = err && err.message ? err.message : String(err);
    console.error('❌ 资料库清理失败:', err);
    if (isRecoverableLibraryCleanupError(errorMessage)) {
      reloadLibraryCleanupAndResume(errorMessage);
      return;
    }

    sessionStorage.removeItem(LIBRARY_CLEANUP_STORAGE_KEY);
    sessionStorage.removeItem(LIBRARY_CLEANUP_RELOAD_COUNT_KEY);
    updateLibraryCleanupStatus(`❌ 清理失败: ${errorMessage}`);
  } finally {
    libraryCleanupRunning = false;
    const currentButton = document.getElementById('btn-library-cleanup');
    if (currentButton) currentButton.disabled = false;
  }
}

function createPanel() {
  if (document.getElementById('chatgpt-bot-panel')) return;

  const div = document.createElement('div');
  div.id = 'chatgpt-bot-panel';
  div.innerHTML = `
        <div style="position:fixed; bottom:80px; right:20px; z-index:99999; background:#202124; padding:15px; border-radius:8px; border:1px solid #5f6368; color:white; font-family:sans-serif; width:240px; box-shadow:0 4px 12px rgba(0,0,0,0.5);">
            <h3 style="margin:0 0 10px 0; font-size:14px; color:#e8eaed;">ChatGPT 全自动机器人</h3>
            <button id="btn-test" style="width:100%; padding:8px; background:#8ab4f8; border:none; border-radius:4px; cursor:pointer; color:#202124; font-weight:bold;">⚡ 运行图片上传测试</button>
            <button id="btn-work-check" style="width:100%; margin-top:8px; padding:8px; background:#a8dab5; border:none; border-radius:4px; cursor:pointer; color:#202124; font-weight:bold;">🧪 运行 Work 定时检查</button>
            <button id="btn-library-cleanup" style="width:100%; margin-top:8px; padding:8px; background:#f28b82; border:none; border-radius:4px; cursor:pointer; color:#202124; font-weight:bold;">🗑️ 清理存储</button>
            <div id="status-log" style="margin-top:10px; font-size:12px; color:#9aa0a6;">就绪</div>
        </div>
    `;
  document.body.appendChild(div);

  const button = document.getElementById('btn-test');
  if (button) {
    button.onclick = () => {
      typeAndSendTest().catch((err) => {
        console.error('测试入口执行失败:', err);
      });
    };
  }

  const workCheckButton = document.getElementById('btn-work-check');
  if (workCheckButton) {
    workCheckButton.onclick = () => {
      const log = document.getElementById('status-log');
      if (log) log.innerText = '⏳ 正在触发 Work 定时检查...';
      chrome.runtime.sendMessage({ action: 'run_chatgpt_work_check' }, (response) => {
        if (chrome.runtime.lastError) {
          if (log) log.innerText = `❌ 触发失败: ${chrome.runtime.lastError.message}`;
          return;
        }

        if (response && response.success) {
          if (log) log.innerText = `✅ Work 检查完成，序号: ${response.sequence}`;
          return;
        }

        const reason = response && (response.reason || response.error) ? response.reason || response.error : '未知错误';
        if (log) log.innerText = `⚠️ Work 检查未完成: ${reason}`;
      });
    };
  }

  const libraryCleanupButton = document.getElementById('btn-library-cleanup');
  if (libraryCleanupButton) {
    libraryCleanupButton.onclick = () => {
      sessionStorage.removeItem(LIBRARY_CLEANUP_RELOAD_COUNT_KEY);
      runLibraryCleanup();
    };
  }

  if (sessionStorage.getItem(LIBRARY_CLEANUP_STORAGE_KEY) === '1') {
    setTimeout(() => runLibraryCleanup(), 500);
  }
}

setTimeout(createPanel, 2000);
