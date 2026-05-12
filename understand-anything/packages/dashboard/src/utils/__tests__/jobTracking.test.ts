import { describe, expect, it } from "vitest";

import type { JobSnapshot, ProjectSummary } from "../astrbotBridge";
import {
  isActiveJob,
  jobForProject,
  projectAnalysisTarget,
  recentActivity,
  selectRecoverableJob,
} from "../jobTracking";

function job(
  id: string,
  status: JobSnapshot["status"],
  projectId: string,
  logs: string[] = [],
): JobSnapshot {
  return {
    job_id: id,
    kind: "understand",
    project_root: "D:/demo",
    args: { project_id: projectId },
    status,
    logs,
    progress: {
      phase: status,
      label: status,
      percent: status === "finished" ? 100 : 50,
      steps: [],
      updated_at: 1,
    },
    created_at: 1,
    updated_at: 1,
  };
}

describe("dashboard job tracking helpers", () => {
  it("recovers the newest active job from the server list", () => {
    const jobs = [
      job("done", "finished", "p1"),
      job("confirm", "waiting_confirmation", "p2"),
      job("active", "running", "p3"),
      job("queued", "queued", "p3"),
    ];

    expect(selectRecoverableJob(jobs)?.job_id).toBe("confirm");
    expect(selectRecoverableJob(jobs, job("current", "running", "p4"))?.job_id).toBe(
      "current",
    );
  });

  it("matches project cards with their latest job state", () => {
    const project: ProjectSummary = { project_id: "p1", name: "Demo" };

    expect(jobForProject(project, [job("j1", "running", "p1")])?.job_id).toBe("j1");
    expect(isActiveJob(job("j-confirm", "waiting_confirmation", "p1"))).toBe(true);
    expect(isActiveJob(job("j2", "failed", "p1"))).toBe(false);
  });

  it("uses raw logs first and structured progress as recent activity", () => {
    expect(recentActivity(job("j1", "running", "p1", ["Preparing runtime"]))).toBe(
      "Preparing runtime",
    );
    expect(recentActivity(job("j2", "running", "p1"))).toBe("running");
  });

  it("restarts GitHub projects from source metadata and local projects from path", () => {
    expect(
      projectAnalysisTarget({
        project_id: "p1",
        name: "Repo",
        path: "D:/cache/repo",
        source: { target_url: "https://github.com/owner/repo/tree/main/app" },
      }),
    ).toBe("https://github.com/owner/repo/tree/main/app");
    expect(projectAnalysisTarget({ project_id: "p2", name: "Local", path: "D:/app" })).toBe(
      "D:/app",
    );
  });
});
