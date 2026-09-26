# OMP Ultra Mode

让 [Oh My Pi](https://github.com/can1357/oh-my-pi) 在适合并行的任务中主动使用子代理。专用 `omp-ultra` 代理默认继承派发时父会话的模型与思考级别，主代理负责整合结果和最终验证。

已在 OMP **18.3.2** 验证。启用前需选定模型，并确保原生 `task` 工具可用。

## 快速开始

在要处理的项目目录运行以下命令，将路径替换为本插件的本地目录：

```bash
omp -e /absolute/path/to/omp-ultra-mode
```

请传入插件目录，OMP 会一起加载扩展和 `agents/omp-ultra.md` 中的子代理模板。

会话内使用：

```text
/ultra on
/ultra status
/ultra off
```

单独输入 `/ultra` 切换开关。开启后状态栏显示 `ULTRA`；`/ultra status` 显示当前默认子代理选择，例如 `openai/gpt-5.4:high`。

也可以在启动时开启：

```bash
omp -e /absolute/path/to/omp-ultra-mode --ultra
```

### 长期加载

将本地目录链接到 OMP 的插件配置，以后启动时即可加载：

```bash
omp plugin link /absolute/path/to/omp-ultra-mode
```

### 会话范围

Ultra 默认关闭，`--ultra` 只在启动时开启。新建、切换或分支会话后，需再次执行 `/ultra on`。请等当前运行结束后再切换模式；关闭模式会阻止新的 `omp-ultra` 派发，已派发的任务继续执行。

> [!IMPORTANT]
> 并行子代理会增加 token 消耗。插件不增加权限，也不绕过用户指令、仓库规则、审批、隔离、并发或递归深度限制。

## 工作方式

开启后，插件在每轮运行前向 system prompt 追加主动委派策略。策略要求明确子任务目标、上下文、文件所有权和验收条件；子代理执行时，主代理继续推进自己的工作。是否拆分由模型判断，简单或必须顺序执行的任务仍直接完成。

`omp-ultra` 是随插件加载的独立模板。它启动后也会启用同一策略，并在 OMP 允许的范围内继续委派。模板和策略提示词均为英文，输出语言由用户要求及任务上下文决定。

任务调度、上下文传递、隔离和结果交付使用 OMP 原生机制。模式关闭后，后续运行停止追加策略。

## 模型与思考级别

- 每次派发读取父会话的当前模型和有效思考级别。切换父模型后，下一次派发随之变化；父会话设置保持原样。
- `before_subagent_spawn` 钩子设置模型选择器，保留 OMP 格式化器支持的 provider 路由。经过该钩子的 `task` 和 `eval` 派发使用相同规则。
- 继承规则只用于 `omp-ultra`，其他代理继续使用自己的模板和配置。`omp-ultra` 是插件保留名称，其模板或 `task.agentModelOverrides` 中的模型选择会被继承规则覆盖。
- 插件保留现有 `task.enableEffort` 设置。若已开启该选项，调用中显式指定的 `effort: lo|med|hi` 按 OMP 原生规则优先于继承级别；`task.maxEffort` 在这条显式 effort 路径生效，不能作为所有继承请求的绝对上限。
- 后续扩展钩子、显式启用的 prewalk、原生重试或 fallback 仍可能改变最终执行选择。

## 开发与验证

```bash
bun install --frozen-lockfile
bun run check
bun test
```

开发验证使用 Bun **1.3.14**。`test/ultra.test.ts` 通过 OMP SDK 的会话、扩展加载器、`task` 和子代理执行器运行集成测试，使用本地确定性 provider，无需模型 API 凭据。覆盖以下行为：

- 父模型与思考级别继承，以及普通代理模板隔离；
- 实时切换模型和思考级别；
- 显式原生 effort 与其上限的优先级，父会话保持不变；
- 关闭模式后拒绝专用代理，普通代理仍可执行；
- 新会话清除原有启用状态。

加载和命令行为已通过 OMP 18.3.2 的 RPC UI 冒烟验证。测试验证运行机制，实际任务拆分效果取决于所用模型。

## 项目结构

- [`index.ts`](index.ts)：模式开关、状态提示和派发钩子。
- [`agents/omp-ultra.md`](agents/omp-ultra.md)：专用子代理模板。
- [`prompts/proactive.md`](prompts/proactive.md)：主动委派策略。
- [`test/ultra.test.ts`](test/ultra.test.ts)：继承、覆盖和会话生命周期的集成测试。
