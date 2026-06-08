<div align="center">

# Understand Anything for AstrBot

让 AstrBot 记住你正在看的项目，并在普通聊天里回答代码实现、模块关系和改动影响。

[![AstrBot](https://img.shields.io/badge/AstrBot-%3E%3D%204.24.2-2563eb)](https://github.com/AstrBotDevs/AstrBot)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D%2022-16a34a)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-%3E%3D%2010-f59e0b)](https://pnpm.io/)
[![Dashboard](https://img.shields.io/badge/Dashboard-Plugin%20Page-7c3aed)](#dashboard)
[![Natural Chat](https://img.shields.io/badge/Natural%20Chat-Project%20Q%26A-0f766e)](#普通聊天入口)

</div>

---

## 这个插件做什么

`astrbot_plugin_UnderstandAnything` 给 AstrBot 增加代码项目理解能力。你可以把多个仓库登记到插件里，生成知识图谱后，在聊天里直接问文件、功能、调用链和项目差异。

你可以先分析一个项目，然后直接在聊天里问：

```text
之后都看 AstrBot。
WebChat 代理是怎么接上的？
对比 AstrBot 和 UA 插件的 WebChat 接入实现。
这个项目当前 diff 会影响哪些模块？
给这个项目生成一个新手上手说明。
```

分析完成后，聊天可以保持自然语气。插件会沿用当前会话选中的项目；你点名别的项目时，它会切过去或做对比。分析、更新和重新分析仍需要用户明确发起。

当前最稳定的是代码项目理解。LLM Wiki、文档和知识库形式的理解辅助已有部分运行时与 Dashboard 支持，但 AstrBot 插件版还缺少稳定实测，请先按实验能力使用。

## 核心体验

| 体验 | 你怎么用 | 你得到什么 |
| --- | --- | --- |
| 普通聊天问项目 | 直接问实现、入口、依赖、风险和改动影响 | AstrBot 用已生成的图谱辅助回答 |
| 多项目上下文 | 说“之后都看某项目”，或在问题里点名多个项目 | 会话保留当前项目，也支持切换和跨项目对比 |
| 项目管理 | 用 `/understand` 指令组做强确认操作 | 分析、更新、重新分析、停止任务和打开面板都有明确入口 |
| Dashboard | 在 AstrBot 插件页浏览项目和图谱 | 管理项目、看图谱、查文件、看任务日志 |
| 大图浏览 | 复杂图谱可以缩放、搜索、定位、查看详情 | Canvas/Leafer 图谱视图承载大量节点，浏览时不容易卡住 |
| LLM Wiki / 知识库 | 实验能力，按验证进度使用 | 保留部分 knowledge graph 支持，仍需实测和流程补齐 |

## 与原始项目的关系和升级

本插件基于 [Lum1104/Understand-Anything](https://github.com/Lum1104/Understand-Anything) 的可复用运行时和项目理解思路构建。原始项目面向多种 AI 编码环境，把代码库、知识库或文档变成可探索、可搜索、可问答的交互式知识图谱。

AstrBot 插件版把项目理解能力接入 AstrBot 的普通聊天、命令组和 Dashboard：

| 维度 | 原始 Understand Anything | AstrBot 插件版 |
| --- | --- | --- |
| 主要入口 | 面向 Claude Code、Codex、Cursor、Copilot、Gemini CLI 等 AI 编码环境 | 面向 AstrBot 插件系统、消息平台和插件 Dashboard |
| 项目问答 | 围绕当前分析目标提问 | 在 AstrBot 聊天中按会话项目回答，也支持点名项目和跨项目对比 |
| 显式操作 | `/understand` 等命令承担分析和后续动作 | 保留 `/understand` 指令组，只做分析、更新、停止、诊断等强确认动作 |
| 图谱渲染 | 通用交互式知识图谱 Dashboard | Canvas/Leafer 大图渲染，针对大量节点的浏览、缩放、命中和裁剪做了专门优化，大项目的大规模节点渲染不卡顿 |
| 图谱浏览 | 独立 Dashboard | AstrBot Plugin Page 内的项目工作台，包含文件预览、任务状态和项目管理 |
| 多项目 | 更偏当前工作区或当前分析目标 | 插件维护项目注册表，支持项目列表、当前项目、项目切换和跨项目对比 |
| 更新语义 | 可重复运行理解流程 | 明确区分检查更新、更新图谱和重新分析，避免把“更新”误做成“重跑” |
| 运行边界 | 独立插件/运行时布局 | 保留 AstrBot Provider、SubAgent、Web API、Plugin Page 和数据目录边界 |

当前仓库的上游 runtime 集成基线记录在 [`understand-anything/UPSTREAM.json`](./understand-anything/UPSTREAM.json)。Dashboard 迁移边界见 [`docs/upstream/understandingself-dashboard-port-notes.md`](./docs/upstream/understandingself-dashboard-port-notes.md)。

## 快速开始

### 1. 安装插件

推荐先从 AstrBot 插件市场安装：

1. 打开 AstrBot WebUI。
2. 进入左侧 `插件` 页面。
3. 切到 `插件市场` 标签。
4. 搜索 `Understand Anything` 或 `astrbot_plugin_UnderstandAnything`。
5. 点击安装，安装完成后启用插件。

插件市场没有结果，或当前环境访问市场/GitHub 不稳定时，使用手动安装：

```text
https://github.com/AstralSolipsism/astrbot_plugin_UnderstandAnything
```

也可以把仓库克隆到 AstrBot 插件目录：

```powershell
cd D:\AboutDEV\astrbot\data\plugins
git clone https://github.com/AstralSolipsism/astrbot_plugin_UnderstandAnything.git
```

重启 AstrBot 后，在 AstrBot Dashboard 的插件页启用 `Understand Anything`。

### 2. 准备运行环境

插件需要宿主环境可用：

- Node.js `>= 22`
- pnpm `>= 10`
- Git，用于 GitHub URL 分析、diff、检查更新和自动更新
- AstrBot 中可用的 chat provider

首次使用时，插件会检查内置 `understand-anything/` 运行依赖。如果 Dashboard 提示依赖缺失，可以点击“修复插件运行依赖”，或在聊天中执行：

```text
/understand 修复
```

这个修复动作只触碰插件内置 `understand-anything/` 目录：执行 `pnpm install --frozen-lockfile` 和必要 build。系统全局 Node、pnpm 和 Git 保持不变。

### 3. 打开面板

```text
/understand 面板
```

面板用于查看项目列表、分析状态、图谱、文件内容、运行环境、SubAgent 注册状态和任务日志。

### 4. 分析第一个项目

分析本地目录：

```text
/understand 分析 D:\AboutDEV\AstrBot
```

分析公开 GitHub 仓库：

```text
/understand 分析 https://github.com/AstrBotDevs/AstrBot
```

也可以粘贴 GitHub `/tree/<branch-or-tag>/<sub/path>` 地址，插件会解析分支、标签和子目录，只分析目标范围。

### 5. 等待分析完成

首次分析会调用多个 LLM SubAgents，并生成结构图谱、领域图谱、元信息和增量更新指纹。5-10 分钟没有最终结果通常代表任务仍在运行，不代表卡死。

常见耗时：

| 项目规模 | 预计耗时 |
| --- | --- |
| 小型项目，几十个文件 | 5-15 分钟 |
| 中型项目，数百个文件 | 15-45 分钟 |
| 大型项目或 monorepo | 45 分钟以上 |

耗时受模型速度、网络、文件数量、并行 SubAgent 数、首次依赖修复和 GitHub clone/fetch 影响。查看进度：

```text
/understand 状态
```

也可以在 Dashboard 查看任务日志。

### 6. 直接在聊天里问项目

图谱准备好后，直接提问：

```text
AstrBot 的 Provider 是怎么接到 WebChat 回复流程里的？
解释这个项目的 astrbot_adapter/webchat_proxy.py。
项目 A 和项目 B 的 Dashboard 数据访问层有什么差异？
```

会话已有当前项目时，继续追问即可。你也可以说“之后都看 AstrBot”切换上下文，或在一个问题里同时点名两个项目做对比。

## 普通聊天入口

分析完成后，你不用把问题包装成指令。直接在聊天里说项目名、文件名、功能名，或者说“之后都看某项目”，插件会让回答落在正确项目上。

```text
之后都看 AstrBot。
AstrBot 的 WebChat 代理怎么接的？
再对比一下 UA 插件里的 WebChat 代理。
这个改动会影响哪些项目入口？
```

会话里只有一个项目时，你可以直接追问。插件登记了多个项目时，最好说出项目名；如果目标项目不明确，插件会要求你先选择。

### 给开发者看的 LLM 工具机制

普通用户可以跳过这一段。LLM 请求会带上稳定路由规则，并可使用这些工具：

| LLM 工具 | 用途 |
| --- | --- |
| `ua_get_project_state` | 查询项目是否已登记、图谱是否就绪、是否有任务运行中 |
| `ua_retrieve_project_context` | 从已有图谱中检索和当前问题相关的上下文 |
| `ua_select_project_context` | 当用户明确切换项目时，设置当前会话项目 |
| `ua_project_action` | 执行显式管理动作，例如状态、检查更新、启动分析、更新、重新分析、停止、诊断、修复 |

LLM 使用规则：

- 项目问答要确认目标项目、图谱状态和任务状态。
- 图谱已就绪或已过期但仍可读时，优先检索图谱回答。
- 普通问题读取已有图谱，不启动分析任务。
- 跨项目对比会分别检索每个被点名项目，当前项目保持不变。
- 多项目且没有明确目标项目时，要求用户选择。

## `/understand` 指令组

`/understand` 承担强确认操作，适合启动分析、管理项目和处理运行环境。项目问答走普通聊天入口。

| 指令 | 用途 |
| --- | --- |
| `/understand 面板` | 打开插件 Dashboard |
| `/understand 分析 <本地路径或 GitHub URL>` | 登记并分析项目 |
| `/understand 状态 [项目]` | 查看当前或指定项目任务状态 |
| `/understand 项目` | 查看当前会话项目和可用项目 |
| `/understand 项目 <项目名>` | 切换当前会话项目 |
| `/understand 检查更新 [项目]` | 只检查源码是否有新提交或变更，不改写图谱 |
| `/understand 更新图谱 [项目]` | 更新已有图谱，优先复用历史 graph/meta 基线 |
| `/understand 重新分析 [项目]` | 强制完整重建图谱，成本更高 |
| `/understand 停止` | 停止当前分析任务 |
| `/understand 诊断` | 查看运行环境、依赖和 SubAgent 状态 |
| `/understand 修复` | 修复插件内置运行依赖 |

示例：

```text
/understand 分析 D:\AboutDEV\AstrBot
/understand 项目 AstrBot
/understand 检查更新 AstrBot
/understand 更新图谱 AstrBot
/understand 重新分析 AstrBot，忽略 tests dist node_modules
```

当前只暴露 `understand` 指令组，避免入口冲突。

## 项目、更新和重新分析

插件会把成功启动过分析的项目登记到 AstrBot 插件数据目录：

```text
data/plugin_data/astrbot_plugin_UnderstandAnything/projects.json
```

登记记录包含项目 ID、名称、别名、路径、图谱目录、最近任务、最近分析时间和自动更新配置。聊天、Dashboard 和 Web API 都通过这份项目注册表定位图谱。

### 多项目上下文

项目解析顺序：

1. 用户消息中明确提到的项目名、别名或路径。
2. 当前聊天会话已选择的项目。
3. 只有一个已登记项目时使用该项目。

多个项目同时存在时，插件要求你说明目标项目。你可以用下面任一方式切换：

```text
/understand 项目 AstrBot
之后都看 AstrBot
使用项目 AstrBot
```

跨项目对比会保留当前会话项目。比如你问“对比项目 A 和项目 B 的 WebChat 接入”，LLM 会分别检索 A 和 B。

### 三种后续动作

| 动作 | 是否启动分析 | 是否改写图谱 | 适合场景 |
| --- | --- | --- | --- |
| 检查更新 | 否 | 否 | 只想知道已有图谱是否落后于源码 |
| 更新图谱 | 是 | 是 | 源码有变化，希望刷新已有项目理解 |
| 重新分析 | 是，完整模式 | 是，重建 | 明确要重建图谱、修正范围或补齐产物 |

“更新图谱”刷新已有图谱；“重新分析”完整重跑。

## Dashboard

Dashboard 嵌入 AstrBot Plugin Page，通过 `window.AstrBotPluginPage` 调用插件 Web API。用户无需手动打开本地端口。

你可以在 Dashboard 中完成：

- 查看项目列表、当前项目和任务状态
- 启动本地路径或 GitHub URL 分析
- 检查更新、更新图谱、重新分析
- 查看结构图谱、领域图谱和 diff overlay
- 搜索节点、缩放图谱、查看缩略图和节点详情
- 预览项目文件内容
- 查看运行环境、修复依赖、注册 UA SubAgents
- 使用 Assistant Workbench 和 WebChat 相关能力

图谱视图使用 Canvas/Leafer 渲染，这是插件版相对上游的主要升级。它把大量节点的绘制、拖拽、缩放和命中测试放到更适合大图的 Canvas 渲染路径里，避免大规模节点全量压到 DOM/React Flow 视图上。

当前图谱视图包含 LOD、视口裁剪、命中索引、缩略图、节点聚焦、搜索联动和导出。仓库保留了大图过滤和聚合回归测试，例如 `10k nodes x 100 layers` 和 `100-layer / 100-nodes-per-layer` 场景。节点上限取决于机器、浏览器和图谱复杂度。

## 配置

配置项见 [`_conf_schema.json`](./_conf_schema.json)。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `provider_id` | 空 | AstrBot chat provider ID；为空时使用当前会话 provider |
| `subagent_provider_id` | 空 | UA SubAgents 使用的 provider；为空时复用 `provider_id` 或当前会话 provider |
| `max_concurrent_jobs` | `1` | 最大并发分析任务数；大项目会消耗模型 token 和 CPU |
| `max_parallel_file_agents` | `5` | 单个项目分析中 file-analyzer SubAgent 并行数 |
| `max_parallel_article_agents` | `3` | 知识库分析中 article-analyzer SubAgent 并行数 |
| `output_locale` | `auto` | 生成内容语言；可选 `auto`、`zh-CN`、`en-US`、`ru-RU` |
| `auto_build` | `true` | 首次使用时是否允许自动修复内置运行依赖 |
| `auto_update_poll_interval` | `0` | 自动更新后台检查间隔，单位分钟；`0` 表示关闭 |
| `github_command_timeout_seconds` | `300` | GitHub `ls-remote`、`clone`、`fetch`、`checkout` 命令超时 |
| `cleanup_github_cache_after_analysis` | `false` | GitHub 分析完成后是否删除 clone 缓存，只保留图谱产物 |
| `default_write_mode` | `project` | 图谱输出模式；当前固定写入项目 `.understand-anything` |

本地项目路径无需预先写入配置页。用户在 Dashboard 或 `/understand 分析 <path>` 中指定目录，插件会校验路径存在且是目录。

## 输出位置

本地项目分析会继续写入目标项目的 `.understand-anything/`：

```text
<project>/.understand-anything/
```

公开 GitHub URL 分析会把 clone 工作副本作为源码缓存，图谱产物写入插件数据目录：

```text
data/plugin_data/astrbot_plugin_UnderstandAnything/repos/github/<owner>/<repo...>/
data/plugin_data/astrbot_plugin_UnderstandAnything/artifacts/github/<owner>/<repo>/<target_hash>/.understand-anything/
```

常见产物：

| 文件 | 说明 |
| --- | --- |
| `knowledge-graph.json` | 结构知识图谱 |
| `domain-graph.json` | 业务/领域视图图谱 |
| `diff-overlay.json` | diff 影响分析覆盖层 |
| `meta.json` | 项目、语言、分析时间、源码状态等元信息 |
| `fingerprints.json` | 增量更新所需的文件指纹 |

## GitHub 源码访问

GitHub 访问默认使用自动模式：先直连 GitHub；如果 `ls-remote`、`clone` 或 `fetch` 出现可重试网络错误，会依次切换内置代理预设。

Dashboard 的代理下拉框表示“优先使用该预设”，失败后仍会尝试直连和其他内置预设。启用 `cleanup_github_cache_after_analysis` 后，job 完成会删除 clone 缓存，只保留 artifacts；后续源码预览或分析会根据 registry 中的 GitHub source metadata 重新 clone 或 fetch。

## 常见问题

### 普通聊天会启动分析吗？

项目分析、更新和重新分析会消耗模型 tokens 和 CPU。插件只在用户提出这些动作时启动任务。普通项目问题读取已有图谱；没有图谱时，插件会提示先分析项目。

### 第一次分析为什么要等这么久？

插件会扫描项目、分批调用 LLM SubAgents、生成知识图谱、领域图谱和增量更新指纹。中型项目跑 15-45 分钟属于正常范围。5-10 分钟没有结果时，先看 `/understand 状态` 或 Dashboard 任务日志。

### 多个项目时它怎么知道我问的是哪个？

插件先匹配消息中的项目名、别名或路径，再读取当前聊天会话的项目选择。目标仍不明确时，插件返回候选项目让你选择。

### 已有项目再次“分析”会怎样？

已有图谱时，普通问答读取图谱。追到最新源码用“更新图谱”；完整重建用“重新分析”。

### Dashboard 提示运行依赖缺失怎么办？

先执行：

```text
/understand 修复
```

或在 Dashboard 点击“修复插件运行依赖”。确认宿主机器已经安装 Node.js `>= 22` 和 pnpm `>= 10`。

### 大项目分析很慢怎么办？

先缩小分析范围，或在 Dashboard 编辑 ignore 规则。日常维护使用“检查更新”和“更新图谱”；完整重建再使用“重新分析”。

### 上游项目的 LLM Wiki / 知识库理解能力在本插件可以直接用吗？

保留有但未实测与针对astrbot调优，因为我没有现成的 LLM WIKI 形式的知识库。如有需要欢迎提供 LLM WIKI 形式的知识库用于测试改进。

## 目录约定

| 路径 | 作用 |
| --- | --- |
| `understand-anything/` | 裁剪后的 Understand Anything 运行时依赖，包含 core、assistant、dashboard 源码、lockfile 和必要 dist |
| `skills/` | AstrBot Skill Manager 入口，包含 Understand Anything skills |
| `astrbot_adapter/` | AstrBot 命令、LLM 调度、Web API、路径安全、任务状态、Node bridge 和 agent prompt 资源 |
| `astrbot_adapter/prompts/agents/` | 分析角色提示词，由 AstrBot agent runner 使用 |
| `pages/dashboard/` | AstrBot Plugin Page 构建产物 |
| `docs/upstream/` | 上游迁移和边界说明 |

## 同步和分发原则

刷新上游能力时：

- 可复用 runtime 代码同步到 `understand-anything/`
- AstrBot 需要执行的角色提示词同步到 `astrbot_adapter/prompts/agents/`
- 用户可见 skills 同步到根目录 `skills/`
- 不引入其他宿主的插件目录、hook、安装器或重复 skills
- 不覆盖 AstrBot Provider、SubAgent、Web API、Runner、配置和 graph root 模型

独立分发时需要提交：

- `understand-anything/dist/`
- `understand-anything/packages/core/dist/`
- `understand-anything/packages/assistant/dist/`
- `understand-anything/packages/dashboard/dist/`
- `pages/dashboard/`

排除内容：

- `node_modules/`
- clone 缓存
- 本地插件数据
- 用户项目分析产物

## 致谢

本插件的项目理解模型、图谱产物和运行时基础来自 [Lum1104/Understand-Anything](https://github.com/Lum1104/Understand-Anything)。AstrBot 插件版在此基础上做了 AstrBot 原生化适配：插件命令组、LLM 工具、Dashboard Plugin Page、Provider/SubAgent 调度、多项目注册表、GitHub 源码处理和项目更新状态机。

Dashboard 的大图 Canvas 使用 `leafer-ui`提供的高性能大规模节点渲染能力。
