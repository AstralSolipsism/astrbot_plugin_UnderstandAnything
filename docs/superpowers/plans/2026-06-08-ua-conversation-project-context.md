# UA Conversation Project Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Understand Anything behave naturally in chat while preserving `/understand` as the strong-confirmation entry for analysis and project management.

**Architecture:** Keep the current three outer LLM tools, add one low-cost project-context tool, and make project selection an explicit, verifiable session state. Content questions through `/understand` should reuse existing graph-answering runner paths instead of rejecting the user, but only after the target project is unambiguous and graph-ready.

**Tech Stack:** AstrBot Python plugin, pytest, existing `astrbot_adapter.chat_entry`, `main.py` tool registration, `WebChatSessionContextStore`, and existing `UnderstandAnythingRunner` graph answer methods.

---

## Accepted Decisions

- `/understand` remains the explicit command surface for high-cost or administrative actions: analysis, reanalysis, stop, project selection, panel, repair, and the current diagnosis behavior.
- Ordinary project understanding should primarily happen through LLM tools embedded in natural conversation.
- Content-style `/understand` requests are compatible input and must not be rejected. They should answer if the project is unambiguous and graph-ready.
- The plugin manages multiple analyzed projects. A graph existing somewhere is not enough; the tool path must establish which project the user intended.
- Project resolution is allowed only when one of these is true:
  - The user names a project, alias, path, or GitHub repository uniquely.
  - The current conversation session has an explicit project context.
  - Exactly one project is registered.
- If multiple projects match or no project is clear, the system asks the user to pick instead of guessing.
- Chat LLMs may switch project context when the user explicitly asks to switch or says future questions should target a project.
- Cross-project comparison should not change the current project. Retrieve each named project temporarily and label answer sections by project.
- Keep `/understand 诊断` behavior unchanged for this change set.

## File Structure

- Modify `astrbot_plugin_UnderstandAnything/main.py`
  - Register new outer LLM tool `ua_select_project_context`.
  - Add routing prompt language for context switching and cross-project comparison.
  - Keep `ua_project_action` for management and high-cost actions.

- Modify `astrbot_plugin_UnderstandAnything/astrbot_adapter/webchat_proxy.py`
  - Extend the existing context store so it can persist project context for any `unified_msg_origin`, while keeping existing WebChat session IDs compatible.

- Modify `astrbot_plugin_UnderstandAnything/astrbot_adapter/chat_entry.py`
  - Add candidate project payloads to state/tool results.
  - Add `ToolResultPresenter.select_project_context`.
  - Change content intents from redirect-only to graph-answering execution.
  - Keep state validation before content answering.

- Modify `astrbot_plugin_UnderstandAnything/README.md`
  - Align docs with the final model: natural chat is primary for project questions, `/understand` is management-first but content-compatible.

- Modify tests:
  - `astrbot_plugin_UnderstandAnything/tests/test_chat_entry.py`
  - `astrbot_plugin_UnderstandAnything/tests/test_adapter.py`
  - `astrbot_plugin_UnderstandAnything/tests/test_webchat_proxy.py`

---

### Task 1: Generalize Session Project Context Storage

**Files:**
- Modify: `astrbot_plugin_UnderstandAnything/astrbot_adapter/webchat_proxy.py`
- Test: `astrbot_plugin_UnderstandAnything/tests/test_webchat_proxy.py`

- [ ] **Step 1: Write failing tests for generic non-WebChat context**

Add tests near `test_context_store_maps_webchat_umo_to_ua_project_context`:

```python
def test_context_store_maps_non_webchat_umo_to_ua_project_context(tmp_path: Path) -> None:
    store = WebChatSessionContextStore(tmp_path / "contexts.json")
    umo = "telegram:FriendMessage:telegram!alice!chat-1"

    updated = store.update_for_umo(
        umo,
        project_ref={"project_id": "p1", "project_name": "Demo"},
    )

    assert updated is not None
    assert updated["username"] == "telegram"
    assert updated["project_ref"] == {
        "project_id": "p1",
        "project_name": "Demo",
    }
    assert store.project_ref_for_umo(umo) == {
        "project_id": "p1",
        "project_name": "Demo",
    }
    assert store.context_for_umo(umo)["project_ref"]["project_id"] == "p1"


def test_context_store_keeps_webchat_session_id_compatibility(tmp_path: Path) -> None:
    store = WebChatSessionContextStore(tmp_path / "contexts.json")
    umo = build_webchat_unified_msg_origin("alice", "s1")

    store.update_for_umo(umo, project_ref={"project_id": "p1"})

    assert store.project_ref_for_session("s1") == {"project_id": "p1"}
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```powershell
python -m pytest astrbot_plugin_UnderstandAnything/tests/test_webchat_proxy.py -q
```

Expected: the non-WebChat test fails because `update_for_umo` returns `None`.

- [ ] **Step 3: Implement generic UMO session keys**

In `webchat_proxy.py`, import `hashlib` and add helpers after `username_from_webchat_umo`:

```python
import hashlib
```

```python
def context_key_from_umo(umo: str) -> str | None:
    webchat_session_id = session_id_from_webchat_umo(umo)
    if webchat_session_id:
        return webchat_session_id
    raw = str(umo or "").strip()
    if not raw:
        return None
    digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]
    return f"umo:{digest}"


def username_from_umo(umo: str) -> str | None:
    webchat_username = username_from_webchat_umo(umo)
    if webchat_username:
        return webchat_username
    raw = str(umo or "").strip()
    if not raw:
        return None
    return raw.split(":", 1)[0] or "chat"
```

Update these methods in `WebChatSessionContextStore`:

```python
def project_ref_for_umo(self, umo: str) -> dict[str, Any] | None:
    session_key = context_key_from_umo(umo)
    if not session_key:
        return None
    return self.project_ref_for_session(session_key)


def update_for_umo(
    self,
    umo: str,
    *,
    project_ref: dict[str, Any] | None = None,
    context_items: list[Any] | None = None,
) -> dict[str, Any] | None:
    session_key = context_key_from_umo(umo)
    username = username_from_umo(umo)
    if not session_key or not username:
        return None
    return self.update(
        session_id=session_key,
        username=username,
        project_ref=project_ref,
        context_items=context_items,
    )


def context_for_umo(self, umo: str) -> dict[str, Any] | None:
    session_key = context_key_from_umo(umo)
    if not session_key:
        return None
    return self.context_for_session(session_key)
```

- [ ] **Step 4: Run tests and verify they pass**

Run:

```powershell
python -m pytest astrbot_plugin_UnderstandAnything/tests/test_webchat_proxy.py -q
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```powershell
git -C astrbot_plugin_UnderstandAnything add astrbot_adapter/webchat_proxy.py tests/test_webchat_proxy.py
git -C astrbot_plugin_UnderstandAnything commit -m "feat: persist UA project context for any chat session"
```

---

### Task 2: Expose Project Candidates In State Results

**Files:**
- Modify: `astrbot_plugin_UnderstandAnything/astrbot_adapter/chat_entry.py`
- Test: `astrbot_plugin_UnderstandAnything/tests/test_chat_entry.py`

- [ ] **Step 1: Write failing tests for ambiguous project state candidates**

Add tests near existing `ToolResultPresenter` tests:

```python
def test_project_state_lists_candidates_when_project_is_ambiguous(tmp_path: Path) -> None:
    runner = _DummyRunner(tmp_path)
    runner.registry = SimpleNamespace(
        list=lambda: [
            _Project(tmp_path, project_id="p1", name="Alpha"),
            _Project(tmp_path, project_id="p2", name="Beta"),
        ],
    )

    payload = json.loads(ToolResultPresenter(runner).project_state(""))

    assert payload["state"] == "ambiguous_project"
    assert payload["requires_project_selection"] is True
    assert payload["project_candidates"] == [
        {
            "project_id": "p1",
            "project_name": "Alpha",
            "project_ref": "Alpha",
            "project_path": str(tmp_path / "Alpha"),
        },
        {
            "project_id": "p2",
            "project_name": "Beta",
            "project_ref": "Beta",
            "project_path": str(tmp_path / "Beta"),
        },
    ]


def test_project_state_does_not_require_selection_for_single_ready_project(
    tmp_path: Path,
) -> None:
    runner = _DummyRunner(tmp_path)
    runner.registry = SimpleNamespace(
        list=lambda: [_Project(tmp_path, project_id="p1", name="Demo")],
    )

    payload = json.loads(ToolResultPresenter(runner).project_state(""))

    assert payload["state"] == "graph_ready"
    assert payload["requires_project_selection"] is False
    assert payload["project"]["name"] == "Demo"
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```powershell
python -m pytest astrbot_plugin_UnderstandAnything/tests/test_chat_entry.py -q
```

Expected: candidate fields are missing.

- [ ] **Step 3: Add candidate payload helpers**

In `chat_entry.py`, add:

```python
def _project_candidate_payloads(runner: Any) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for project in _project_records(runner):
        ref = _project_ref_payload(project)
        if ref:
            candidates.append(ref)
    return candidates
```

Update `ToolResultPresenter.project_state` to include:

```python
project_candidates = _project_candidate_payloads(self.runner)
requires_project_selection = state.name == "ambiguous_project"
```

Add these fields to the JSON payload:

```python
"project_candidates": project_candidates,
"requires_project_selection": requires_project_selection,
```

Also update `tool_guidance`:

```python
"project_selection": (
    "If requires_project_selection is true, ask the user to choose a project "
    "or call ua_select_project_context only when the user names one candidate explicitly."
),
```

- [ ] **Step 4: Run tests and verify they pass**

Run:

```powershell
python -m pytest astrbot_plugin_UnderstandAnything/tests/test_chat_entry.py -q
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```powershell
git -C astrbot_plugin_UnderstandAnything add astrbot_adapter/chat_entry.py tests/test_chat_entry.py
git -C astrbot_plugin_UnderstandAnything commit -m "feat: expose UA project candidates in state"
```

---

### Task 3: Add `ua_select_project_context` As A Low-Cost LLM Tool

**Files:**
- Modify: `astrbot_plugin_UnderstandAnything/main.py`
- Modify: `astrbot_plugin_UnderstandAnything/astrbot_adapter/chat_entry.py`
- Test: `astrbot_plugin_UnderstandAnything/tests/test_adapter.py`
- Test: `astrbot_plugin_UnderstandAnything/tests/test_chat_entry.py`

- [ ] **Step 1: Write failing registration tests**

In `test_adapter.py`, update `test_main_plugin_llm_tools_are_structured_and_not_legacy`:

```python
assert '@filter.llm_tool(name="ua_select_project_context")' in source
```

Update `test_main_plugin_appends_static_ua_tool_routing_prompt` tool list:

```python
return [
    "ua_get_project_state",
    "ua_select_project_context",
    "ua_retrieve_project_context",
]
```

Assert the routing text contains the context switching rule:

```python
assert "ua_select_project_context" in appended
assert "cross-project comparison" in appended
```

- [ ] **Step 2: Write failing presenter tests**

In `test_chat_entry.py`, add:

```python
def test_tool_select_project_context_updates_generic_chat_context(tmp_path: Path) -> None:
    runner = _DummyRunner(tmp_path)
    project = _Project(tmp_path, project_id="p1", name="Demo")
    runner.registry = SimpleNamespace(list=lambda: [project])
    context_store = WebChatSessionContextStore(tmp_path / "contexts.json")
    presenter = ToolResultPresenter(runner, context_store=context_store)
    event = SimpleNamespace(
        unified_msg_origin="telegram:FriendMessage:telegram!alice!chat-1",
    )

    payload = json.loads(
        presenter.select_project_context(
            "Demo",
            event=event,
        ),
    )

    assert payload["status"] == "ok"
    assert payload["project"]["project_id"] == "p1"
    assert context_store.project_ref_for_umo(event.unified_msg_origin) == {
        "project_id": "p1",
        "project_name": "Demo",
        "project_path": project.path,
        "project_ref": "Demo",
    }


def test_tool_select_project_context_blocks_ambiguous_project(tmp_path: Path) -> None:
    runner = _DummyRunner(tmp_path)
    runner.registry = SimpleNamespace(
        list=lambda: [
            _Project(tmp_path, project_id="p1", name="Demo"),
            _Project(tmp_path, project_id="p2", name="Demo"),
        ],
    )
    presenter = ToolResultPresenter(
        runner,
        context_store=WebChatSessionContextStore(tmp_path / "contexts.json"),
    )

    payload = json.loads(
        presenter.select_project_context(
            "Demo",
            event=SimpleNamespace(unified_msg_origin="telegram:chat"),
        ),
    )

    assert payload["status"] == "blocked"
    assert "多个项目" in payload["message"]
```

- [ ] **Step 3: Run tests and verify they fail**

Run:

```powershell
python -m pytest astrbot_plugin_UnderstandAnything/tests/test_adapter.py astrbot_plugin_UnderstandAnything/tests/test_chat_entry.py -q
```

Expected: `ua_select_project_context` is missing.

- [ ] **Step 4: Implement presenter method**

In `ToolResultPresenter`, add:

```python
def select_project_context(
    self,
    project_hint: str,
    *,
    event: Any,
) -> str:
    intent = ChatIntent(intent="select_project", project_hint=project_hint)
    executor = ChatActionExecutor(
        self.runner,
        context_store=self.context_store,
    )
    result = executor.select_project_context(intent, event)
    state_after = ChatStateResolver(self.runner).resolve(project_hint)
    return _json(
        {
            "status": result["status"],
            "action": "select_project_context",
            "message": result["message"],
            "project": result.get("project") or state_after.project,
            "project_candidates": _project_candidate_payloads(self.runner),
            "next_actions": state_after.available_actions,
            "dashboard_url": _dashboard_url(),
            "llm_used": False,
        },
    )
```

- [ ] **Step 5: Register outer LLM tool**

In `main.py`, add the name to `UA_OUTER_LLM_TOOLS`:

```python
"ua_select_project_context",
```

Add the tool method after `ua_get_project_state`:

```python
@filter.llm_tool(name="ua_select_project_context")
async def ua_select_project_context(
    self,
    event: AstrMessageEvent,
    project_hint: str,
):
    """Switch the current chat session to a clearly named project.

    Use this only when the user explicitly says to switch projects, use a
    project for future questions, or names one unique project in the current
    question. Do not use it for cross-project comparison; retrieve each named
    project temporarily instead.

    Args:
        project_hint(string): Project name, id, alias, path, or GitHub repo.
    """
    return self.chat_entry.tools.select_project_context(
        project_hint,
        event=event,
    )
```

Update `UA_TOOL_ROUTING_PROMPT`:

```text
- If the user explicitly switches projects or says future questions should use a project, call `ua_select_project_context`.
- For cross-project comparison, do not switch context; call `ua_get_project_state` and `ua_retrieve_project_context` separately for each named project.
- If multiple projects are registered and the user did not identify one, ask which project instead of guessing.
```

- [ ] **Step 6: Run tests and verify they pass**

Run:

```powershell
python -m pytest astrbot_plugin_UnderstandAnything/tests/test_adapter.py astrbot_plugin_UnderstandAnything/tests/test_chat_entry.py -q
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```powershell
git -C astrbot_plugin_UnderstandAnything add main.py astrbot_adapter/chat_entry.py tests/test_adapter.py tests/test_chat_entry.py
git -C astrbot_plugin_UnderstandAnything commit -m "feat: add UA project context selection tool"
```

---

### Task 4: Answer Content Requests Sent Through `/understand`

**Files:**
- Modify: `astrbot_plugin_UnderstandAnything/astrbot_adapter/chat_entry.py`
- Test: `astrbot_plugin_UnderstandAnything/tests/test_chat_entry.py`
- Test: `astrbot_plugin_UnderstandAnything/tests/test_adapter.py`

- [ ] **Step 1: Replace redirect tests with answer-path tests**

Replace `test_command_executor_does_not_answer_content_requests_from_commands` with:

```python
@pytest.mark.parametrize(
    ("intent", "expected_method"),
    [
        (ChatIntent(intent="content_requires_llm", query="这个接入怎么做的？", mode="ask"), "chat"),
        (
            ChatIntent(
                intent="content_requires_llm",
                query="解释 webchat_proxy.py",
                target="webchat_proxy.py",
                mode="explain",
            ),
            "explain",
        ),
        (ChatIntent(intent="content_requires_llm", query="当前改动", mode="diff"), "diff"),
        (ChatIntent(intent="content_requires_llm", query="项目导览", mode="onboard"), "onboard"),
        (ChatIntent(intent="domain", query="订单流程怎么串起来", mode="domain"), "chat"),
    ],
)
def test_command_executor_answers_content_requests_when_graph_ready(
    tmp_path: Path,
    intent: ChatIntent,
    expected_method: str,
) -> None:
    runner = _DummyRunner(tmp_path)
    project = _Project(tmp_path, project_id="p1", name="Demo")
    runner.registry = SimpleNamespace(list=lambda: [project])
    executor = ChatActionExecutor(runner)

    message = asyncio.run(
        executor.execute(
            intent,
            event=SimpleNamespace(),
            project_kwargs={"project_ref": "Demo"},
        ),
    )

    assert runner.calls[-1]["method"] == expected_method
    assert message in {"图谱回答", "组件解释", "改动分析", "项目导览"}
```

Add a test for ambiguity:

```python
def test_understand_content_request_asks_project_when_ambiguous(tmp_path: Path) -> None:
    runner = _DummyRunner(tmp_path)
    runner.registry = SimpleNamespace(
        list=lambda: [
            _Project(tmp_path, project_id="p1", name="Alpha"),
            _Project(tmp_path, project_id="p2", name="Beta"),
        ],
    )
    entry = UnderstandAnythingChatEntry(runner)

    message = asyncio.run(
        entry.execute_text(
            "解释 webchat_proxy.py",
            event=SimpleNamespace(),
        ),
    )

    assert "当前匹配到多个项目" in message
    assert runner.calls == []
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```powershell
python -m pytest astrbot_plugin_UnderstandAnything/tests/test_chat_entry.py -q
```

Expected: content requests still return the redirect message.

- [ ] **Step 3: Implement content answer routing**

In `ChatActionExecutor.execute`, replace the current content block:

```python
if intent.intent in {
    "content_requires_llm",
    "ask",
    "explain",
    "diff",
    "onboard",
    "domain",
}:
    return _content_requires_llm_message()
```

with:

```python
if intent.intent in {
    "content_requires_llm",
    "ask",
    "explain",
    "diff",
    "onboard",
    "domain",
}:
    return await self._answer_content_request(intent, event, project_kwargs)
```

Add helper methods to `ChatActionExecutor`:

```python
async def _answer_content_request(
    self,
    intent: ChatIntent,
    event: Any,
    project_kwargs: dict[str, Any],
) -> str:
    kwargs = _content_project_kwargs(project_kwargs, intent)
    context_items = kwargs.pop("context_items", None)
    mode = intent.mode or intent.intent or "ask"
    if mode == "explain" and intent.target:
        result = await self.runner.explain(
            target=intent.target,
            event=event,
            context_items=context_items,
            **_project_store_kwargs(kwargs),
        )
        return _assistant_result_text(result)
    if mode == "diff":
        result = await self.runner.diff(
            event=event,
            context_items=context_items,
            **_project_store_kwargs(kwargs),
        )
        return _assistant_result_text(result)
    if mode == "onboard":
        result = await self.runner.onboard(
            event=event,
            context_items=context_items,
            **_project_store_kwargs(kwargs),
        )
        return _assistant_result_text(result)
    result = await self.runner.chat(
        query=intent.query or intent.target,
        event=event,
        context_items=context_items,
        **_project_store_kwargs(kwargs),
    )
    return _assistant_result_text(result)
```

Add module helper:

```python
def _assistant_result_text(result: Any) -> str:
    if isinstance(result, dict):
        for key in ("answer", "markdown", "message"):
            value = result.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return json.dumps(result, ensure_ascii=False)
    return str(result or "").strip()
```

Keep `_content_requires_llm_message` for compatibility only if another test still imports it; otherwise leave it unused until a later cleanup.

- [ ] **Step 4: Update adapter regression expectations**

In `test_adapter.py`, replace the assertions in `test_main_plugin_tools_do_not_generate_final_answers_directly` only if they scan command behavior. Keep the outer LLM tool assertions:

```python
tool_source = source[
    source.index('@filter.llm_tool(name="ua_get_project_state")') :
]
assert "return await self.runner.chat(" not in tool_source
assert "return await self.runner.explain(" not in tool_source
assert "return await self.runner.diff(" not in tool_source
assert "return await self.runner.onboard(" not in tool_source
```

Do not add a new assertion banning command-path calls to `runner.chat`, because content-compatible `/understand` now intentionally uses those runner methods.

- [ ] **Step 5: Run tests and verify they pass**

Run:

```powershell
python -m pytest astrbot_plugin_UnderstandAnything/tests/test_chat_entry.py astrbot_plugin_UnderstandAnything/tests/test_adapter.py -q
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```powershell
git -C astrbot_plugin_UnderstandAnything add astrbot_adapter/chat_entry.py tests/test_chat_entry.py tests/test_adapter.py
git -C astrbot_plugin_UnderstandAnything commit -m "feat: answer content requests through understand command"
```

---

### Task 5: Strengthen Retrieval Semantics For Multi-Project Chat

**Files:**
- Modify: `astrbot_plugin_UnderstandAnything/main.py`
- Modify: `astrbot_plugin_UnderstandAnything/astrbot_adapter/chat_entry.py`
- Test: `astrbot_plugin_UnderstandAnything/tests/test_chat_entry.py`

- [ ] **Step 1: Write failing tests for retrieval ambiguity and explicit projects**

Add:

```python
def test_retrieve_project_context_errors_with_multiple_projects_and_no_hint(
    tmp_path: Path,
) -> None:
    runner = _DummyRunner(tmp_path)
    runner.registry = SimpleNamespace(
        list=lambda: [
            _Project(tmp_path, project_id="p1", name="Alpha"),
            _Project(tmp_path, project_id="p2", name="Beta"),
        ],
        resolve_record=lambda **kwargs: (_ for _ in ()).throw(
            ValueError("Multiple Understand Anything projects are registered."),
        ),
    )

    payload = json.loads(
        ToolResultPresenter(runner).retrieve_project_context("入口在哪里？"),
    )

    assert payload["status"] == "project_selection_required"
    assert payload["project_candidates"][0]["project_name"] == "Alpha"
    assert payload["project_candidates"][1]["project_name"] == "Beta"


def test_retrieve_project_context_uses_explicit_project_hint(tmp_path: Path) -> None:
    graph = {
        "project": {"name": "Alpha"},
        "nodes": [
            {
                "id": "file:src/main.py",
                "type": "file",
                "name": "main.py",
                "filePath": "src/main.py",
                "summary": "Entry point",
            },
        ],
        "edges": [],
    }

    class Runner(_DummyRunner):
        def project_store(self, **kwargs):
            assert kwargs["project_ref"] == "Alpha"
            return _GraphStore({"knowledge-graph.json": graph})

    payload = json.loads(
        ToolResultPresenter(Runner(tmp_path)).retrieve_project_context(
            "入口",
            project_hint="Alpha",
        ),
    )

    assert payload["status"] == "ok"
    assert payload["graph"]["project"]["name"] == "Alpha"
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```powershell
python -m pytest astrbot_plugin_UnderstandAnything/tests/test_chat_entry.py -q
```

Expected: ambiguous retrieval returns a generic error without candidate projects.

- [ ] **Step 3: Return project-selection payload from retrieval**

In `ToolResultPresenter.retrieve_project_context`, update the broad exception path around `self.runner.project_store`:

```python
except Exception as exc:
    message = str(exc)
    if "Multiple Understand Anything projects are registered" in message:
        return _json(
            {
                "status": "project_selection_required",
                "message": (
                    "多个项目已登记，当前问题没有明确项目。请让用户选择一个项目，"
                    "或在本轮检索中传入 project_hint。"
                ),
                "project_candidates": _project_candidate_payloads(self.runner),
                "query": query,
                "target": target,
                "mode": mode or "ask",
                "llm_used": False,
            },
        )
    return _json({"status": "error", "error": message, "llm_used": False})
```

Use the same `project_selection_required` payload if the project resolver reports an unknown project and the registered project list is non-empty:

```python
if "Unknown Understand Anything project" in message:
    return _json(
        {
            "status": "project_selection_required",
            "message": message,
            "project_candidates": _project_candidate_payloads(self.runner),
            "query": query,
            "target": target,
            "mode": mode or "ask",
            "llm_used": False,
        },
    )
```

- [ ] **Step 4: Update tool guidance**

In `main.py`, ensure `UA_TOOL_ROUTING_PROMPT` contains:

```text
- If retrieval returns `project_selection_required`, ask the user to choose a project. Do not answer from another project.
```

- [ ] **Step 5: Run tests and verify they pass**

Run:

```powershell
python -m pytest astrbot_plugin_UnderstandAnything/tests/test_chat_entry.py astrbot_plugin_UnderstandAnything/tests/test_adapter.py -q
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```powershell
git -C astrbot_plugin_UnderstandAnything add main.py astrbot_adapter/chat_entry.py tests/test_chat_entry.py
git -C astrbot_plugin_UnderstandAnything commit -m "fix: require explicit project for ambiguous retrieval"
```

---

### Task 6: Update User-Facing Documentation

**Files:**
- Modify: `astrbot_plugin_UnderstandAnything/README.md`

- [ ] **Step 1: Update command section wording**

Replace the current command intro with:

```markdown
聊天侧主要暴露一个强确认入口：

- `/understand <任务>`

这个入口最适合启动分析、重新分析、停止任务、切换项目、打开面板和修复运行依赖。项目问答不要求加 `/understand`：普通聊天中询问项目、代码、架构、diff 或 onboarding 时，LLM 会先通过 Understand Anything 工具确认项目状态，再检索图谱回答。

如果用户已经用 `/understand` 提出内容问题，插件会兼容处理；项目明确且图谱就绪时直接回答，项目不明确时会先让用户选择项目。
```

- [ ] **Step 2: Update examples**

Keep management examples:

```markdown
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
```

Add natural chat examples:

```markdown
普通聊天示例：

- `AstrBot 的 WebChat 代理是怎么接上的？`
- `解释 AstrBot 项目的 webchat_proxy.py 职责`
- `对比项目 A 和项目 B 的 WebChat 接入实现`
- `分析 AstrBot 这次 git diff 的风险`
- `给 AstrBot 生成新手上手说明`
```

Add compatibility examples:

```markdown
兼容输入示例：

- `/understand AstrBot 的 WebChat 代理是怎么接上的？`
- `/understand 解释 webchat_proxy.py 的职责`
- `/understand 分析这次 git diff 的风险`
```

- [ ] **Step 3: Update project-space section**

Add:

```markdown
多项目场景下，如果用户没有明确项目且当前会话也没有项目上下文，插件不会猜测。它会返回候选项目并要求用户选择。用户可以通过 `/understand 项目 <项目名>` 切换当前会话项目，也可以在普通聊天里说“之后都看 <项目名>”。跨项目对比不会自动切换当前项目。
```

- [ ] **Step 4: Commit**

```powershell
git -C astrbot_plugin_UnderstandAnything add README.md
git -C astrbot_plugin_UnderstandAnything commit -m "docs: clarify UA chat and command interaction model"
```

---

### Task 7: Final Regression Verification

**Files:**
- No new files.

- [ ] **Step 1: Run focused Python tests**

Run:

```powershell
python -m pytest astrbot_plugin_UnderstandAnything/tests/test_chat_entry.py astrbot_plugin_UnderstandAnything/tests/test_adapter.py astrbot_plugin_UnderstandAnything/tests/test_webchat_proxy.py -q
```

Expected: all selected tests pass.

- [ ] **Step 2: Run broader plugin tests if the environment supports it**

Run:

```powershell
python -m pytest astrbot_plugin_UnderstandAnything/tests -q
```

Expected: all plugin tests pass. If environment dependencies block the full suite, capture the exact missing dependency or failing test names in the handoff.

- [ ] **Step 3: Check no unintended legacy tool regression**

Run:

```powershell
rg -n "@filter\\.llm_tool|@filter\\.command|@filter\\.command_group|ua_select_project_context|content_requires_llm" astrbot_plugin_UnderstandAnything/main.py astrbot_plugin_UnderstandAnything/astrbot_adapter/chat_entry.py
```

Expected:

- `main.py` registers `ua_get_project_state`.
- `main.py` registers `ua_select_project_context`.
- `main.py` registers `ua_project_action`.
- `main.py` registers `ua_retrieve_project_context`.
- No legacy `ua_analyze_project`, `ua_search_graph`, or `ua_chat_with_graph` tool is registered.
- `content_requires_llm` no longer returns only the redirect message in the executor.

- [ ] **Step 4: Commit verification-only doc changes if any**

If no files changed after verification, skip this step. If README wording or tests were corrected during verification, commit:

```powershell
git -C astrbot_plugin_UnderstandAnything status --short
git -C astrbot_plugin_UnderstandAnything add README.md tests/test_chat_entry.py tests/test_adapter.py tests/test_webchat_proxy.py
git -C astrbot_plugin_UnderstandAnything commit -m "test: cover UA conversation project context"
```

---

## Self-Review

**Spec coverage:** The plan covers natural chat as the primary project understanding path, `/understand` as a management-first compatible path, multiple project ambiguity, LLM-driven context switching, temporary cross-project retrieval, and keeping diagnosis unchanged.

**Placeholder scan:** The plan contains concrete file paths, test snippets, implementation snippets, commands, and expected outcomes.

**Type consistency:** New helpers use existing `ChatIntent`, `ToolResultPresenter`, `ChatActionExecutor`, `WebChatSessionContextStore`, and `_project_ref_payload` names. The new tool calls the new presenter method and uses existing event/context propagation.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-08-ua-conversation-project-context.md`.

Two execution options:

1. **Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** - execute tasks in this session using executing-plans, batch execution with checkpoints.
