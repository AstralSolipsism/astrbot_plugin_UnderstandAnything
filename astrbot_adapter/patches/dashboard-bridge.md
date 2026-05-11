# Dashboard Bridge Patch

AstrBot-specific dashboard changes are intentionally limited to data access:

- `src/App.tsx` detects `window.AstrBotPluginPage`, skips the original token gate, and loads graph files through bridge API endpoints.
- `src/App.tsx` and `src/components/CodeViewer.tsx` forward URL `project_id`, `project_name`, `project_path`, or `project` query params to the bridge API when present.
- `src/components/CodeViewer.tsx` loads source preview through `bridge.apiGet("file-content", { path, project_id?, project_name?, project_path?, project? })`.
- `GET projects` lists registered projects from AstrBot plugin data so Dashboard can offer project selection without relying on a global last project.
- `vite.config.ts` sets `base: "./"` so built assets resolve under AstrBot Plugin Pages.

When refreshing `understand-anything/` from the reference project, reapply these changes or port them to the refreshed data-loading layer.
