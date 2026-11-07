# 成员定义格式

本文说明如何用一个 Markdown 文件定义 AgentTeams 成员：它能使用哪些工具、哪些技能、哪些 MCP 服务器，以及注入给它的默认角色提示词。

## 1. 文件放在哪里

插件按以下顺序扫描目录中的 `*.md` 文件（只看目录顶层，不递归子目录）：

| 优先级 | 目录 | 适用场景 |
|---|---|---|
| 1（最高） | `<workspace>/.agents/agents` | 项目级定义，随仓库分发 |
| 2 | `~/.dsh/agents` | 用户级、DSH 专用定义 |
| 3（最低） | `~/.agents/agents` | 用户级、跨工具共享的 CodeBuddy 风格定义 |

- 同名定义只保留优先级最高的文件；其余在目录诊断中标记为“被覆盖”。
- 目录不存在不报错。
- 文件使用 UTF-8；frontmatter 使用 YAML。

## 2. 文件结构

```md
---
name: vue3子代理
description: 专用于 Vue 3 前端工程、组件开发与组件库文档的子智能体。
model: inherit
provider:
reasoningEffort:
tools: read, edit, write, pwsh, web_search
skills: plugin-write, plugin-test
mcpServers: codegraph, anysearch
maxTasks: 5
maxContextTokens: 200000000
enabled: true
agentMode: agentic
enabledAutoRun: true
---

# Role & Profile

你是一位资深的前端架构师，精通 Vue 3 生态……
```

- frontmatter 必须以 `---` 开始并以另一行 `---` 结束。
- `---` 之后的全部正文就是**默认角色提示词**（domain persona）。
- 正文为空时，成员只使用团队统一 persona，不附加领域角色。
- 没有 `name` 时使用文件名（去掉 `.md`）作为定义名。

## 3. 字段总表

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `name` | string | 文件名 | 定义名；用于目录展示与创建成员时引用 |
| `description` | string | 空 | 一句话描述；作为成员默认 role，供队长选择成员 |
| `model` | string | `inherit` | `inherit` 或模型 id；显式模型不存在时静默回退队长路由 |
| `provider` | string | 空 | 可选；只与显式 `model` 成对使用 |
| `reasoningEffort` | string | 空 | 可选；目标模型支持的思考强度档位 |
| `tools` | 逗号分隔 string 或 string[] | 空 | 可用工具 allowlist；空 = 继承队长全部 |
| `skills` | 逗号分隔 string 或 string[] | 空 | 可用技能 allowlist；空 = 继承队长全部 |
| `mcpServers` | 逗号分隔 string 或 string[] | 空 | 可用 MCP 服务器 allowlist；空 = 继承全部已挂载 MCP |
| `maxTasks` | integer | 5 | 已完成任务配额；`0` = 不限制 |
| `maxContextTokens` | integer | 200000000 | 累计 Token 预算；`0` = 不限制 |
| `enabled` | boolean | true | `false` 时该定义不出现在目录中 |
| `agentMode` | string | — | CodeBuddy 兼容字段，忽略 |
| `enabledAutoRun` | boolean | — | CodeBuddy 兼容字段，忽略 |

`provider`、`reasoningEffort`、`maxTasks`、`maxContextTokens` 是本插件扩展字段；旧 CodeBuddy 文件即使没有它们也能直接使用。

## 4. 工具（tools）

### 4.1 规则

- 不填或空数组：继承队长当前可见的全部工具。
- 填了且部分匹配：成员只保留匹配到的工具。
- 填了但全部匹配不到：视为配置无效，回退继承队长全部工具。
- 名称 trim 后大小写不敏感精确匹配；不支持通配符。
- 最终工具集不会超过队长自身可见工具集。
- 四个团队协调工具始终保留：
  `agent_teams_claim_task`、`agent_teams_update_task`、`agent_teams_send_message`、`agent_teams_status`。
- 队长专属工具始终不会授予成员，即使定义里写了。
- 与部署方 `tool_policy` 同时存在时按并集处理：任一来源允许的工具保留，最终仍以队长可见工具为上限。

### 4.2 CodeBuddy 工具名映射

现有 `~/.agents/agents` 中的定义使用 CodeBuddy 工具名，插件按下表映射到 DSH 工具：

| CodeBuddy 名称 | DSH 工具 | 说明 |
|---|---|---|
| `read_file` | `read` | 读取文件 |
| `write_to_file` | `write` | 创建或覆盖文件 |
| `replace_in_file` | `edit` | 定向编辑 |
| `search_file` | `glob` | 文件路径匹配 |
| `list_dir` | `glob` | 目录枚举 |
| `search_content` | `grep` | 内容搜索 |
| `execute_command` | `pwsh` | 执行命令 |
| `web_search` | `web_search` | 网络搜索 |
| `web_fetch` | `web_fetch` | 抓取网页 |
| `use_skill` | `skill` | 加载技能 |
| `send_message` | `agent_teams_send_message` | 团队消息 |
| `read_rules` | `read` | 读取规则文件 |
| `read_lints` / `lsp` / `delete_file` / `preview_url` / `connect_cloud_service` / `mcp_get_tool_description` / `mcp_call_tool` / `automation_update` / `task` | — | 无直接对应，丢弃并在目录诊断中告警 |

也可以直接使用 DSH 工具名（如 `read`、`edit`、`pwsh`）。

## 5. 技能（skills）

- 规则与工具一致：不填 → 继承队长全部技能；部分匹配 → 只保留匹配项；全部匹配不到 → 继承全部。
- 技能名是 kebab-case，按 trim 后大小写不敏感精确匹配。
- **`handoff` 技能永远强制可见**：它用于成员超限后的交接文档写作，即使定义只列了别的技能。
- 插件在成员作用域内提供过滤后的技能目录；成员看不到 allowlist 之外的技能。

示例：

```yaml
skills: plugin-write, plugin-test
```

## 6. MCP 服务器（mcpServers）

- MCP 工具在 DSH 中以 `mcp__<serverName>__<rawName>` 命名。
- 规则与工具一致：不填 → 继承全部已挂载 MCP 工具；部分匹配 → 只保留匹配 server 的工具；全部匹配不到 → 继承全部。
- 单个 server 名写错：目录诊断告警，不致命。
- 本版本只负责“选择”已挂载的 MCP 服务器，不负责安装或连接新的服务器。未挂载的 server 会标记为不可用。

示例：

```yaml
mcpServers: codegraph, anysearch
```

## 7. 默认角色提示词

- frontmatter 之后的正文会作为该成员的领域 persona 注入。
- 注入顺序：
  1. 团队上下文（团队名、团队 id、目标、状态目录）；
  2. 成员身份与角色；
  3. **定义正文**；
  4. 团队 protocol / executionPrompt；
  5. AgentTeams 成员操作说明（协调工具、attemptId、汇报规则）。
- 定义正文只影响该成员，不影响队长或其他成员。
- 正文应写“你是谁、擅长什么、工作规范”，不要写团队目标、任务清单或进度（这些由团队上下文与任务提供）。

## 8. 配额

- `maxTasks`：成员名下已完成任务数上限。默认 5；`0` = 不限制。
- `maxContextTokens`：成员会话累计输入、缓存读写与输出 Token 上限。默认 200,000,000；`0` = 不限制。
- 达到任一上限后，成员在当前任务结束后写交接文档并进入 `exhausted`，不再接新任务。
- 配置优先级：创建成员时的显式参数 > 本文件 > 团队/插件默认值。
- 默认配额只对新创建的团队生效；旧团队缺字段视为不限制。

## 9. 快照与多实例

- 成员加入团队时，定义内容会快照到 `team.json`。
- 修改定义文件不会影响已加入的成员；重新添加才会使用新版。
- 同一个定义可以在同一团队创建多个成员，用 `name` 参数区分：

```text
agent_teams_add_member({ agent: "vue3子代理", name: "vue3-a" })
agent_teams_add_member({ agent: "vue3子代理", name: "vue3-b" })
```

省略 `name` 时使用定义名；团队内重名会报错并要求显式命名。

## 10. 完整示例

```md
---
name: vue3子代理
description: 专用于 Vue 3 前端工程、组件开发与组件库文档的子智能体。
model: inherit
tools: list_dir, search_file, search_content, read_file, replace_in_file, write_to_file, execute_command, web_fetch, web_search, use_skill, send_message
skills: plugin-write, plugin-test
mcpServers: codegraph, anysearch
maxTasks: 5
maxContextTokens: 200000000
enabled: true
agentMode: agentic
enabledAutoRun: true
---

# Role & Profile

你是一位资深的前端架构师与 Vue 3 技术生态专家。你的任务是编写健壮、高复用、类型安全的 Vue 3 前端代码，设计清晰的组件层级与状态流，并产出可读性高的组件 API 文档。

## 技术规范

- 默认使用 Vue 3.4+ + TypeScript + Vite + Pinia + Vue Router。
- 使用 `<script setup lang="ts">` 与 Composition API，禁止 Options API。
- 组件 Props 使用类型声明，避免 `any`。
- 复杂业务逻辑抽离为 Composables。

## 输出标准

- 代码包含完整的 `<template>`、`<script setup lang="ts">` 与 `<style scoped>`。
- 组件文档包含 Props、Emits、Slots 与最小可运行示例。
```

## 11. 常见诊断

| 现象 | 原因与处理 |
|---|---|
| 目录里看不到定义 | 检查文件是否为 `.md`、是否在三个目录之一的顶层、`enabled` 是否为 `false` |
| 工具数量比预期少 | 部分工具名未匹配；查看目录诊断中的未匹配项 |
| 所有工具都没生效 | 全部工具名未匹配，按规则回退继承队长全部工具 |
| 成员技能过多 | `skills` 未填写或全部未匹配；填写匹配的技能名即可缩小 |
| MCP 工具不可用 | 对应 MCP server 未在宿主 profile 挂载；本版本不负责安装 |
| 修改定义不生效 | 已加入成员使用快照；移除后重新添加 |
| 模型不是定义里的 | 定义的模型不存在时会静默回退队长路由；在目录诊断中确认解析结果 |
