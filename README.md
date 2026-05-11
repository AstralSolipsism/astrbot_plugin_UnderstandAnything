# AstrBot Understand Anything

一个独立的 AstrBot 插件，用内置 `understand-anything/` 逻辑依赖为 AstrBot 提供项目理解、知识图谱、差异分析、领域图谱、知识库分析和 Dashboard 交互能力。

仓库地址：<https://github.com/AstralSolipsism/astrbot_plugin_UnderstandAnything>

## 目录约定

- `understand-anything/`：裁剪后的 Understand Anything 运行时依赖，包含 core、dashboard 源码、根 skill runtime 源码、lockfile 和必要 dist。
- `skills/`：唯一的 AstrBot Skill Manager 入口，包含 8 个 Understand Anything skills。
- `astrbot_adapter/`：AstrBot 命令、LLM 调度、Web API、路径安全、任务状态、Node bridge 和 agent prompt 资源。
- `astrbot_adapter/prompts/agents/`：从参考项目迁移来的分析角色提示词，由 AstrBot agent runner 使用。
- `pages/dashboard/`：AstrBot Plugin Page 构建产物。

## 依赖

- Node.js >= 22
- pnpm >= 10
- 可用的 AstrBot chat provider

Python 依赖来自 AstrBot 运行时；Node 依赖由 `understand-anything/pnpm-lock.yaml` 固定。插件首次使用时会按配置安装依赖并在缺失 dist 时重建。

## 命令

- `/understand [path|https://github.com/owner/repo[/tree/<branch-or-tag>[/sub/path]]] [--full|--auto-update|--no-auto-update|--review]`
- `/understand-dashboard [path]`
- `/understand-chat [--project <name|id|alias>] <query>`
- `/understand-diff [--project <name|id|alias>|path]`
- `/understand-domain [path] [--full]`
- `/understand-explain [--project <name|id|alias>] <file-path[:symbol]>`
- `/understand-knowledge <wiki-directory>`
- `/understand-onboard [--project <name|id|alias>|path]`

所有连字符命令都有 underscore alias，例如 `/understand_dashboard`。

## 项目空间

`/understand` 成功启动分析时会把目标项目登记到 AstrBot 插件数据目录：
`data/plugin_data/astrbot_plugin_UnderstandAnything/projects.json`。

登记记录包含 `project_id`、`name`、`aliases`、`path`、`graph_root`、
`last_job_id`、`last_analyzed_at` 和 `auto_update`。项目名优先取图谱里的
`project.name`，缺失时使用目录名。

聊天、解释、diff 和 onboarding 会按以下顺序解析项目：

1. 显式 `--project <name|id|alias>`。
2. 显式项目路径。
3. 只有一个已登记项目时使用该项目。

如果已经登记多个项目且未指定 `--project`，插件会拒绝执行并返回可用项目列表，
避免跨会话误用上一次分析的项目。

Dashboard API 同样支持 `project_id`、`project_name`、`project_path`，并提供
`GET /api/plug/astrbot_plugin_UnderstandAnything/projects` 供页面列出项目。

## 输出

本地服务端路径分析会继续写入目标项目的 `.understand-anything/`。
GitHub URL 分析会把 clone 工作副本当作源码缓存，分析产物写入插件数据目录的 artifact 区域：

- 源码缓存：`data/plugin_data/astrbot_plugin_UnderstandAnything/repos/github/<owner>/<repo...>/`
- 图谱产物：`data/plugin_data/astrbot_plugin_UnderstandAnything/artifacts/github/<owner>/<repo>/<target_hash>/.understand-anything/`

产物目录保持 Understand Anything 文件名和 schema：

- `knowledge-graph.json`
- `domain-graph.json`
- `diff-overlay.json`
- `meta.json`
- `fingerprints.json`

## Dashboard

Dashboard 保留参考项目 React 体验，只调整数据访问层：

- 在 AstrBot Plugin Page 中通过 `window.AstrBotPluginPage` 调用插件 Web API。
- 首次使用分析功能前，Dashboard 会引导用户一键注册 UA SubAgents 到 AstrBot 持久 `subagent_orchestrator.agents` 配置。
- 本地文件预览走后端 `file-content`，且只允许读取图谱中出现并位于目标项目内的文件。
- 构建产物使用相对资源路径，可直接由 AstrBot 插件页面加载。

## 配置

见 `_conf_schema.json`：

- `provider_id`
- `node_bin`
- `pnpm_bin`
- `max_concurrent_jobs`
- `max_parallel_file_agents`
- `max_parallel_article_agents`
- `subagent_provider_id`
- `auto_build`
- `auto_update_poll_interval`
- `allowed_roots`
- `default_write_mode`
- `cleanup_github_cache_after_analysis`

`allowed_roots` 为空时仅允许当前 AstrBot 工作目录。分析其他本地项目时应配置绝对路径白名单。
公开 GitHub 仓库 URL 会自动克隆到插件数据目录
`data/plugin_data/astrbot_plugin_UnderstandAnything/repos/github/`，不需要加入
`allowed_roots`。粘贴 GitHub `/tree/<branch-or-tag>/<sub/path>` 地址时，插件会自动解析
分支或标签，并只分析该子目录。

`cleanup_github_cache_after_analysis` 默认为 `false`。启用后 GitHub job 完成会删除 clone
缓存，只保留 artifacts；图谱读取不依赖 clone cache，源码预览或后续分析会按 registry 中的
GitHub source metadata 重新 clone/fetch。

## 同步原则

刷新参考项目能力时，把可复用的 runtime 代码同步到 `understand-anything/`，把 AstrBot 需要执行的角色提示词同步到 `astrbot_adapter/prompts/agents/`，把用户可见 skills 同步到根 `skills/`。不要把其他宿主的插件目录、hook、安装器或重复 skills 带入本插件。

独立分发时需要提交 `understand-anything/dist/`、
`understand-anything/packages/core/dist/`、
`understand-anything/packages/dashboard/dist/` 和 `pages/dashboard/`，但不要提交
`node_modules/`、缓存或本地插件数据。
