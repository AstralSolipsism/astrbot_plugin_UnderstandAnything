# AstrBot Understand Anything

一个独立的 AstrBot 插件，用内置 `understand-anything/` 逻辑依赖为 AstrBot 提供项目理解、知识图谱、差异分析、领域图谱、知识库分析和 Dashboard 交互能力。

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

聊天侧主要暴露一个强确认入口：

- `/understand <任务>`

这个入口最适合启动分析、重新分析、停止任务、切换项目、打开面板和修复运行依赖。项目问答不要求加 `/understand`：普通聊天中询问项目、代码、架构、diff 或 onboarding 时，LLM 会先通过 Understand Anything 工具确认项目状态，再检索图谱回答。

如果用户已经用 `/understand` 提出内容问题，插件会兼容处理；项目明确且图谱就绪时直接回答，项目不明确时会先让用户选择项目。

管理用法：

- `/understand 分析 D:\AboutDEV\AstrBot`
- `/understand 分析 https://github.com/owner/repo`
- `/understand 状态`
- `/understand 项目`
- `/understand 项目 AstrBot`
- `/understand 停止当前分析`
- `/understand 打开面板`
- `/understand 诊断`
- `/understand 修复插件运行依赖`
- `/understand 重新分析 AstrBot，忽略 tests dist node_modules`

普通聊天示例：

- `AstrBot 的 WebChat 代理是怎么接上的？`
- `解释 AstrBot 项目的 webchat_proxy.py 职责`
- `对比项目 A 和项目 B 的 WebChat 接入实现`
- `分析 AstrBot 这次 git diff 的风险`
- `给 AstrBot 生成新手上手说明`

兼容输入示例：

- `/understand AstrBot 的 WebChat 代理是怎么接上的？`
- `/understand 解释 webchat_proxy.py 的职责`
- `/understand 分析这次 git diff 的风险`

旧的多子命令入口已经移除。聊天入口会先用规则和状态机处理明确操作；
只有模糊意图解析才会使用一次轻量 LLM。状态、停止、打开面板、诊断、
修复、明确路径分析、GitHub URL 分析和重新分析不会调用 LLM。

## 项目空间

`/understand 分析 <项目路径或 GitHub 地址>` 成功启动分析时会把目标项目登记到 AstrBot 插件数据目录：
`data/plugin_data/astrbot_plugin_UnderstandAnything/projects.json`。

登记记录包含 `project_id`、`name`、`aliases`、`path`、`graph_root`、
`last_job_id`、`last_analyzed_at` 和 `auto_update`。项目名优先取图谱里的
`project.name`，缺失时使用目录名；聊天状态和问答会使用项目名、别名或路径，
例如 `/understand 状态 AstrBot` 或 `/understand AstrBot 的入口在哪里？`。

聊天、解释、diff 和 onboarding 会按以下顺序解析项目：

1. 自然语言中明确提到的项目名、别名或路径。
2. 当前聊天会话中的项目引用。
3. 只有一个已登记项目时使用该项目。

多项目场景下，如果用户没有明确项目且当前会话也没有项目上下文，插件不会猜测。它会返回候选项目并要求用户选择。用户可以通过 `/understand 项目 <项目名>` 切换当前会话项目，也可以在普通聊天里说“之后都看 <项目名>”。跨项目对比不会自动切换当前项目。

Dashboard API 同样支持 `project_id`、`project_name`、`project_path`，供页面列出项目。

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
- `auto_update_poll_interval`：自动更新后台检查间隔，单位为分钟；`0` 表示关闭后台轮询。
- `default_write_mode`
- `cleanup_github_cache_after_analysis`

本地项目路径不需要预先写入插件配置页。用户在 Dashboard 的“项目目标”输入框或
`/understand <path>` 命令中直接指定要分析的目录；插件会校验该路径必须存在且是目录。
公开 GitHub 仓库 URL 会自动克隆到插件数据目录
`data/plugin_data/astrbot_plugin_UnderstandAnything/repos/github/`。粘贴 GitHub
`/tree/<branch-or-tag>/<sub/path>` 地址时，插件会自动解析分支或标签，并只分析该子目录。

GitHub 访问默认使用自动模式：先直连 GitHub；如果 `ls-remote`、`clone` 或 `fetch`
出现可重试网络错误，会依次切换内置代理预设。Dashboard 代理下拉框只表示“优先使用该预设”，
失败后仍会继续尝试直连和其他内置预设。

`auto_build` 表示是否允许插件在首次使用时自动修复缺失的内置运行依赖。关闭后，如果
`understand-anything/node_modules` 或必要 `dist` 缺失，Dashboard 会提示手动执行“修复插件运行依赖”。

`cleanup_github_cache_after_analysis` 默认为 `false`。启用后 GitHub job 完成会删除 clone
缓存，只保留 artifacts；图谱读取不依赖 clone cache，源码预览或后续分析会按 registry 中的
GitHub source metadata 重新 clone/fetch。

## 同步原则

刷新参考项目能力时，把可复用的 runtime 代码同步到 `understand-anything/`，把 AstrBot 需要执行的角色提示词同步到 `astrbot_adapter/prompts/agents/`，把用户可见 skills 同步到根 `skills/`。不要把其他宿主的插件目录、hook、安装器或重复 skills 带入本插件。

独立分发时需要提交 `understand-anything/dist/`、
`understand-anything/packages/core/dist/`、
`understand-anything/packages/assistant/dist/`、
`understand-anything/packages/dashboard/dist/` 和 `pages/dashboard/`，但不要提交
`node_modules/`、缓存或本地插件数据。
