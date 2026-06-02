import { describe, expect, it } from "vitest";
import { toUserErrorMessage } from "../userErrors";

describe("toUserErrorMessage", () => {
  it("keeps backend Chinese errors unchanged", () => {
    expect(toUserErrorMessage(new Error("项目任务运行中，无法删除"))).toBe("项目任务运行中，无法删除");
  });

  it("localizes common browser and network failures", () => {
    expect(toUserErrorMessage(new Error("Failed to fetch"))).toBe("无法连接仪表盘服务，请确认容器正在运行并刷新页面。");
    expect(toUserErrorMessage(new Error("AbortError: operation was aborted"))).toBe("请求已取消。");
    expect(toUserErrorMessage(new Error("Unexpected token '<', \"<html>\" is not valid JSON"))).toBe(
      "服务返回的数据格式不正确，请刷新后重试。",
    );
    expect(toUserErrorMessage(new Error("Permission denied: EACCES"))).toBe("浏览器权限不足，无法完成当前操作。");
    expect(toUserErrorMessage(new Error("QuotaExceededError"))).toBe("浏览器本地存储空间不足，无法完成当前操作。");
  });

  it("uses the fallback for unknown non-Chinese errors", () => {
    expect(toUserErrorMessage(new Error("Something went wrong"), "自定义失败提示。")).toBe("自定义失败提示。");
    expect(toUserErrorMessage(undefined, "自定义失败提示。")).toBe("自定义失败提示。");
  });
});
