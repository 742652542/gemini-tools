console.log('[ChatGPT Bot] Content Script Loaded');

let uploadRequestCompletedCount = 0;
let uploadRequestLastDetail = null;
let imageReplyFailureText = '';

const injectedScript = document.createElement('script');
injectedScript.src = chrome.runtime.getURL('chatgpt_injected.js');
injectedScript.onload = function() {
  this.remove();
};
(document.head || document.documentElement).appendChild(injectedScript);

window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || event.data.type !== 'CHATGPT_UPLOAD_COMPLETE') {
    return;
  }

  uploadRequestCompletedCount += 1;
  uploadRequestLastDetail = event.data;
  console.log('✅ 收到上传成功消息', event.data);
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
  return Array.from(
    document.querySelectorAll('section[data-testid^="conversation-turn-"][data-turn="assistant"]')
  );
}

function getLatestAssistantTurnSection() {
  const turns = getAssistantTurnSections();
  return turns.length > 0 ? turns[turns.length - 1] : null;
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

  return meaninglessTexts.has(normalized) ? '' : normalized;
}

function getMeaningfulAssistantTextFromTurn(turnSection) {
  if (!turnSection) return '';

  const markdownNode =
    turnSection.querySelector('[data-message-author-role="assistant"] .markdown') ||
    turnSection.querySelector('[data-message-author-role="assistant"]');

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
  return turnSection.getAttribute('data-turn-id') || turnSection.getAttribute('data-testid') || '';
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
    turn.querySelector('[data-message-author-role="assistant"]');
  if (!markdownNode) return '';

  return markdownNode.innerHTML || '';
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
    '[class*="group/imagegen-image"] img',
    'img[alt*="已生成图片"]',
    'img[alt*="Generated image"]',
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

  const latestTurn = getLatestAssistantTurnSection();
  if (!latestTurn) {
    return { status: 'error', data: '未找到 assistant 回复区块' };
  }

  const materialized = await waitForReplyImagesMaterialized(latestTurn, 60000);
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
      const hasReplyAction = !!(latestTurn && latestTurn.querySelector('button[aria-label*="复制回复"], button[aria-label*="Copy"]'));

      const baseReady = !stopBtn && hasNewAssistantReply && hasText && hasReplyAction && Date.now() - startTime > 1000;
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
    const initialTurn = getLatestAssistantTurnSection();
    const initialTurnIdentity = getTurnIdentity(initialTurn);
    const initialTurnWasReady = isImageReadyTurn(initialTurn);
    const initialTurnWasGenerating = isImageGeneratingTurn(initialTurn);
    const startTime = Date.now();
    const textStableDelayMs = 2200;
    let textStableStartAt = 0;
    let lastTextLength = -1;
    let lastStateKey = '';

    const cleanup = () => {
      observer.disconnect();
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
      const readyNow = isImageReadyTurn(latestTurn);
      const loadingNow = isImageGeneratingTurn(latestTurn);
      const hasTransitionSurface = hasImageTransitionSurface(latestTurn);
      const becameReadyOnSameTurn = !!latestTurnIdentity && latestTurnIdentity === initialTurnIdentity && !initialTurnWasReady && readyNow;
      const latest = getLatestAssistantMessage();
      const hasImageFallback = hasImageInAssistantMessage(latest) || !!(latestTurn && latestTurn.querySelector('img'));
      const hasReplyAction = !!(latestTurn && latestTurn.querySelector('button[aria-label*="复制回复"], button[aria-label*="Copy"]'));
      const textLength = getLastAssistantTextContent().length;
      const textCandidateReady = !stopBtn && !loadingNow && !hasTransitionSurface && textLength > 0;
      const canUseSameTurnFallback = !!latestTurnIdentity && latestTurnIdentity === initialTurnIdentity && initialTurnWasGenerating && !loadingNow;

      const stateKey = [
        stopBtn ? 'stop:1' : 'stop:0',
        loadingNow ? 'loading:1' : 'loading:0',
        readyNow ? 'ready:1' : 'ready:0',
        hasTransitionSurface ? 'trans:1' : 'trans:0',
        hasNewAssistantReply ? 'new:1' : 'new:0',
        hasImageFallback ? 'imgfb:1' : 'imgfb:0',
        hasReplyAction ? 'act:1' : 'act:0',
        `txt:${textLength}`
      ].join('|');

      if (stateKey !== lastStateKey) {
        lastStateKey = stateKey;
        console.log('🧭 [生图分支] 状态变化:', {
          elapsed: Date.now() - startTime,
          latestTurnIdentity,
          hasNewAssistantReply,
          loadingNow,
          readyNow,
          hasTransitionSurface,
          hasImageFallback,
          hasReplyAction,
          textLength,
          becameReadyOnSameTurn,
          canUseSameTurnFallback
        });
      }

      if (loadingNow) {
        textStableStartAt = 0;
        lastTextLength = -1;
        return;
      }

      if (!stopBtn && (hasNewAssistantReply || becameReadyOnSameTurn) && (readyNow || hasImageFallback) && hasReplyAction && Date.now() - startTime > 1000) {
        console.log('✅ [生图分支] 检测到图片回复完成');
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
          imageReplyFailureText = getLastAssistantTextContent() || '生图失败：返回了文本错误信息';
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

    const timer = setTimeout(() => {
      const finalText = getLastAssistantTextContent();
      const latestTurn = getLatestAssistantTurnSection();
      const hasTransitionSurface = hasImageTransitionSurface(latestTurn);
      if (finalText && !hasTransitionSurface && !imageReplyFailureText) {
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

  const pasted = inputBox.dispatchEvent(pasteEvent);
  if (!pasted) {
    console.warn('⚠️ 文本粘贴事件被拦截，准备走输入兜底');
    await setPromptText(text);
  }
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

async function clickGenerateImageButton(timeoutMs = 10000) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const composerButton =
      document.querySelector('button[data-testid="composer-plus-btn"]') ||
      document.querySelector('button#composer-plus-btn') ||
      document.querySelector('button[aria-label*="添加文件"]') ||
      document.querySelector('button[aria-label*="Add files"]') ||
      document.querySelector('button[aria-label*="Add photos"]');

    if (composerButton) {
      triggerElementClick(composerButton);
      console.log('已触发“添加文件等”按钮');
      await sleep(500);

      const expanded = composerButton.getAttribute('aria-expanded') === 'true';
      const hasMenu = !!document.querySelector('[role="menu"], [data-radix-popper-content-wrapper]');

      if (!expanded && !hasMenu) {
        await sleep(300);
        triggerElementClick(composerButton);
        await sleep(500);
      }

      const menuItems = Array.from(document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]'));
      const createImageItem = menuItems.find((item) => {
        const text = item.textContent ? item.textContent.trim() : '';
        return text.includes('创建图片') || text.includes('Create image');
      });

      if (createImageItem) {
        triggerElementClick(createImageItem);
        console.log('已点击“创建图片”菜单项');
        return true;
      }

      console.log('“添加文件等”已触发，但暂未找到“创建图片”菜单项，继续重试');
    }

    await sleep(1000);
  }

  console.log('未找到“创建图片”入口');
  return true;
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

function base64ToBlob(base64Data) {
  const mimeType = extractMimeFromBase64(base64Data) || 'image/png';
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

  return {
    mimeType,
    blob: new Blob(byteArrays, { type: mimeType })
  };
}

async function triggerImageDownload(taskId, base64Image) {
  if (!base64Image || typeof base64Image !== 'string') {
    throw new Error('缺少可下载的图片数据');
  }

  await new Promise((resolve) => {
    chrome.runtime.sendMessage(
      {
        action: 'prepare_intercept',
        task_id: taskId,
        task_action: 'generate_image'
      },
      () => resolve()
    );
  });

  await sleep(300);

  const { mimeType, blob } = base64ToBlob(base64Image);
  const extension = mimeType.split('/')[1] || 'png';
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = `chatgpt-${taskId}.${extension}`;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 30000);
}

async function typeAndSend(
  text = '帮我查询一下今天的天气',
  task_id = '',
  image = [],
  is_continue = false,
  action = 'generate_text',
  model = '',
  source = 'chatgpt'
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
      is_continue,
      textLength: typeof text === 'string' ? text.length : 0,
      imageCount: Array.isArray(image) ? image.length : 0
    });
    imageReplyFailureText = '';

    if (action === 'generate_image') {
      if (log) log.innerText = '⏳ 正在点击“生成图片”按钮...';
      await clickGenerateImageButton();
    }

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
        throw new Error(imageReplyFailureText);
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

    if (action === 'generate_image') {
      await triggerImageDownload(task_id, Array.isArray(returnData) ? returnData[0] : null);
    }

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
  source = 'chatgpt'
) {
  return typeAndSend(text, task_id, image, is_continue, action, model, source);
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
      request.source
    ).then(() => {
      sendResponse({ success: true });
    }).catch((err) => {
      sendResponse({ success: false, error: err && err.message ? err.message : String(err) });
    });
    return true;
  }
});

function createPanel() {
  if (document.getElementById('chatgpt-bot-panel')) return;

  const div = document.createElement('div');
  div.id = 'chatgpt-bot-panel';
  div.innerHTML = `
        <div style="position:fixed; bottom:80px; left:20px; z-index:99999; background:#202124; padding:15px; border-radius:8px; border:1px solid #5f6368; color:white; font-family:sans-serif; width:220px; box-shadow:0 4px 12px rgba(0,0,0,0.5);">
            <h3 style="margin:0 0 10px 0; font-size:14px; color:#e8eaed;">ChatGPT 全自动机器人</h3>
            <button id="btn-test" style="width:100%; padding:8px; background:#8ab4f8; border:none; border-radius:4px; cursor:pointer; color:#202124; font-weight:bold;">⚡ 运行图片上传测试</button>
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
}

setTimeout(createPanel, 2000);
