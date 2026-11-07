# 成员定义使用 Markdown + YAML frontmatter 目录

用户已在 `~/.agents/agents` 与 `~/.dsh/agents` 维护 CodeBuddy 风格的成员定义文件，但 DSH 宿主的 agent preset 是 Cordis 插件组合、不扫描目录，两者语义不同。我们决定由插件自己扫描三处目录（工作区 `.agents/agents` 优先，其次 `~/.dsh/agents`，最后 `~/.agents/agents`），解析 Markdown 的 YAML frontmatter 与正文，把工具、技能、MCP、模型和配额映射到团队成员，并在加入团队时快照到 `team.json`；技能可见性通过插件在成员作用域注册同名 `skill` 工具覆盖宿主的注册来实现，不改宿主源码。

## Consequences

- 成员定义文件不是实时契约；修改文件后需要重新添加成员才会生效。
- 同名定义按目录优先级覆盖；未知工具名会被丢弃并在目录诊断中告警。
- 不引入宿主目录型 preset；成员定义与宿主的 agent preset 保持两个不同概念。
