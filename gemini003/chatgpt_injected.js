(function() {
  const originalFetch = window.fetch;
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  function isUploadTarget(url, method) {
    if (!url || typeof url !== 'string') return false;
    const upperMethod = typeof method === 'string' ? method.toUpperCase() : '';
    return upperMethod === 'PUT' && url.includes('oaiusercontent.com/files/') && url.includes('/raw');
  }

  function notifyUploadComplete(url, status) {
    const payload = {
      type: 'CHATGPT_UPLOAD_COMPLETE',
      url,
      status
    };

    window.dispatchEvent(new CustomEvent('CHATGPT_UPLOAD_COMPLETE', {
      detail: { url, status }
    }));
    window.postMessage(payload, '*');
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.type !== 'CHATGPT_LIBRARY_CONFIRM_DELETE') return;

    const requestId = event.data.requestId || '';
    try {
      const confirmButton = document.querySelector('button[data-testid="confirm-delete-recall-file-button"]');
      if (!confirmButton) throw new Error('找不到确认删除按钮');

      // 在 ChatGPT 主页面上下文中调用，避免内容脚本隔离环境与页面事件系统之间的差异。
      confirmButton.click();
      window.postMessage({
        type: 'CHATGPT_LIBRARY_CONFIRM_DELETE_RESULT',
        requestId,
        success: true
      }, '*');
    } catch (error) {
      window.postMessage({
        type: 'CHATGPT_LIBRARY_CONFIRM_DELETE_RESULT',
        requestId,
        success: false,
        error: error && error.message ? error.message : String(error)
      }, '*');
    }
  });

  window.fetch = async function(input, init) {
    const requestUrl = typeof input === 'string' ? input : input && input.url;
    const requestMethod = init && init.method ? init.method : input && input.method;
    const response = await originalFetch.apply(this, arguments);

    if (isUploadTarget(requestUrl, requestMethod) && response && response.status === 201) {
      console.log('✅ [Injected] 捕获到 fetch 图片上传成功', requestUrl);
      notifyUploadComplete(requestUrl, response.status);
    }

    return response;
  };

  XMLHttpRequest.prototype.open = function(method, url) {
    this._chatgptUploadMethod = method;
    this._chatgptUploadUrl = url;
    return originalXHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function() {
    if (isUploadTarget(this._chatgptUploadUrl, this._chatgptUploadMethod)) {
      this.addEventListener('load', function() {
        if (this.status === 201) {
          console.log('✅ [Injected] 捕获到 xhr 图片上传成功', this._chatgptUploadUrl);
          notifyUploadComplete(this._chatgptUploadUrl, this.status);
        }
      });
    }
    return originalXHRSend.apply(this, arguments);
  };
})();
