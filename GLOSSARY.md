# AgentTeams

AgentTeams 是运行在 DeepSeek Harness 内的多智能体团队协作上下文：一个队长会话带领若干成员，通过持久任务板、依赖图和邮箱协同完成目标。

## Language

**队长（Captain）**：
创建并领导一个团队的会话；同一时刻只带领一个团队。
_Avoid_: 主 agent、lead agent

**成员（Member）**：
由队长创建、加入团队并承接任务的持久可续聊子代理；拥有独立的会话、模型路由与配额。
_Avoid_: 子代理（泛指）、worker、teammate

**成员定义（Member Definition）**：
描述一个成员能力的 Markdown 文件：YAML frontmatter 声明工具、技能、MCP、模型与配额，正文提供默认角色提示词。
_Avoid_: agent preset、子代理配置、profile

**成员目录（Member Directory）**：
插件按固定优先级扫描成员定义文件的目录集合：工作区 `.agents/agents`、`~/.dsh/agents`、`~/.agents/agents`。
_Avoid_: agent 库、预设目录

**成员快照（Member Snapshot）**：
成员加入团队时固化到团队状态中的定义副本；之后修改定义文件不影响已加入的成员。
_Avoid_: 实时引用、热更新

**模型路由（Model Route）**：
一个成员当前使用的 provider、model 与 reasoningEffort 组合。
_Avoid_: 模型配置、LLM 设置

**路由快照（Route Snapshot）**：
成员首次创建时记录的原始模型路由；用于冷恢复时校验宿主中的不可变描述符，并与用户后续切换的当前路由区分。
_Avoid_: 原始模型、spawn route

**成员配额（Member Quota）**：
限制单个成员可承接工作量的两个上限：已完成任务数与累计 Token 消耗。
_Avoid_: 限额、预算（单独使用时含义不清）

**上下文预算（Context Budget）**：
成员配额中的 Token 维度，按成员会话累计的输入、缓存读写与输出 Token 计量；不是当前上下文窗口占用。
_Avoid_: 上下文长度、context window

**超限成员（Exhausted Member）**：
已达到任一成员配额、完成交接后保留在名册中但不再承接新任务的成员。
_Avoid_: 离职成员、失效成员

**交接文档（Handover Document）**：
超限成员在结束当前任务后写给队长的结构化状态说明，包含已完成工作、改动文件、风险与建议接手步骤。
_Avoid_: handoff 文档、总结

**任务（Task）**：
团队任务板上带状态、依赖与可选质量合同的工作单元；只能由一名成员在一个执行尝试中持有。
_Avoid_: ticket、工作项

**执行尝试（Attempt）**：
成员对某个任务的一次独占执行代次；每次领取或转派生成新的 attemptId，旧尝试的更新会被拒绝。
_Avoid_: run、执行轮次

**会话 Fork（Session Fork）**：
从一个已有会话复制历史后产生的独立根会话；在 DSH 0.2.2 及以后不再记录父会话 id，也不继承父会话的团队。
_Avoid_: 分支会话、子会话

**工作区（Workspace）**：
团队状态文件与成员定义所在的项目目录；团队目录为 `<workspace>/<stateDir>/<teamId>/`。
_Avoid_: 项目根、cwd
