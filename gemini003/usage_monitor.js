console.log("[Gemini Usage] Usage monitor loaded");

const USAGE_REQUIRED_PATH = "/usage";
const DOM_POLL_INTERVAL_MS = 500;
const DOM_POLL_TIMEOUT_MS = 20000;

function normalizeWhitespace(value) {
    return (value || "").replace(/\s+/g, " ").trim();
}

function getTextContent(element) {
    return normalizeWhitespace(element ? element.textContent : "");
}

function firstMatch(text, pattern) {
    const match = normalizeWhitespace(text).match(pattern);
    return match ? normalizeWhitespace(match[1] || match[0]) : "";
}

function extractUpdatedAtTextFromElements(elements) {
    const texts = Array.from(elements || [])
        .map((element) => getTextContent(element))
        .filter(Boolean);

    for (const text of texts) {
        if (/^(刚刚更新|刚刚|\d+\s*分钟前|\d+\s*小时前|\d+\s*minutes? ago|\d+\s*hours? ago)$/i.test(text)) {
            return text;
        }

        if (/更新时间[:：]|updated/i.test(text)) {
            return text;
        }
    }

    return "";
}

function getResetTimestampFromText(text) {
    const normalized = normalizeWhitespace(text).replace(/^重置时间[:：]\s*/, "");
    if (!normalized) return null;

    const now = new Date();
    const timeOnlyMatch = normalized.match(/^(\d{1,2}):(\d{2})$/);
    if (timeOnlyMatch) {
        const parsed = new Date(now);
        parsed.setSeconds(0, 0);
        parsed.setHours(Number(timeOnlyMatch[1]), Number(timeOnlyMatch[2]), 0, 0);
        if (parsed.getTime() <= now.getTime()) {
            parsed.setDate(parsed.getDate() + 1);
        }
        return String(Math.floor(parsed.getTime() / 1000));
    }

    const monthDayTimeMatch = normalized.match(/^(\d{1,2})月(\d{1,2})日(\d{1,2}):(\d{2})$/);
    if (monthDayTimeMatch) {
        const parsed = new Date(now.getFullYear(), Number(monthDayTimeMatch[1]) - 1, Number(monthDayTimeMatch[2]), Number(monthDayTimeMatch[3]), Number(monthDayTimeMatch[4]), 0, 0);
        if (parsed.getTime() <= now.getTime()) {
            parsed.setFullYear(parsed.getFullYear() + 1);
        }
        return String(Math.floor(parsed.getTime() / 1000));
    }

    return parseResetTimestamp(normalized);
}

function findPercentNearLabel(text, labelPatterns) {
    const lines = text
        .split(/\r?\n/)
        .map((line) => normalizeWhitespace(line))
        .filter(Boolean);

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!labelPatterns.some((pattern) => pattern.test(line))) continue;

        for (let cursor = index; cursor < Math.min(lines.length, index + 6); cursor += 1) {
            const percentMatch = lines[cursor].match(/\b\d{1,3}%\b/);
            if (percentMatch) {
                return percentMatch[0];
            }
        }
    }

    return null;
}

function parseResetTimestamp(text) {
    const normalized = normalizeWhitespace(text);
    if (!normalized) return null;

    const timestampMatch = normalized.match(/\b(1\d{9}|2\d{9})\b/);
    if (timestampMatch) {
        return timestampMatch[1];
    }

    const dateMatch = normalized.match(/(\d{4}[\/-]\d{1,2}[\/-]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)/);
    if (dateMatch) {
        const parsed = new Date(dateMatch[1].replace(/-/g, "/"));
        if (!Number.isNaN(parsed.getTime())) {
            return String(Math.floor(parsed.getTime() / 1000));
        }
    }

    const monthNameMatch = normalized.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/i);
    if (monthNameMatch) {
        const parsed = new Date(monthNameMatch[0]);
        if (!Number.isNaN(parsed.getTime())) {
            return String(Math.floor(parsed.getTime() / 1000));
        }
    }

    return null;
}

function findResetTimeNearLabel(text, labelPatterns) {
    const lines = text
        .split(/\r?\n/)
        .map((line) => normalizeWhitespace(line))
        .filter(Boolean);

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!labelPatterns.some((pattern) => pattern.test(line))) continue;

        for (let cursor = index; cursor < Math.min(lines.length, index + 8); cursor += 1) {
            const timestamp = parseResetTimestamp(lines[cursor]);
            if (timestamp) {
                return timestamp;
            }
        }
    }

    return null;
}

function findUpdatedAtText(text) {
    const lines = text
        .split(/\r?\n/)
        .map((line) => normalizeWhitespace(line))
        .filter(Boolean);

    for (const line of lines) {
        if (/updated|更新|分钟前|小時前|小时前|hours? ago|minutes? ago/i.test(line)) {
            return line;
        }
    }

    return null;
}

function findTier(text) {
    const lines = text
        .split(/\r?\n/)
        .map((line) => normalizeWhitespace(line))
        .filter(Boolean);

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const directMatch = line.match(/\b(AI\s*PLUS|PLUS|PRO|ULTRA|FREE|ADVANCED)\b/i);
        if (directMatch) {
            return directMatch[1].replace(/\s+/g, " ").toUpperCase();
        }

        if (/tier|plan|subscription|方案|订阅|等级/i.test(line)) {
            for (let cursor = index; cursor < Math.min(lines.length, index + 4); cursor += 1) {
                const tierMatch = lines[cursor].match(/\b(AI\s*PLUS|PLUS|PRO|ULTRA|FREE|ADVANCED)\b/i);
                if (tierMatch) {
                    return tierMatch[1].replace(/\s+/g, " ").toUpperCase();
                }
            }
        }
    }

    return null;
}

function extractUsageSnapshot() {
    if (!window.location.pathname.includes(USAGE_REQUIRED_PATH)) {
        return null;
    }

    const usageRoot = document.querySelector("usage-metrics-window");
    if (usageRoot) {
        const tierText = getTextContent(document.querySelector("usage-metrics-window .tier-pill"));
        const descriptionElements = document.querySelectorAll("usage-metrics-window .usage-metrics-description p");
        const descriptionText = getTextContent(document.querySelector("usage-metrics-window .usage-metrics-description"));
        const updatedAtText = extractUpdatedAtTextFromElements(descriptionElements) || firstMatch(descriptionText, /(更新时间[:：]\s*.*|刚刚更新|刚刚|\d+\s*分钟前|\d+\s*小时前|\d+\s*minutes? ago|\d+\s*hours? ago)/i);

        const currentCard = document.querySelector('usage-metrics-window [data-test-id="gxu-currently"]');
        const weeklyCard = document.querySelector('usage-metrics-window [data-test-id="gxu-weekly"]');
        const currentCardText = getTextContent(currentCard);
        const weeklyCardText = getTextContent(weeklyCard);

        const currentUsedText = firstMatch(currentCardText, /已使用\s*(\d{1,3}%)/);
        const weeklyUsedText = firstMatch(weeklyCardText, /已使用\s*(\d{1,3}%)/);

        const currentResetText = firstMatch(currentCardText, /(重置时间[:：]\s*(?:\d{1,2}:\d{2}|\d{1,2}月\d{1,2}日\d{1,2}:\d{2}))/);
        const weeklyResetText = firstMatch(weeklyCardText, /(重置时间[:：]\s*(?:\d{1,2}:\d{2}|\d{1,2}月\d{1,2}日\d{1,2}:\d{2}))/);

        const normalizedTier = normalizeWhitespace(tierText).toUpperCase() || findTier(getTextContent(usageRoot)) || "UNKNOWN";

        const snapshot = {
            current: {
                usedText: currentUsedText,
                resetTime: getResetTimestampFromText(currentResetText)
            },
            weekly: {
                usedText: weeklyUsedText,
                resetTime: getResetTimestampFromText(weeklyResetText)
            },
            updatedAtText,
            tier: normalizedTier
        };

        if (snapshot.current.usedText && snapshot.weekly.usedText) {
            console.log("[Gemini Usage] 通过精确选择器提取成功", snapshot);
            console.log("[Gemini Usage] 提取结果(JSON)", JSON.stringify(snapshot));
            return snapshot;
        }

        console.warn("[Gemini Usage] 精确提取未完成", {
            tierText,
            descriptionText,
            currentCardText,
            weeklyCardText,
            snapshot
        });
    }

    const rawPageText = document.body ? document.body.innerText || "" : "";
    if (!normalizeWhitespace(rawPageText)) {
        return null;
    }
    const pageText = rawPageText;

    const currentLabels = [/current/i, /today/i, /当前/i, /今日/i];
    const weeklyLabels = [/weekly/i, /week/i, /本周/i, /每周/i, /7\s*days?/i];

    const snapshot = {
        current: {
            usedText: findPercentNearLabel(pageText, currentLabels),
            resetTime: findResetTimeNearLabel(pageText, currentLabels)
        },
        weekly: {
            usedText: findPercentNearLabel(pageText, weeklyLabels),
            resetTime: findResetTimeNearLabel(pageText, weeklyLabels)
        },
        updatedAtText: findUpdatedAtText(pageText),
        tier: findTier(pageText)
    };

    if (!snapshot.current.usedText || !snapshot.weekly.usedText) {
        console.warn("[Gemini Usage] 文本兜底提取失败");
        return null;
    }

    console.log("[Gemini Usage] 通过文本兜底提取成功", snapshot);
    console.log("[Gemini Usage] 提取结果(JSON)", JSON.stringify(snapshot));
    return snapshot;
}

function waitForUsageSnapshot() {
    return new Promise((resolve) => {
        const startTime = Date.now();

        const finish = (value) => {
            clearInterval(timer);
            resolve(value);
        };

        const check = () => {
            const snapshot = extractUsageSnapshot();
            if (snapshot) {
                finish(snapshot);
                return;
            }

            if (Date.now() - startTime >= DOM_POLL_TIMEOUT_MS) {
                finish(null);
            }
        };

        const timer = setInterval(check, DOM_POLL_INTERVAL_MS);
        check();
    });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action !== "collect_usage_snapshot") {
        return false;
    }

    waitForUsageSnapshot().then((snapshot) => {
        if (!snapshot) {
            const debug = {
                pathname: window.location.pathname,
                hasUsageWindow: !!document.querySelector("usage-metrics-window"),
                bodyPreview: normalizeWhitespace(document.body ? document.body.innerText || "" : "").slice(0, 500)
            };
            console.warn("[Gemini Usage] 未能提取 usage 数据", debug);
            sendResponse({ success: false, debug });
            return;
        }

        console.log("[Gemini Usage] 返回 usage 数据给 background");
        sendResponse({ success: true, data: snapshot });
    }).catch(() => {
        console.warn("[Gemini Usage] 提取过程中发生异常");
        sendResponse({ success: false, debug: { pathname: window.location.pathname } });
    });

    return true;
});
