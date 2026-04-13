// image_grabber.js
(async function() {
    // 只有当当前页面明显是一张图片时才执行（Chrome 打开图片时，body 下通常只有一个 img）
    // 或者直接判断 URL 结尾，或者因为 manifest 限制了域名，这里直接干
    
    console.log("📸 [Grabber] 图片 Tab 已打开，开始提取...");

    try {
        // 直接 Fetch 当前 URL (因为是在当前 Tab 请求自己，所以是同源，无 CORS 问题)
        const response = await fetch(window.location.href);
        const blob = await response.blob();

        const base64 = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.readAsDataURL(blob);
        });

        // 发送回 Background
        chrome.runtime.sendMessage({
            action: "imageCaptured",
            data: base64,
            url: window.location.href
        });
        
        console.log("✅ [Grabber] 提取成功，发送完毕");

    } catch (err) {
        console.error("❌ [Grabber] 提取失败", err);
        // 也要发消息回去，否则主程序会死等
        chrome.runtime.sendMessage({
            action: "imageCaptured",
            error: err.toString(),
            url: window.location.href
        });
    }
})();