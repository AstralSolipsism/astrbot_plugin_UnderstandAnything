export function toUserErrorMessage(error: unknown, fallback = "操作失败，请稍后重试。"): string {
  const raw = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "";
  const message = raw.trim();
  if (!message) return fallback;
  if (/[\u4e00-\u9fff]/u.test(message)) return message;
  if (/AbortError|aborted|operation was aborted/i.test(message)) {
    return "请求已取消。";
  }
  if (
    /Failed to fetch|fetch failed|NetworkError|Load failed|Network request failed|ERR_CONNECTION_REFUSED|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|timeout/i.test(message)
  ) {
    return "无法连接仪表盘服务，请确认容器正在运行并刷新页面。";
  }
  if (/Unexpected token|Unexpected end|JSON|parse/i.test(message)) {
    return "服务返回的数据格式不正确，请刷新后重试。";
  }
  if (/Permission denied|EACCES/i.test(message)) {
    return "浏览器权限不足，无法完成当前操作。";
  }
  if (/QuotaExceededError|quota/i.test(message)) {
    return "浏览器本地存储空间不足，无法完成当前操作。";
  }
  return fallback;
}
