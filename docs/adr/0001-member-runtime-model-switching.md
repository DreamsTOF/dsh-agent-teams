# 成员运行时模型切换

成员创建时的模型路由会同时写入 `team.json` 和宿主子代理的不可变描述符；官方 `session-controller.selectModel` 又拒绝 `origin=subagent` 的会话，所以成员一旦创建就无法从 UI 调整路由。我们决定由插件在活动面板提供成员行内模型选择，仅空闲成员可切换，后端通过 `ctx.agents.get(childId).model.select()` 让新路由从下一个模型 step 生效；切换结果写回 `team.json`，同时保留 spawn 时的路由快照用于冷恢复校验，手动切换会清除自动 fallback 状态。

## Consequences

- 不修改宿主源码，也不依赖官方模型菜单对子会话开放。
- 运行中的成员会被直接拒绝，不排队、不中断当前 turn。
- 宿主描述符保持创建时的原始路由；冷恢复用路由快照区分“描述符路由”和“用户当前路由”，避免现有的一致性校验误报。
