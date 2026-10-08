(function() {
  const originalFetch = window.fetch;
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  const LIBRARY_DELETE_BATCH_PATH = '/backend-api/files/library/files/delete-batch';
  let activeLibraryDeleteRequestId = '';

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

  function isLibraryDeleteBatchTarget(url) {
    if (!url) return false;
    try {
      return new URL(String(url), window.location.origin).pathname === LIBRARY_DELETE_BATCH_PATH;
    } catch (error) {
      return String(url).includes(LIBRARY_DELETE_BATCH_PATH);
    }
  }

  function notifyLibraryDeleteBatchResult(requestId, responseOk, status, data, error) {
    window.postMessage({
      type: 'CHATGPT_LIBRARY_DELETE_BATCH_RESULT',
      requestId: requestId || '',
      responseOk: responseOk === true,
      status: Number(status) || 0,
      data: data || null,
      error: error || ''
    }, '*');
  }

  async function inspectLibraryDeleteBatchFetchResponse(response, requestId) {
    try {
      const data = await response.json();
      notifyLibraryDeleteBatchResult(requestId, response.ok, response.status, data, '');
    } catch (error) {
      notifyLibraryDeleteBatchResult(
        requestId,
        response.ok,
        response.status,
        null,
        error && error.message ? error.message : String(error)
      );
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.type !== 'CHATGPT_LIBRARY_CONFIRM_DELETE') return;

    const requestId = event.data.requestId || '';
    try {
      const dialog = Array.from(document.querySelectorAll(
        '[role="dialog"], [role="alertdialog"], [data-radix-dialog-content]'
      )).find((element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      });
      const confirmButton = (
        dialog && dialog.querySelector('button[data-testid="confirm-delete-recall-file-button"]')
      ) || (
        dialog && dialog.querySelector('button[type="submit"][data-color="danger"]')
      ) || (
        dialog && Array.from(dialog.querySelectorAll('button[type="submit"], button')).find((button) => {
          const text = (button.innerText || button.textContent || '').replace(/\s+/g, '').trim().toLowerCase();
          return text === '删除' || text === 'delete';
        })
      );
      if (!confirmButton) throw new Error('找不到确认删除按钮');

      // 在 ChatGPT 主页面上下文中调用，避免内容脚本隔离环境与页面事件系统之间的差异。
      activeLibraryDeleteRequestId = requestId;
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
    const isLibraryDeleteBatch = isLibraryDeleteBatchTarget(requestUrl);
    const libraryDeleteRequestId = isLibraryDeleteBatch ? activeLibraryDeleteRequestId : '';
    let response;
    try {
      response = await originalFetch.apply(this, arguments);
    } catch (error) {
      if (isLibraryDeleteBatch) {
        notifyLibraryDeleteBatchResult(
          libraryDeleteRequestId,
          false,
          0,
          null,
          error && error.message ? error.message : String(error)
        );
      }
      throw error;
    }

    if (isUploadTarget(requestUrl, requestMethod) && response && response.status === 201) {
      console.log('✅ [Injected] 捕获到 fetch 图片上传成功', requestUrl);
      notifyUploadComplete(requestUrl, response.status);
    }

    if (isLibraryDeleteBatch) {
      inspectLibraryDeleteBatchFetchResponse(response.clone(), libraryDeleteRequestId);
    }

    return response;
  };

  XMLHttpRequest.prototype.open = function(method, url) {
    this._chatgptUploadMethod = method;
    this._chatgptUploadUrl = url;
    this._chatgptLibraryDeleteBatch = isLibraryDeleteBatchTarget(url);
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
    if (this._chatgptLibraryDeleteBatch) {
      const libraryDeleteRequestId = activeLibraryDeleteRequestId;
      this.addEventListener('load', function() {
        let data = null;
        let error = '';
        try {
          data = this.responseType === 'json' ? this.response : JSON.parse(this.responseText || 'null');
        } catch (parseError) {
          error = parseError && parseError.message ? parseError.message : String(parseError);
        }
        notifyLibraryDeleteBatchResult(
          libraryDeleteRequestId,
          this.status >= 200 && this.status < 300,
          this.status,
          data,
          error
        );
      });
      this.addEventListener('error', function() {
        notifyLibraryDeleteBatchResult(libraryDeleteRequestId, false, this.status, null, '批量删除请求失败');
      });
    }
    return originalXHRSend.apply(this, arguments);
  };
})();
