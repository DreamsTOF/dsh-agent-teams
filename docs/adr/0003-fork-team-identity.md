# Fork 会话的团队身份按精确 captainSessionId

插件曾用 `parentSession` 链让 fork 继承父队的 lead 身份（#176），以便 fork 继续查看父队。但 DSH 0.2.2 的普通 fork 已不再写入 `parentSession`，而旧逻辑会把仍带 `parentSession` 的 fork 误判为父队队长，导致 `agent_teams_create` 报 “you already lead team”。我们决定：团队归属只认精确的 `captainSessionId`；fork 是独立根会话，不继承父队视图；需要识别普通 fork 时使用 `isSeeded === true && origin !== 'subagent' && delegationDepth === 0`，绝不把 `parentSession` 当作 lead 关系。

## Consequences

- fork 可以在任意支持版本的宿主上创建自己的团队，父团队不受影响。
- 有意放弃 #176 的“fork 查看父队”行为；fork 在创建自己的团队前面板不显示任何团队。
- 同一工作区内团队名仍需唯一；同名创建会被拒绝并提示改名。
