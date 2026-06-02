import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type ProjectSummary,
  pluginGet,
} from "../utils/astrbotBridge";
import { currentBridge } from "../utils/pluginPageContext";
import { toUserErrorMessage } from "../utils/userErrors";

interface ProjectView {
  id: string;
  name: string;
  status: string;
}

interface ProjectSwitcherProps {
  currentProjectId?: string;
  currentProjectName?: string;
  onOpenProject?: (projectId: string) => void;
  compact?: boolean;
}

const STATUS_LABELS: Record<string, string> = {
  empty: "待分析",
  cloning: "克隆中",
  analyzing: "分析中",
  ready: "可查看",
  stale: "有更新",
  failed: "失败",
  deleting: "删除中",
};

export default function ProjectSwitcher({
  currentProjectId,
  currentProjectName,
  onOpenProject,
  compact = false,
}: ProjectSwitcherProps) {
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    if (!currentProjectId || !onOpenProject) return;
    const bridge = currentBridge();
    if (!bridge) return;
    try {
      const data = await pluginGet<{ projects: ProjectSummary[] }>(bridge, "projects");
      setProjects(
        data.projects.map((project) => ({
          id: project.project_id,
          name: project.name,
          status: project.status ?? "empty",
        })),
      );
      setError(null);
    } catch (err) {
      setError(toUserErrorMessage(err, "项目列表加载失败，请刷新页面重试。"));
    }
  }, [currentProjectId, onOpenProject]);

  useEffect(() => {
    void loadProjects();
    const timer = window.setInterval(() => void loadProjects(), 10000);
    return () => window.clearInterval(timer);
  }, [loadProjects]);

  const options = useMemo(() => {
    if (!currentProjectId) return projects;
    if (projects.some((project) => project.id === currentProjectId)) return projects;
    return [
      {
        id: currentProjectId,
        name: currentProjectName || "当前项目",
        status: "ready",
      },
      ...projects,
    ];
  }, [currentProjectId, currentProjectName, projects]);

  if (!currentProjectId || !onOpenProject) {
    return (
      <h1 className="font-heading text-base sm:text-lg text-text-primary tracking-wide truncate max-w-[160px] sm:max-w-[220px] lg:max-w-none">
        {currentProjectName ?? "项目理解仪表盘"}
      </h1>
    );
  }

  return (
    <div className={compact ? "min-w-0 flex-1" : "min-w-[180px] max-w-[300px]"}>
      <label className="sr-only" htmlFor="project-switcher">
        切换项目
      </label>
      <select
        id="project-switcher"
        value={currentProjectId}
        onChange={(event) => onOpenProject(event.target.value)}
        title={error ?? "切换项目"}
        className={`w-full rounded-md border border-border-medium bg-elevated px-3 py-1.5 text-sm text-text-primary outline-none transition-colors hover:border-accent focus:border-accent ${
          compact ? "text-center font-heading" : "font-medium"
        }`}
      >
        {options.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name} · {STATUS_LABELS[project.status] ?? `未知状态：${project.status}`}
          </option>
        ))}
      </select>
    </div>
  );
}
