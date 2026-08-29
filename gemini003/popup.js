const ACCOUNT_STORAGE_KEY = 'gemini_bot_account';
const ID_STORAGE_KEY = 'gemini_bot_id';
const NAME_STORAGE_KEY = 'gemini_bot_name';
const PROXY_ID_STORAGE_KEY = 'gemini_bot_proxy_id';
const AUTH_URL_STORAGE_KEY = 'gemini_bot_auth_url';
const SESSION_ID_STORAGE_KEY = 'gemini_bot_session_id';
const STATE_STORAGE_KEY = 'gemini_bot_state';
const CODE_STORAGE_KEY = 'gemini_bot_code';
const AUTH_URL_ENDPOINT = 'https://ixspy.com/api/v1/admin/openai/generate-auth-url';
const EXCHANGE_CODE_ENDPOINT = 'https://ixspy.com/api/v1/admin/openai/exchange-code';
const ACCOUNT_INFO_ENDPOINT = 'https://ixspy.com/api/v1/admin/openai/account-info';

const accountInput = document.getElementById('account-input');
const accountInfoText = document.getElementById('account-info');
const startAuthBtn = document.getElementById('start-auth');
const reauthAccountBtn = document.getElementById('reauth-account');
const clearAccountBtn = document.getElementById('clear-account');
const statusText = document.getElementById('status-text');

function setStatus(message, type = '') {
  statusText.textContent = message;
  statusText.className = type ? `status ${type}` : 'status';
}

function getAccount() {
  return accountInput.value.trim();
}

function saveAccountInfo(account, data) {
  return chrome.storage.local.set({
    [ACCOUNT_STORAGE_KEY]: account,
    [ID_STORAGE_KEY]: data.id,
    [NAME_STORAGE_KEY]: data.name,
    [PROXY_ID_STORAGE_KEY]: data.proxy_id
  });
}

function clearGeneratedAuthInfo() {
  return chrome.storage.local.remove([
    AUTH_URL_STORAGE_KEY,
    SESSION_ID_STORAGE_KEY,
    STATE_STORAGE_KEY,
    CODE_STORAGE_KEY
  ]);
}

function getJsonMessage(data, fallback) {
  if (!data) return fallback;
  return data.message || data.error || fallback;
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch (error) {
    return { message: text };
  }
}

function assertApiSuccess(response, data) {
  if (!response.ok) {
    throw new Error(getJsonMessage(data, `请求失败: ${response.status}`));
  }

  if (data && Object.prototype.hasOwnProperty.call(data, 'code') && data.code !== 0) {
    throw new Error(getJsonMessage(data, '接口返回失败'));
  }
}

function extractStateFromAuthUrl(authUrl) {
  try {
    return new URL(authUrl).searchParams.get('state') || '';
  } catch (error) {
    return '';
  }
}

function hasAccountInfo(authInfo) {
  return Boolean(authInfo[ID_STORAGE_KEY] && authInfo[NAME_STORAGE_KEY] && authInfo[PROXY_ID_STORAGE_KEY]);
}

function updateAccountInfoText(authInfo) {
  if (!hasAccountInfo(authInfo)) {
    accountInfoText.textContent = '';
    return;
  }

  accountInfoText.textContent = `账号：${authInfo[NAME_STORAGE_KEY]}，ID：${authInfo[ID_STORAGE_KEY]}，代理ID：${authInfo[PROXY_ID_STORAGE_KEY]}`;
}

function updateButtonByAuthState(authInfo) {
  reauthAccountBtn.hidden = !hasAccountInfo(authInfo);

  if (authInfo[SESSION_ID_STORAGE_KEY] && authInfo[STATE_STORAGE_KEY] && authInfo[CODE_STORAGE_KEY]) {
    startAuthBtn.textContent = '完成授权';
    startAuthBtn.dataset.mode = 'complete';
    return;
  }

  if (!hasAccountInfo(authInfo)) {
    startAuthBtn.textContent = '获取账号信息';
    startAuthBtn.dataset.mode = 'fetch-account';
    return;
  }

  startAuthBtn.textContent = '开始授权';
  startAuthBtn.dataset.mode = 'start';
}

async function startAuthorizationFlow(storedInfo, statusMessage = '正在请求授权地址...') {
  if (!hasAccountInfo(storedInfo)) {
    throw new Error('账号信息不完整，请先获取账号信息。');
  }

  setStatus(statusMessage);
  await clearGeneratedAuthInfo();
  const data = await requestAuthUrl(storedInfo[PROXY_ID_STORAGE_KEY]);
  const authUrl = data && data.data ? data.data.auth_url : '';
  const sessionId = data && data.data ? data.data.session_id : '';
  const state = extractStateFromAuthUrl(authUrl);

  if (!authUrl || !sessionId || !state) {
    throw new Error('授权地址数据不完整。');
  }

  await chrome.storage.local.set({
    [AUTH_URL_STORAGE_KEY]: authUrl,
    [SESSION_ID_STORAGE_KEY]: sessionId,
    [STATE_STORAGE_KEY]: state
  });

  updateButtonByAuthState({
    ...storedInfo,
    [AUTH_URL_STORAGE_KEY]: authUrl,
    [SESSION_ID_STORAGE_KEY]: sessionId,
    [STATE_STORAGE_KEY]: state
  });
  setStatus('授权地址已生成，正在打开授权页面。', 'success');
  await chrome.tabs.create({ url: authUrl, active: true });
}

async function requestAccountInfo(email) {
  const response = await fetch(ACCOUNT_INFO_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ email })
  });

  const data = await parseJsonResponse(response);
  assertApiSuccess(response, data);

  if (!data || !data.data || !data.data.id || !data.data.name || !data.data.proxy_id) {
    throw new Error('账号信息不完整。');
  }

  return data.data;
}

async function requestAuthUrl(proxyId) {
  const response = await fetch(AUTH_URL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ proxy_id: proxyId })
  });

  const data = await parseJsonResponse(response);
  assertApiSuccess(response, data);

  return data;
}

async function exchangeCode(payload) {
  const response = await fetch(EXCHANGE_CODE_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await parseJsonResponse(response);
  assertApiSuccess(response, data);
  return data;
}

async function loadAuthInfo() {
  const result = await chrome.storage.local.get([
    ACCOUNT_STORAGE_KEY,
    ID_STORAGE_KEY,
    NAME_STORAGE_KEY,
    PROXY_ID_STORAGE_KEY,
    AUTH_URL_STORAGE_KEY,
    SESSION_ID_STORAGE_KEY,
    STATE_STORAGE_KEY,
    CODE_STORAGE_KEY
  ]);
  const account = result[ACCOUNT_STORAGE_KEY] || '';
  accountInput.value = account;
  updateAccountInfoText(result);
  updateButtonByAuthState(result);
  if (account || hasAccountInfo(result)) {
    setStatus('已读取本地授权信息。');
  }

  if (result[CODE_STORAGE_KEY] && result[SESSION_ID_STORAGE_KEY] && result[STATE_STORAGE_KEY]) {
    setStatus('已获取授权回调，请点击完成授权。', 'success');
  }
}

startAuthBtn.addEventListener('click', async () => {
  const account = getAccount();
  if (!account) {
    setStatus('请输入邮箱。', 'error');
    accountInput.focus();
    return;
  }

  startAuthBtn.disabled = true;

  try {
    const storedInfo = await chrome.storage.local.get([
      ACCOUNT_STORAGE_KEY,
      ID_STORAGE_KEY,
      NAME_STORAGE_KEY,
      PROXY_ID_STORAGE_KEY
    ]);
    const currentMode = storedInfo[ACCOUNT_STORAGE_KEY] !== account || !hasAccountInfo(storedInfo) ? 'fetch-account' : startAuthBtn.dataset.mode;

    if (currentMode === 'fetch-account') {
      setStatus('正在获取账号信息...');
      await clearGeneratedAuthInfo();
      const accountInfo = await requestAccountInfo(account);
      await saveAccountInfo(account, accountInfo);
      const refreshedInfo = await chrome.storage.local.get([
        ACCOUNT_STORAGE_KEY,
        ID_STORAGE_KEY,
        NAME_STORAGE_KEY,
        PROXY_ID_STORAGE_KEY
      ]);
      updateAccountInfoText(refreshedInfo);
      updateButtonByAuthState(refreshedInfo);
      setStatus('账号信息已获取，请点击开始授权。', 'success');
      return;
    }

    if (currentMode === 'complete') {
      const result = await chrome.storage.local.get([
        SESSION_ID_STORAGE_KEY,
        STATE_STORAGE_KEY,
        CODE_STORAGE_KEY,
        ID_STORAGE_KEY,
        PROXY_ID_STORAGE_KEY
      ]);
      const payload = {
        session_id: result[SESSION_ID_STORAGE_KEY],
        code: result[CODE_STORAGE_KEY],
        state: result[STATE_STORAGE_KEY],
        id: result[ID_STORAGE_KEY],
        proxy_id: result[PROXY_ID_STORAGE_KEY]
      };

      if (!payload.session_id || !payload.code || !payload.state || !payload.id || !payload.proxy_id) {
        throw new Error('授权数据不完整，请重新开始授权。');
      }

      setStatus('正在完成授权...');
      await exchangeCode(payload);
      setStatus('授权已完成。', 'success');
      return;
    }

    await startAuthorizationFlow(storedInfo);
  } catch (error) {
    console.error('授权请求失败:', error);
    setStatus(error.message || '授权请求失败。', 'error');
  } finally {
    startAuthBtn.disabled = false;
  }
});

reauthAccountBtn.addEventListener('click', async () => {
  reauthAccountBtn.disabled = true;
  startAuthBtn.disabled = true;

  try {
    const storedInfo = await chrome.storage.local.get([
      ACCOUNT_STORAGE_KEY,
      ID_STORAGE_KEY,
      NAME_STORAGE_KEY,
      PROXY_ID_STORAGE_KEY
    ]);
    await startAuthorizationFlow(storedInfo, '正在重新请求授权地址...');
  } catch (error) {
    console.error('重新授权请求失败:', error);
    setStatus(error.message || '重新授权请求失败。', 'error');
  } finally {
    reauthAccountBtn.disabled = false;
    startAuthBtn.disabled = false;
  }
});

clearAccountBtn.addEventListener('click', async () => {
  await chrome.storage.local.remove([
    ACCOUNT_STORAGE_KEY,
    ID_STORAGE_KEY,
    NAME_STORAGE_KEY,
    PROXY_ID_STORAGE_KEY,
    AUTH_URL_STORAGE_KEY,
    SESSION_ID_STORAGE_KEY,
    STATE_STORAGE_KEY,
    CODE_STORAGE_KEY
  ]);
  accountInput.value = '';
  accountInfoText.textContent = '';
  updateButtonByAuthState({});
  setStatus('授权信息已清空。');
  accountInput.focus();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[CODE_STORAGE_KEY]) return;

  loadAuthInfo().catch((error) => {
    console.error('刷新授权信息失败:', error);
  });
});

accountInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    startAuthBtn.click();
  }
});

accountInput.addEventListener('input', async () => {
  const account = getAccount();
  const result = await chrome.storage.local.get([
    ACCOUNT_STORAGE_KEY,
    ID_STORAGE_KEY,
    NAME_STORAGE_KEY,
    PROXY_ID_STORAGE_KEY,
    SESSION_ID_STORAGE_KEY,
    STATE_STORAGE_KEY,
    CODE_STORAGE_KEY
  ]);

  if (account && result[ACCOUNT_STORAGE_KEY] === account && hasAccountInfo(result)) {
    updateAccountInfoText(result);
    updateButtonByAuthState(result);
    return;
  }

  accountInfoText.textContent = '';
  updateButtonByAuthState({});
});

loadAuthInfo().catch((error) => {
  console.error('读取授权信息失败:', error);
  setStatus('读取本地授权信息失败。', 'error');
});
