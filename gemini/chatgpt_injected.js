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
