(async function() {
  console.log('[ChatGPT Grabber] image tab opened');

  try {
    const response = await fetch(window.location.href);
    const blob = await response.blob();

    const base64 = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });

    chrome.runtime.sendMessage({
      action: 'imageCaptured',
      data: base64,
      url: window.location.href
    });
  } catch (err) {
    chrome.runtime.sendMessage({
      action: 'imageCaptured',
      error: err.toString(),
      url: window.location.href
    });
  }
})();
