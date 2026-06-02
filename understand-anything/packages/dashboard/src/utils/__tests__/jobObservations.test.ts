import { describe, expect, it, vi } from "vitest";
import { normalizeJobObservations } from "../jobObservations";

describe("normalizeJobObservations", () => {
  it("uses structured observations when the server provides them", () => {
    const observations = normalizeJobObservations({
      id: "job-1",
      status: "running",
      stage: "调用 AstrBot Provider",
      recentLogs: ["[12:00:00] chunk"],
      observations: [
        {
          id: "obs-1",
          createdAt: "2026-05-31T00:00:00.000Z",
          kind: "assistant",
          level: "info",
          title: "调用 AstrBot Provider",
          message: "AstrBot Provider 最近输出：正在生成图谱",
          status: "running",
        },
      ],
    });

    expect(observations).toHaveLength(1);
    expect(observations[0]?.id).toBe("obs-1");
  });

  it("falls back to recent logs for old jobs", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-31T00:00:00.000Z"));
    const observations = normalizeJobObservations({
      id: "job-2",
      status: "failed",
      stage: "调用 AstrBot Provider",
      recentLogs: [
        "[12:00:00] 开始：调用 AstrBot Provider 生成知识图谱",
        "[12:00:01] 失败：调用 AstrBot Provider 生成知识图谱 长时间无输出，已终止进程",
      ],
    });

    expect(observations).toHaveLength(2);
    expect(observations[0]?.kind).toBe("command");
    expect(observations[0]?.title).toBe("命令执行");
    expect(observations[1]?.level).toBe("error");
    expect(observations[1]?.title).toBe("任务失败");
    expect(observations.map((item) => item.title)).not.toContain("原始日志片段");
    expect(observations.map((item) => item.title)).not.toContain("原始命令日志");
    vi.useRealTimers();
  });

  it("creates a summary observation when an old job has no logs", () => {
    const observations = normalizeJobObservations({
      id: "job-3",
      status: "finished",
      stage: "分析完成",
      summary: "分析完成：10 个节点，12 条关系。",
      recentLogs: [],
    });

    expect(observations).toHaveLength(1);
    expect(observations[0]?.kind).toBe("success");
    expect(observations[0]?.message).toContain("10 个节点");
  });
});
