# AgentTeams 0.2.0 升级需求与设计

- 状态：需求冻结（本轮只产出文档，不写代码）
- 目标版本：0.2.0
- 宿主基线：deepseek-harness master（0.2.2-rc.1 线）
- 改动边界：只改 `dsh-agent-teams` 插件；不修改宿主源码。宿主能力不足处，用插件在成员作用域覆盖或插件状态层实现。
- 术语表：见仓库根目录 [GLOSSARY.md](../../GLOSSARY.md)

---

## 1. 背景与目标

dsh-agent-teams 已支持队长创建 staged 团队、成员任务调度、质量门禁与活动面板。本次升级解决四类实际痛点：

1. **成员运行时模型切换**：成员一旦开始运行，无法从 UI 调整 provider/model/reasoningEffort；直接改 `team.json` 会与宿主子代理描述符不一致而无法冷恢复。
2. **成员定义目录**：用户已有 `~/.agents/agents`、`~/.dsh/agents` 中的 Markdown 成员定义，希望队长能发现并按定义创建成员，且定义能声明可用工具、技能、MCP 与默认角色提示词。
3. **成员配额**：缺少单个 subagent 的任务量与上下文预算，容易出现一个成员包揽全部工作或无限累积上下文。
4. **fork 会话建队**：fork 出来的会话被误判为父团队队长，无法创建自己的团队。

本次升级不重写运行时；四项能力全部落在插件侧。

---

## 2. 通用约束

### 2.1 插件边界

- 不修改 `deepseek-harness` 源码，不 fork 宿主运行时。
- 只使用宿主公开接缝：`ctx.agents`、`ctx.subagents`、`ctx.tools`、`ctx.skills`、`ctx.sessionProjections`、`ctx.tokenMeter`、`ctx.llm`、`ctx.systemPrompt` 与 Web 路由。
- 需要覆盖宿主行为时，只在成员子会话的 `childCtx` 作用域内注册同名工具或限制工具集，不改变全局注册。

### 2.2 兼容性

- 现有 `team.json` 必须可读；新增字段全部可选，缺失按“无限制/继承”处理。
- 旧队伍在新版本加载后不应因为默认配额突然被停掉。
- 成员子会话仍是持久可续聊会话；冷恢复必须能恢复 persona、工具过滤、技能过滤、MCP 过滤与当前模型路由。

### 2.3 状态与真相源

- `team.json` 是团队事实来源；宿主 `ctx.agents` 只提供活动状态。
- 所有成员定义在加入团队时快照到 `team.json`；之后定义文件的变化不影响已加入成员。
- 活动面板与 `agent_teams_status` 读取同一份持久状态。

---

## 3. 需求一：成员运行时模型切换

### 3.1 用户故事

作为团队使用者，我希望在活动面板里直接切换某个空闲成员的模型，而不需要重建团队、丢失会话历史或手改 `team.json`。

### 3.2 交互

- 位置：活动面板成员行的模型徽标改为可点击的下拉/弹层。
- 可选维度：`provider`、`model`、`reasoningEffort` 三件套。
- 选项来源：宿主 `ctx.llm.listProviders()` / `listModels()` 的实时目录，与主输入区一致。
- 确认后立即校验并写回；UI 显示最终生效路由。
- 成员行同时显示当前路由；若自动 fallback 生效，显示 fallback 标记与当前实际路由。

### 3.3 生效条件

| 成员状态 | 是否可切 | 行为 |
|---|---|---|
| staged（尚未 spawn） | 是 | 走现有 staged 计划编辑器，不调用运行时接口 |
| idle / ready | 是 | 校验后调用宿主切换接口，下一个模型 step 生效 |
| working / running | 否 | 返回错误“成员正在运行，请在当前任务结束后切换”；不排队、不中断 |
| exhausted | 否 | 已不承接新任务，不提供切换入口 |
| removed | 否 | 不在活动成员列表展示 |

### 3.4 持久化

- `TeamMember.provider` / `model` / `reasoningEffort` 表示**当前生效路由**。
- 新增 `TeamMember.spawnProvider` / `spawnModel` / `spawnReasoningEffort` 保存首次 spawn 的原始路由快照。
- 运行时切换只更新当前路由字段，不改写 spawn 快照与宿主不可变描述符。
- 冷恢复时：
  - 描述符一致性校验比较 `spawn*`，没有 `spawn*` 的旧成员退回比较 `provider/model`；
  - 成员初始化时用当前路由调用 `agent.model.select()`，恢复用户最后的选择。
- 手动切换时清空 `fallbackActive` / `activeProvider` / `activeModel`；自动 fallback 仍可在后续失败时重新触发。

### 3.5 校验与错误

- provider 必须已注册，model 必须在该 provider 的目录中；reasoningEffort 必须是目标模型支持的档位。
- 团队成员必须属于当前团队且未 removed；团队 halted 时拒绝。
- 校验失败返回可读错误，不产生部分写入。
- 切换是幂等的：相同路由重复提交不产生额外记录。

### 3.6 验收标准

1. idle 成员可在活动面板切换 provider/model/reasoningEffort，刷新页面后仍显示新路由。
2. 成员被唤醒执行下一任务时，宿主实际请求使用新路由。
3. 运行中的成员切换被拒绝，提示明确，不打断当前任务。
4. 成员在切换后 cold resume，仍使用切换后的路由，不因描述符原始路由不一致而启动失败。
5. 自动 fallback 激活时手动切换，fallback 状态被清除，新路由成为主路由。

---

## 4. 需求二：成员定义目录

### 4.1 目录与优先级

扫描以下目录中的 `*.md` 文件（顶层文件，不递归子目录）：

| 优先级 | 目录 | 说明 |
|---|---|---|
| 1（最高） | `<workspace>/.agents/agents` | 项目级定义，随仓库走 |
| 2 | `~/.dsh/agents` | 用户级 DSH 专用定义 |
| 3（最低） | `~/.agents/agents` | 用户级跨工具共享定义 |

- 同名定义按优先级覆盖：只保留最高优先级的文件，较低优先级同名的文件在目录诊断中标记为被覆盖。
- 目录不存在视为空目录，不报错。
- 定义文件按 UTF-8 读取，允许 BOM；frontmatter 使用 YAML。

### 4.2 文件结构

```md
---
name: vue3子代理
description: 专用于 Vue 3 前端工程与组件库文档的子智能体。
model: inherit
tools: read, edit, write, pwsh, web_search
skills: plugin-write, plugin-test
mcpServers: codegraph, anysearch
maxTasks: 5
maxContextTokens: 200000000
---

# Role & Profile

你是一位资深的前端架构师……（正文即默认角色提示词）
```

- YAML frontmatter 必须以 `---` 开场和结束。
- 正文可以为空：为空时不注入领域提示词，只使用团队标准 persona。
- 文件缺少 `name` 时使用文件名（去 `.md`）作为定义名。

### 4.3 字段说明

| 字段 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `name` | string | 文件名 | 定义名；用于目录展示与 `agent_teams_add_member` 的 `agent` 参数 |
| `description` | string | 空 | 一句话描述；作为成员默认 role，也是队长选择成员的主要依据 |
| `model` | string | `inherit` | `inherit` 或显式模型 id；显式模型不存在时**静默回退队长路由**，不阻断创建 |
| `provider` | string | 空 | 可选；与显式 `model` 配对。只有 provider 没有 model 视为配置无效，回退队长路由 |
| `reasoningEffort` | string | 空 | 可选；目标模型支持的档位 id；不合法时使用目标模型默认档 |
| `tools` | string / string[] | 空 | 工具 allowlist；空或缺失 = 继承队长全部工具。支持逗号分隔或 YAML 数组 |
| `skills` | string / string[] | 空 | 技能 allowlist；空或缺失 = 继承队长全部技能 |
| `mcpServers` | string / string[] | 空 | MCP 服务器 allowlist；空或缺失 = 继承全部已挂载 MCP 工具 |
| `maxTasks` | integer | 5 | 已完成任务配额；`0` 表示不限制；只对新团队默认生效 |
| `maxContextTokens` | integer | 200000000 | 累计 Token 预算；`0` 表示不限制；只对新团队默认生效 |
| `enabled` | boolean | true | `false` 时不出现在目录与队长可选项中 |
| `agentMode` | string | — | CodeBuddy 兼容字段，忽略 |
| `enabledAutoRun` | boolean | — | CodeBuddy 兼容字段，忽略 |

### 4.4 工具语义

- **不填或空数组**：继承队长当前可见的全部工具。
- **部分匹配**：只保留成功映射到 DSH 工具的项。
- **全部匹配不到**：视为配置无效，回退继承队长全部工具（与用户定义的“全错继承”一致）。
- 名称匹配规则：`trim` 后大小写不敏感精确匹配；不允许通配符。
- 最终工具集必须 **不超过队长自身可见工具集**；不能通过定义提升权限。
- 四个协调工具始终保留，不受 allowlist 影响：`agent_teams_claim_task`、`agent_teams_update_task`、`agent_teams_send_message`、`agent_teams_status`。
- 与部署方 `tool_policy` 同时存在时：按并集处理——定义允许或策略允许的工具都保留，最终仍以队长可见工具为上限；四个协调工具始终加入并始终拒绝队长专属工具。

#### CodeBuddy → DSH 工具映射

| CodeBuddy 名称 | DSH 工具 | 说明 |
|---|---|---|
| `read_file` | `read` | 文件读取 |
| `write_to_file` | `write` | 新建/整体覆盖文件 |
| `replace_in_file` | `edit` | 定向编辑 |
| `search_file` | `glob` | 文件路径匹配 |
| `list_dir` | `glob` | 目录枚举的最接近能力 |
| `search_content` | `grep` | 内容搜索 |
| `execute_command` | `pwsh` | 命令执行 |
| `web_search` | `web_search` | 网络搜索 |
| `web_fetch` | `web_fetch` | 抓取网页 |
| `use_skill` | `skill` | 技能加载 |
| `send_message` | `agent_teams_send_message` | 团队邮箱消息 |
| `read_rules` | `read` | 读取规则文件 |
| `read_lints` / `lsp` / `delete_file` / `preview_url` / `connect_cloud_service` / `mcp_get_tool_description` / `mcp_call_tool` / `automation_update` / `task` | — | 无直接对应能力，丢弃并在目录诊断中告警 |

### 4.5 技能语义

- 规则与工具一致：不填 → 继承队长全部技能；部分匹配 → 只保留匹配项；全部匹配不到 → 继承全部。
- 技能名为 kebab-case，`trim` 后大小写不敏感精确匹配。
- **`handoff` 技能始终强制可见**（与四个协调工具同级），即使成员定义只列了其他技能或全部匹配失败。
- 技能过滤实现：插件在成员 `childCtx` 注册同名 `skill` 工具，覆盖宿主 `tool-skill` 的注册，只发布 allowlist 内的技能目录；不修改宿主源码。
- 若宿主缺少 `handoff` 技能，插件使用内置交接模板作为兜底，保证交接流程可用。

### 4.6 MCP 语义

- 已挂载 MCP 服务器按工具名前缀识别：`mcp__<serverName>__<rawName>`。
- 规则与工具一致：不填 → 继承全部 MCP 工具；部分匹配 → 只保留匹配 server 的工具；全部匹配不到 → 继承全部。
- 单个 server 名写错：目录诊断告警，不致命；若所有 server 都写错，按“全部匹配不到”继承全部。
- 本版本**不负责安装或连接新的 MCP server**；`mcpServers` 只能从宿主已挂载的服务器中选择。未挂载的 server 在目录诊断中标记为不可用。

### 4.7 默认角色提示词

成员 persona 按固定顺序组装：

1. 团队上下文（团队名、团队 id、目标、状态目录）。
2. 成员身份与角色（`name` + `role`）。
3. **定义正文**（领域角色与工作规范）。
4. 团队 protocol / executionPrompt。
5. AgentTeams 成员操作说明（协调工具、attemptId、汇报规则）。

定义正文只影响成员自己的 persona，不改变队长或其他成员。

### 4.8 快照与成员创建

- `agent_teams_add_member` 新增 `agent` 参数：按定义名选择成员定义。
- 同名定义可以在同一团队创建多个成员，用 `name` 参数区分实例；省略 `name` 时使用定义名，冲突则报错要求显式命名。
- 添加时把以下内容快照到 `TeamMember`：
  - 定义名、来源路径、内容哈希；
  - 解析后的模型路由；
  - 解析后的工具过滤、技能 allowlist、MCP allowlist；
  - `maxTasks` / `maxContextTokens`；
  - 最终 persona。
- 已有成员在定义文件变化后不自动更新；需要移除后重新添加。
- `profile.members` 也可使用 `agent: <定义名>` 引用成员定义；显式字段覆盖定义字段。

### 4.9 队长发现目录

新增工具 `agent_teams_list_member_definitions`，返回：

- `name` / `description` / `source`（workspace / dsh / user）/ `path`
- 解析后的 `model` 路由与来源（`inherit` / 定义 / 队长）
- `tools` / `skills` / `mcpServers` 的请求值、解析结果与未匹配项
- `maxTasks` / `maxContextTokens`
- `enabled`
- `diagnostics`（YAML 错误、被覆盖、未知工具、未挂载 MCP 等）

该工具只读，不修改任何文件。staged 计划编辑器也读取同一目录并展示可选成员。

### 4.10 验收标准

1. 三处目录中的定义都能被扫描，同名按“工作区 > ~/.dsh > ~/.agents”覆盖。
2. `agent_teams_list_member_definitions` 返回定义名、描述、工具、技能、MCP、模型、配额与诊断。
3. `agent_teams_add_member({ agent: "vue3子代理" })` 能创建成员，persona 包含定义正文，工具/技能/MCP 按规则生效。
4. `tools`、`skills`、`mcpServers` 的全错场景回退继承全部；部分匹配只保留匹配项。
5. 定义 `enabled: false` 不出现在目录；YAML 解析失败只影响该文件，不阻断其他定义。
6. 修改定义文件不会影响已加入成员；重新添加后生效。
7. 成员最终工具集不超过队长可见工具集，四个协调工具始终可用。
8. `handoff` 技能在所有成员上始终可见。

---

## 5. 需求三：成员配额与交接

### 5.1 配额模型

| 配额 | 默认 | 统计口径 | 0 值 |
|---|---|---|---|
| `maxTasks` | 5 | 成员名下 **completed** 状态任务数；failed/cancelled 不计 | 不限制 |
| `maxContextTokens` | 200000000（2 亿） | 成员会话累计 `inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens` | 不限制 |

- 默认值只对 **新创建团队** 生效；旧 `team.json` 缺字段的成员视为不限制。
- 配置优先级（高到低）：
  1. 成员显式配置（`add_member` / staged 计划编辑器 / profile 成员行）；
  2. 成员定义 frontmatter；
  3. 团队/插件默认（`memberMaxTasks` / `memberMaxContextTokens`）。
- `maxTasks` 与 `maxContextTokens` 任一达到即触发超限；两者独立。

### 5.2 计量

- 任务数：实时统计 `team.tasks` 中 `assignee === member.name && status === 'completed'` 的数量；不依赖成员本地计数。
- Token：读取成员子会话的 `tokenUsage` 投影（宿主持久日志的累计四桶）；不把当前上下文窗口占用当作累计预算。
- 成员被移除、重试、转派不重置已完成的累计任务数；新成员从零开始。

### 5.3 状态机

`MemberStatus` 增加 `exhausted`：

```
idle ──claim──> working ──complete──> idle
                                  └── 配额达到 ──> exhausted
exhausted ──仍可接收消息/写交接──> exhausted（只读，不再 claim）
```

- `exhausted` 成员保留在名册与会话中，可被队长移除，也可被追问。
- `exhausted` 不阻止接收普通消息或 handoff 提示；只阻止接受新任务与新的 attempt。
- 队长不能通过 `reassign_task` 给 `exhausted` 成员派新任务；需要先移除或用其他成员。

### 5.4 触发点

1. **领取/转派时**：`agent_teams_claim_task` 与 `agent_teams_reassign_task` 检查配额；已达上限直接拒绝并标记 `exhausted`。
2. **任务完成时**：`agent_teams_update_task` 将任务置为 `completed` 后检查；达到上限则把成员置为 `exhausted` 并启动交接。
3. **任务执行中 Token 超限**：允许当前任务继续完成；插件向队长发送一次超限预警，不中断成员。
4. **调度器**：`kickMember` / `kickTeam` 跳过 `exhausted` 成员，不再为它们分配任务。
5. **创建任务时**：显式指定 `exhausted` 成员为 assignee 时拒绝，提示改用其他成员或先移除。

### 5.5 交接流程

```
任务完成 / 配额命中
  → 成员标记 exhausted
  → 插件给队长邮箱写消息：成员 X 已达配额，已请求交接
  → 插件给成员邮箱写消息：请阅读 handoff 技能，写交接文档到 <workspace>/<stateDir>/<teamId>/handover/<member>.md
  → 成员读 handoff 技能、写文档
  → 成员给队长发消息：路径 + 3 行摘要
  → 队长决定用其他成员/新成员继续
```

- 交接消息必须携带明确的输出路径与固定模板章节。
- 若成员没有写出文件或没有回消息，成员保持 `exhausted`，队长可在状态中看到 `handoverPending` 并再次要求。
- 交接文档不是任务；不进入任务板，不占用 attempt。

### 5.6 交接文档模板

固定章节（使用 `handoff` 技能写作，路径覆盖为该成员的团队交接文件）：

```md
# Handover: <member>

## 当前任务与状态
## 已完成工作
## 改动文件
## 未完成项与风险
## 建议接手步骤
## 关键命令与验证结果
```

### 5.7 UI

- 成员行显示：`已完成任务数 / maxTasks`、`累计 Token / maxContextTokens`（简写为 k/M）。
- 达到配额时显示 `exhausted` 徽标与交接状态（pending / written）。
- 活动面板与 `agent_teams_status` 都能读到超限原因与交接路径。

### 5.8 验收标准

1. 新团队默认 `maxTasks=5`；旧团队缺字段不受影响。
2. 成员完成第 5 个任务后不再接到第 6 个任务，状态为 `exhausted`。
3. Token 累计达到 200,000,000 时同样触发，即使任务数未满。
4. 当前任务允许完成；不会因为超限中断在途工作。
5. 触发后队长收到消息，成员收到带路径的 handoff 消息，并成功写出交接文档。
6. `handoff` 技能在成员技能目录中始终可见，即使定义允许列表中没有它。
7. `exhausted` 成员不能被 `claim_task` 或 `reassign_task` 派新任务，但仍能完成交接消息。

---

## 6. 需求四：fork 会话建队

### 6.1 根因

- 团队归属由 `team.json` 的 `captainSessionId` 决定；创建团队时用 `findTeamByParticipant` + `leadIdentityOfAsync` 判断调用者是否已带队。
- `lineage.ts` 的 `teamLeadMatch` 认为“顶层 fork 继承父队 lead 身份”，所以 fork 被当成父团队队长，`agent_teams_create` 报 `you already lead team "…"`。
- DSH 0.2.2 起普通 fork 不再写 `header.parentSession`；0.2.1-rc.5 及更早仍写。旧逻辑在新旧宿主上都不应再把 `parentSession` 当 lead 关系。

### 6.2 身份契约

1. 一个团队只属于一个精确的 `captainSessionId`。
2. `agent_teams_create` 只允许精确 `captainSessionId === caller.id` 的判断；不能使用 fork 继承的 lead 身份。
3. 普通 fork 是独立根会话；不可见父团队，也不向父团队读写任何状态。
4. fork 识别辅助条件（用于 UI/诊断，不用于团队归属）：
   `header.isSeeded === true && header.origin !== 'subagent' && (header.delegationDepth ?? 0) === 0`
5. 成员会话（`origin === 'subagent'`）永远不是队长候选。

### 6.3 修复行为

- `findTeamByCaptain` / `findTeamByParticipant`：精确 id 优先；不再把 lineage 命中的队伍当作调用者自己的团队。
- `teamLeadMatch` 不再从 `parentSession` 推导 lead 身份；`nearestLiveLead` 不再向 fork 投递父队报告。
- `agent_teams_status` 在 fork 未建队前返回“无团队”；建队后只返回 fork 自己的团队。
- 同名团队：同一 `<workspace>/<stateDir>` 下已有同 `teamId` 的团队时，`agent_teams_create` 拒绝并提示改名；不自动加后缀。
- 父团队状态、成员、任务、邮箱完全不受 fork 建队影响。

### 6.4 迁移与兼容

- 不迁移旧团队数据；旧团队仍归原 `captainSessionId`。
- 旧版本中通过 #176 继承父队视图的 fork，升级后将不再显示父队；这是有意的行为变更。
- 新版本在 0.2.2 与旧宿主（fork 带 `parentSession`）上都必须允许 fork 建队。

### 6.5 验收标准

1. 根会话创建团队 A；fork 后调用 `agent_teams_create` 创建团队 B 成功。
2. fork 的 `agent_teams_status` 在创建 B 前返回无团队，创建后只显示 B。
3. 根会话的团队 A 不受影响；两个团队的任务、成员、邮箱互不串线。
4. 在模拟旧宿主的 `parentSession` fork 上同样能创建 B，不再报 `you already lead team`。
5. 同 workspace 用同名团队创建时被拒绝并提示改名。
6. 成员会话（`origin === 'subagent'`）不会被识别为队长。

---

## 7. 非目标

- 不修改宿主源码，不 fork 宿主运行时。
- 不实现 MCP server 安装/连接；只从宿主已挂载的 MCP 工具中做选择。
- 不支持运行中成员切换模型（只支持 idle 成员）。
- 不自动创建替补成员；超限后由队长决定用谁继续。
- 不实现成员定义的实时热更新；添加时快照。
- 不改变现有任务状态机、质量门禁与 review 循环。
- 本轮不写代码，只评审文档。

---

## 8. 总体验收清单

| ID | 验收项 |
|---|---|
| A1 | idle 成员可切换 provider/model/reasoningEffort，刷新与冷恢复后保持 |
| A2 | 运行中成员切换被拒绝且不中断任务 |
| A3 | 手动切换清除 fallback，后续仍可自动 fallback |
| B1 | 三处成员定义目录扫描与优先级正确 |
| B2 | 定义字段解析、工具映射、skills/mcp 全错回退正确 |
| B3 | `agent_teams_list_member_definitions` 与 `add_member({agent})` 可用 |
| B4 | 定义快照后修改文件不影响已加入成员 |
| B5 | `handoff` 技能与四个协调工具始终可见 |
| C1 | 新团队默认 maxTasks=5、maxContextTokens=200000000 |
| C2 | 达到任一配额后成员 `exhausted` 且不再接新任务 |
| C3 | 当前任务完成后自动触发 handoff 文档与队长通知 |
| C4 | 旧团队缺字段不受新默认配额影响 |
| D1 | fork 可独立创建团队；父团队不受影响 |
| D2 | fork 未建队前不显示父团队；同名团队被拒绝 |
| D3 | 新旧宿主（带/不带 parentSession）fork 都能建队 |

---

## 9. 相关文档

- [成员定义格式](./member-definitions.md)
- [ADR-0001：成员运行时模型切换](../adr/0001-member-runtime-model-switching.md)
- [ADR-0002：成员定义目录](../adr/0002-member-definition-directory.md)
- [ADR-0003：Fork 团队身份](../adr/0003-fork-team-identity.md)

---

## 10. 预计改动面（实现阶段评审用）

| 模块 | 预计改动 |
|---|---|
| `src/types.ts` | `TeamMember` 增加当前/原始路由快照、成员定义快照、配额与 `exhausted` 状态；`TeamState` 增加新团队默认配额快照 |
| `src/member-definitions.ts`（新） | 三目录扫描、YAML frontmatter 解析、工具名映射、skills/mcp 解析、目录诊断 |
| `src/members.ts` | persona 合成、`runtimeSetup` 扩展、冷恢复时恢复技能/MCP/当前路由、成员状态维护 |
| `src/tools.ts` | `agent_teams_list_member_definitions`、`add_member({agent})`、claim/reassign 配额校验、任务完成触发交接 |
| `src/scheduler.ts` | 调度时跳过 `exhausted` 成员 |
| `src/state.ts` / `src/lineage.ts` | 精确 `captainSessionId` 团队归属、fork 识别与创建校验 |
| `src/web-routes.ts` / `src/index.ts` | 模型目录查询与成员模型切换路由 |
| `src/client/ActivityPanel.tsx` / `StagingPlanEditor.tsx` / `locales.ts` | 成员行模型选择器、配额用量与 exhausted 徽标、定义目录展示 |
| `src/harness-compat.ts` | 成员作用域 `skill` 工具覆盖、MCP 工具过滤、tokenUsage 读取辅助 |
| `scripts/` | 新增解析器、工具映射、配额、fork 身份与冷恢复的 TDD/回归验证 |

---

## 11. 本轮决策清单

| 决策 | 结论 |
|---|---|
| 宿主改动边界 | 不改宿主源码；只在成员作用域做插件级覆盖 |
| 宿主版本基线 | 最新 master（0.2.2-rc.1 线） |
| 模型切换维度 | provider / model / reasoningEffort 三件套 |
| 模型切换时机 | 仅空闲成员可切；运行中直接拒绝 |
| 模型切换入口 | 活动面板成员行内联下拉 |
| 手动切换 vs fallback | 手动选择优先并清除 fallback 状态 |
| 定义目录优先级 | 工作区 `.agents/agents` > `~/.dsh/agents` > `~/.agents/agents` |
| 定义格式 | 原 CodeBuddy 格式 + DSH 工具名映射；未知工具告警 |
| tools / skills / mcpServers | 不填继承全部；部分匹配只保留匹配；全部匹配不到继承全部 |
| 技能过滤实现 | 插件在成员 `childCtx` 注册同名 `skill` 工具覆盖宿主注册 |
| tool_policy 与定义 tools | 取并集，最终不超过队长可见工具 |
| 同定义多实例 | 允许；用成员 `name` 区分 |
| 任务配额 | 默认 5 个已完成任务；仅新团队生效 |
| 上下文预算 | 默认 200,000,000 tokens；累计输入 + 缓存读写 + 输出 |
| 配额配置优先级 | 成员显式 > 定义文件 > 团队/插件默认 |
| 超限处理 | 标记 `exhausted` 保留；当前任务结束后写交接文档并通知队长 |
| 交接 skill | 使用现有 `handoff` skill，所有成员强制可见 |
| fork 团队归属 | 只认精确 `captainSessionId`；fork 不继承父队视图；同名拒绝 |
| 文档语言 | 中文为主，尽量少写英文 |

