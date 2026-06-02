# UnderstandingSelf Dashboard 与受控产物迁移说明

## 基线

- 目标仓库：`D:\AboutDEV\understanding\astrbot_plugin_UnderstandAnything`
- 目标提交：`5495c30ce68bee46188c44b6485a8442520d9059`
- 参考仓库：`D:\AboutDEV\understanding\UnderstandingSelf`
- 参考提交：`2be9118c726c3833c670c00a9f0091e0a3f4801e`
- 参考插件根：`D:\AboutDEV\understanding\UnderstandingSelf\understand-anything-plugin`
- 执行方案：`docs/superpowers/plans/2026-06-02-astrbot-understandingself-dashboard-port.md`

## 保留的 AstrBot 边界

- `main.py` 保留 AstrBot lifecycle 和命令注册。
- `metadata.yaml`、`_conf_schema.json`、`requirements.txt` 保留 AstrBot 分发和配置。
- `astrbot_adapter/web_api.py` 保留 AstrBot Plugin Page API。
- `astrbot_adapter/runner.py` 保留 job 编排、Provider/SubAgent 调度、确认流程、GitHub/local source 处理。
- `astrbot_adapter/runtime.py` 和 `astrbot_adapter/node/bridge.mjs` 保留 Python 到 Node runtime action 的桥接。
- `astrbot_adapter/job_store.py` 和 `astrbot_adapter/project_registry.py` 只做状态和 observations 扩展，不被上游 server store 替换。
- `astrbot_adapter/prompts/agents/` 保留 AstrBot SubAgent prompt 布局。
- 根目录 `skills/` 保留 AstrBot 用户可见 skill 布局。
- `pages/dashboard/` 保留 AstrBot 插件页构建产物布局。

## 复用的 UnderstandingSelf 内容

- 新 Dashboard 主体、Canvas、graph scene、assistant workbench、project portal、workers、locales、job observations。
- `quality.ts` 的 source inventory、graph repair、quality report、visible content validation、fingerprint candidate 逻辑。
- `domain-analysis-ir.ts` 的 DomainAnalysisIR 规范化和确定性 domain graph 编译。
- `assistant-context.ts` 和 `assistant-context-bundle.ts` 的上下文净化和路径约束。
- `packages/assistant/src/` 的 assistant context/prompt builder。
- `agents/domain-analyzer.md` 和 `skills/understand-domain/SKILL.md` 的 IR-first domain 工作流。

## 不迁入的内容

- KimiCode 进程、状态探测、server 管理 API。
- Kimi container runner。
- `UnderstandingSelf/understand-anything-plugin/packages/server` 作为运行时宿主。
- 与 AstrBot 插件页无关的 standalone management routes。
- 覆盖 AstrBot Provider/SubAgent、WebAPI、Runner、配置或 graphRoot 模型的上游宿主逻辑。

## 文件落点约定

- runtime 可复用逻辑：`understand-anything/`
- runtime action bridge：`astrbot_adapter/node/bridge.mjs`
- Python 编排：`astrbot_adapter/runner.py`
- AstrBot agent prompts：`astrbot_adapter/prompts/agents/`
- AstrBot 用户 skill：`skills/`
- Dashboard 源码：`understand-anything/packages/dashboard/`
- Dashboard 插件页产物：`pages/dashboard/`

## Task 1 验收

- 本说明记录了目标和参考提交。
- 本说明明确 AstrBot 保留边界、UnderstandingSelf 复用模块、Kimi/server 非目标项。
- `UA_UPSTREAM_PORTING_GUIDE.md` 已加入同样边界说明。
- 本 Task 只包含文档/说明类变更，不修改运行代码。
