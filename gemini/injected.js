(function() {
    console.log("🚀 [Injected] 网络监听器已启动 (XHR Only)");

    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;
    const originalCreateObjectURL = URL.createObjectURL;
    //     // 1. 标记目标请求
    // XMLHttpRequest.prototype.open = function(method, url) {
    //     // 【修改点】按照你的要求，监听 blob 协议的本地链接
    //     // console.log ("监听链接:", url);
    //     if (url && typeof url === 'string' && url.includes('blob:https://gemini.google.com/')) {
    //         console.log("📷 [Injected] 捕获到 Blob 请求初始化:", url);
    //         window.dispatchEvent(new CustomEvent('GEMINI_UPLOAD_COMPLETE'));
    //         // this._isGeminiBlobTarget = true;
          
    //     }
    //     return originalXHROpen.apply(this, arguments);
    // };

    // 1. 标记目标请求
    XMLHttpRequest.prototype.open = function(method, url) {
        // Google 图片上传接口特征
        if (url && typeof url === 'string' && url.includes('push.clients6.google.com/upload/')) {
            this._isGeminiUpload = true;
            // console.log("📷 [Injected] 捕获到上传请求初始化...");
        }
        return originalXHROpen.apply(this, arguments);
    };

    // 2. 监听请求完成
    XMLHttpRequest.prototype.send = function(body) {
        if (this._isGeminiUpload) {
            this.addEventListener('load', function() {
                this._isGeminiUpload = false;
                if (this.status === 200) {
                    console.log("✅ [Injected] 图片上传服务器确认成功 (200 OK)");
                    // 广播事件给 content.js
                    // --- 监听 URL.createObjectURL (捕获 Blob 生成瞬间) ---
                    let blob_count = 0
                    URL.createObjectURL = function(blob) {
                        const url = originalCreateObjectURL.apply(this, arguments);
                        console.log("🔨 [Injected] 生成了新的 Blob URL:", url);
                        // 这里通常不需要判断 url 字符串包含什么，因为刚生成的肯定符合当前域
                        // 如果你想过滤，可以判断 blob.type (例如是否为 image/png)
                        if (blob && blob.type && blob.type.startsWith('image/')) {
                            blob_count  += 1
                            console.log("📷 捕获到图片 Blob 生成:", blob_count);
                            // 这里可以触发你的事件
                            // window.dispatchEvent(new CustomEvent('GEMINI_UPLOAD_COMPLETE'));
                            if  (blob_count > 1) {
                                window.dispatchEvent(new CustomEvent('GEMINI_UPLOAD_COMPLETE'));
                            }
                           
                        }

                        return url;
                    };
                } else {
                    console.error("❌ [Injected] 图片上传失败", this.status);
                }
            });
        }
        return originalXHRSend.apply(this, arguments);
    };
})();


// console.log("🚀 [Injected] 网络监听器已启动 (XHR Only - Blob Mode)");

//     const originalXHROpen = XMLHttpRequest.prototype.open;
//     const originalXHRSend = XMLHttpRequest.prototype.send;

//     // 1. 标记目标请求
//     XMLHttpRequest.prototype.open = function(method, url) {
//         // 【修改点】按照你的要求，监听 blob 协议的本地链接
//         if (url && typeof url === 'string' && url.includes('blob:https://gemini.google.com/')) {
//             window.dispatchEvent(new CustomEvent('GEMINI_UPLOAD_COMPLETE'));
//             // this._isGeminiBlobTarget = true;
//             // console.log("📷 [Injected] 捕获到 Blob 请求初始化:", url);
//         }
//         return originalXHROpen.apply(this, arguments);
//     };

    // 2. 监听请求完成
    // XMLHttpRequest.prototype.send = function(body) {
    //     if (this._isGeminiBlobTarget) {
    //         this.addEventListener('load', function() {
    //             // 重置标记，避免污染
    //             this._isGeminiBlobTarget = false;
                
    //             // Blob 资源读取成功通常返回 200
    //             if (this.status === 200) {
    //                 console.log("✅ [Injected] Blob 资源加载完成 (视为上传成功)");
    //                 // 广播事件给 content.js
    //                 window.dispatchEvent(new CustomEvent('GEMINI_UPLOAD_COMPLETE'));
    //             } else {
    //                 console.error("❌ [Injected] Blob 资源加载失败", this.status);
    //             }
    //         });
    //     }
    //     return originalXHRSend.apply(this, arguments);
    // };