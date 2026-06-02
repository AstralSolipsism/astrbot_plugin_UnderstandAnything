import AstrBotWorkspace from "./AstrBotWorkspace";
import {
  type AstrBotPluginPageBridge,
  type AstrBotWindow,
  type ProjectRefParams,
} from "../utils/astrbotBridge";

interface ProjectPortalProps {
  bridge?: AstrBotPluginPageBridge;
  onOpenProject: (projectId: string) => void;
}

function projectIdFromParams(params: ProjectRefParams): string {
  return params.project_id ?? params.project ?? params.project_name ?? params.project_path ?? "";
}

export default function ProjectPortal({ bridge, onOpenProject }: ProjectPortalProps) {
  const activeBridge = bridge ?? (window as AstrBotWindow).AstrBotPluginPage;
  if (!activeBridge) {
    return (
      <div className="h-screen w-screen bg-root p-6 text-sm text-text-muted">
        AstrBot Plugin Page bridge is unavailable.
      </div>
    );
  }
  return (
    <AstrBotWorkspace
      bridge={activeBridge}
      onOpenProject={(params) => onOpenProject(projectIdFromParams(params))}
    />
  );
}
