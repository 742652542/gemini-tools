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

  function isLibraryBatchDeleteTarget(url, method) {
    if (!url) return false;
    const normalizedUrl = typeof url === 'string' ? url : String(url);
    const upperMethod = typeof method === 'string' ? method.toUpperCase() : '';
    return upperMethod === 'POST' && normalizedUrl.includes('/backend-api/files/library/files/delete-batch');
  }

  function notifyLibraryBatchDelete(phase, url, status) {
    window.postMessage({
      type: 'CHATGPT_LIBRARY_DELETE_BATCH',
      phase,
      url: typeof url === 'string' ? url : String(url || ''),
      status: typeof status === 'number' ? status : 0
    }, '*');
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
    const isBatchDelete = isLibraryBatchDeleteTarget(requestUrl, requestMethod);
    if (isBatchDelete) notifyLibraryBatchDelete('start', requestUrl, 0);

    let response;
    try {
      response = await originalFetch.apply(this, arguments);
    } catch (err) {
      if (isBatchDelete) notifyLibraryBatchDelete('complete', requestUrl, 0);
      throw err;
    }

    if (isUploadTarget(requestUrl, requestMethod) && response && response.status === 201) {
      console.log('✅ [Injected] 捕获到 fetch 图片上传成功', requestUrl);
      notifyUploadComplete(requestUrl, response.status);
    }

    if (isBatchDelete) {
      console.log('✅ [Injected] 捕获到资料库批量删除请求完成', requestUrl, response && response.status);
      notifyLibraryBatchDelete('complete', requestUrl, response ? response.status : 0);
    }

    return response;
  };

  XMLHttpRequest.prototype.open = function(method, url) {
    this._chatgptUploadMethod = method;
    this._chatgptUploadUrl = url;
    this._chatgptLibraryDeleteMethod = method;
    this._chatgptLibraryDeleteUrl = url;
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

    if (isLibraryBatchDeleteTarget(this._chatgptLibraryDeleteUrl, this._chatgptLibraryDeleteMethod)) {
      notifyLibraryBatchDelete('start', this._chatgptLibraryDeleteUrl, 0);
      this.addEventListener('loadend', function() {
        console.log('✅ [Injected] 捕获到资料库批量删除 XHR 完成', this._chatgptLibraryDeleteUrl, this.status);
        notifyLibraryBatchDelete('complete', this._chatgptLibraryDeleteUrl, this.status);
      }, { once: true });
    }

    return originalXHRSend.apply(this, arguments);
  };
})();
