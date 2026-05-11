---
name: understand-dashboard
description: Open the AstrBot Plugin Page dashboard for an Understand Anything graph
argument-hint: [project-path]
---

# /understand-dashboard

Open the bundled AstrBot Plugin Page dashboard for the current project's `.understand-anything/knowledge-graph.json`.

## Instructions

1. Determine the project directory:
   - If `$ARGUMENTS` contains a path, use that as the project directory.
   - Otherwise, use the current working directory.

2. Check that `.understand-anything/knowledge-graph.json` exists in the project directory. If not, tell the user:
   ```
   No knowledge graph found. Run /understand first to analyze this project.
   ```

3. Use the AstrBot plugin layout:
   - Plugin root: `<PLUGIN_ROOT>`
   - Runtime root: `<PLUGIN_ROOT>/understand-anything`
   - Dashboard source: `<PLUGIN_ROOT>/understand-anything/packages/dashboard`
   - Built Plugin Page: `<PLUGIN_ROOT>/pages/dashboard`

4. If `<PLUGIN_ROOT>/pages/dashboard/index.html` is missing, build it from the bundled runtime:
   ```bash
   cd <PLUGIN_ROOT>/understand-anything
   pnpm install --frozen-lockfile
   pnpm --filter @understand-anything/core build
   pnpm --filter @understand-anything/dashboard build
   rm -rf <PLUGIN_ROOT>/pages/dashboard/*
   cp -R <PLUGIN_ROOT>/understand-anything/packages/dashboard/dist/* <PLUGIN_ROOT>/pages/dashboard/
   ```

5. Report to the user:
   ```
   Open AstrBot WebUI, go to plugin `astrbot_plugin_UnderstandAnything`, then open the `dashboard` Page.
   Viewing: <project-dir>/.understand-anything/knowledge-graph.json
   ```

## Notes

- AstrBot serves the dashboard through Plugin Pages; no separate Vite server is required.
- The dashboard reads graph and source-file data through this plugin's bridge API.
- Pass `project_path` in the Plugin Page URL when opening a graph for a specific project.
