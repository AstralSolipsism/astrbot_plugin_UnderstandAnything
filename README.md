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
- Git（仅 GitHub URL 分析、diff、auto-update 等能力需要）
- 可用的 AstrBot chat provider

Python 依赖来自 AstrBot 运行时；Node 依赖由 `understand-anything/pnpm-lock.yaml` 固定。插件会自动检测 `node`、`pnpm`、`git`，不要求用户在标准插件配置页手动填写可执行文件路径。需要临时覆盖检测结果时，可在宿主环境变量中设置 `UA_NODE_BIN`、`UA_PNPM_BIN`、`UA_GIT_BIN`。

Dashboard 首页会展示运行环境检查结果，并提供“修复插件运行依赖”操作。该操作只会在插件内置 `understand-anything/` 目录内执行 `pnpm install --frozen-lockfile` 和 build，不会安装或修改系统全局 Node/Git/pnpm。

## 命令

- `/understand analyze [path|https://github.com/owner/repo[/tree/<branch-or-tag>[/sub/path]]] [--full|--auto-update|--no-auto-update|--review] [--github-proxy <preset>]`
- `/understand status [project-name|alias|path]`
- `/understand dashboard [path]`
- `/understand chat [--project <name|id|alias>] <query>`
- `/understand diff [--project <name|id|alias>|path]`
- `/understand domain [path] [--full]`
- `/understand explain [--project <name|id|alias>] <file-path[:symbol]>`
- `/understand knowledge <wiki-directory>`
- `/understand onboard [--project <name|id|alias>|path]`

## 项目空间

`/understand analyze` 成功启动分析时会把目标项目登记到 AstrBot 插件数据目录：
`data/plugin_data/astrbot_plugin_UnderstandAnything/projects.json`。

登记记录包含 `project_id`、`name`、`aliases`、`path`、`graph_root`、
`last_job_id`、`last_analyzed_at` 和 `auto_update`。项目名优先取图谱里的
`project.name`，缺失时使用目录名；聊天状态查询使用项目名、别名或路径，
例如 `/understand status AstrBot` 或 `/understand status AstrBotDevs/AstrBot`。

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
- 本地文件预览走后端 `file-content`，只允许读取位于当前项目目录内的文件。
- 构建产物使用相对资源路径，可直接由 AstrBot 插件页面加载。

## 配置

见 `_conf_schema.json`：

- `provider_id`
- `max_concurrent_jobs`
- `max_parallel_file_agents`
- `max_parallel_article_agents`
- `subagent_provider_id`
- `auto_build`
- `auto_update_poll_interval`
- `default_write_mode`
- `cleanup_github_cache_after_analysis`

本地项目路径不需要预先写入插件配置页。用户在 Dashboard 的“项目目标”输入框或
`/understand <path>` 命令中直接指定要分析的目录；插件会校验该路径必须存在且是目录。
公开 GitHub 仓库 URL 会自动克隆到插件数据目录
`data/plugin_data/astrbot_plugin_UnderstandAnything/repos/github/`。粘贴 GitHub
`/tree/<branch-or-tag>/<sub/path>` 地址时，插件会自动解析分支或标签，并只分析该子目录。

GitHub 访问默认使用自动模式：先直连 GitHub；如果 `ls-remote`、`clone` 或 `fetch`
出现可重试网络错误，会依次切换内置代理预设。Dashboard 代理下拉框和
`--github-proxy <preset>` 只表示“优先使用该预设”，失败后仍会继续尝试直连和其他内置预设。

`auto_build` 表示是否允许插件在首次使用时自动修复缺失的内置运行依赖。关闭后，如果
`understand-anything/node_modules` 或必要 `dist` 缺失，Dashboard 会提示手动执行“修复插件运行依赖”。

`cleanup_github_cache_after_analysis` 默认为 `false`。启用后 GitHub job 完成会删除 clone
缓存，只保留 artifacts；图谱读取不依赖 clone cache，源码预览或后续分析会按 registry 中的
GitHub source metadata 重新 clone/fetch。

## 同步原则

刷新参考项目能力时，把可复用的 runtime 代码同步到 `understand-anything/`，把 AstrBot 需要执行的角色提示词同步到 `astrbot_adapter/prompts/agents/`，把用户可见 skills 同步到根 `skills/`。不要把其他宿主的插件目录、hook、安装器或重复 skills 带入本插件。

独立分发时需要提交 `understand-anything/dist/`、
`understand-anything/packages/core/dist/`、
`understand-anything/packages/dashboard/dist/` 和 `pages/dashboard/`，但不要提交
`node_modules/`、缓存或本地插件数据。
