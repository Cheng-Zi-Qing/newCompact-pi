# Benchmark 清单：真实 issue → 我们的测试

> 目的：让"压缩插件悄悄坏掉"的每一种真实形态都有一个可回归的测试。每个用例名里带来源仓库和 issue 号，上游修复或复现时可对号入座。
>
> 运行：在仓库目录执行 `npm test`（benchmark 全部在 `tests/benchmarks.test.ts`）。宿主模块自动解析，可用 `PI_GLOBAL_NODE_MODULES` 覆盖。当前 **17 条，全部通过**。

## 为什么用别人的 issue 当 benchmark

自造边界用例只能覆盖"我能想到的"；真实 issue 覆盖的是"几十万人用出来的"。挑了两类来源：

- **coding agent 主仓库**（Claude Code、Codex、OpenCode、Crush）：压缩在产品层的失败——不触发、压完丢历史、报"conversation too long"、阈值不可调。
- **压缩插件自己的仓库**（billion-context、pi-prefix-cache-compaction、pi-compaction-control）：压缩实现的失败——污染会话、上下文不减反涨、估算陈旧不触发、存储故障静默停用、走独立 HTTP 层丢认证、路径硬编码。

第二类尤其有用：那是同一个问题的不同实现，它们的 bug 就是我们下一步最可能踩的坑。

## 一、coding agent 侧

| 用例 | 来源（时间 / 热度） | 报告的问题 | 这条钉住的行为 |
|---|---|---|---|
| `benchmark claude-code#7502: first compaction has no archive pointer` | 2025-09-12 / 39👍 | 自动压缩后历史全丢、无警告 | 首次无旧摘要、无已有归档文件，不输出假路径 |
| `benchmark claude-code#7502: second compaction names an archive that exists` | 同上 | 同上 | 第二次快照给出真实归档路径与 `read_tool_result(entryId, offset, limit)` 用法，首份快照确实落盘 |
| `benchmark claude-code#66144: context past 100% of the window still snapshots` | 2026-06-08 / 25👍 | 到 100% 窗口不触发压缩、会话卡死 | 总量**超过** `contextWindow` 时仍走 tight 档出快照（`compressed === true`），不 `Fallback("capacity")` |
| `benchmark claude-code#18211: manual compaction over capacity never cancels` | 2026-01-14 / 25👍 | `/compact` 报 "conversation too long" | manual + 超容量时**不返回 `{cancel:true}`**；能压就压，压不了返回 `undefined` 交回原生摘要 |
| `benchmark codex#4106: compaction.enabled=false keeps manual working` | 2025-09-23 / 138👍 | 阈值硬编码、擅自压缩折掉工作上下文 | 关闭自动后边界与 usage 都不压，但 manual 仍执行；enabled=true 时边界自动压缩 |
| `benchmark opencode#8140: triggerRatio 0.5 compacts at half the window` | 2026-01-13 / 82👍 | 阈值不可调、想更早压缩 | ratio 0.5 时在 50% 触发；默认 0.8 时同样输入不触发 |
| `benchmark crush#472: an aborted compaction writes no archive` | 2026 / 6👍 | 压缩会话挂住 | abort 的尝试不污染归档 |
| `benchmark crush#472: an aborted compaction releases the guard` | 2026 / 6👍 | 同上 | 中断后按 pi 的真实事件序列（`session_compact_failed`）复位 `compacting`/attempt，会话不被 10 分钟 staleness 卡死 |
| `benchmark crush#2382: low-value tool noise is pruned before it reaches the summary` | 2026 / 5👍 | 长会话低价值 token 太多 | 超限工具结果进摘要前是"头尾 + 标记"形态；摘要输入比 pi serializer 至少小 30% |

## 二、压缩插件侧

| 用例 | 来源 | 报告的问题 | 这条钉住的行为 |
|---|---|---|---|
| `benchmark billion-context#5536: a failed archive write still returns the snapshot` | 2026-11-02 | 存储打开失败导致功能自动停用 | `PI_COMPACT_DIR` 不可写时**照常出快照**，且恢复点如实写"未归档"，不指向不存在的文件 |
| `benchmark billion-context#5534: compaction never writes summary text into tool call arguments` | 2026-11-02 | 紧急折叠把 summary 写进 `tool_calls.arguments`，永久污染会话、严格 JSON 上游直接炸 | 压缩前后所有 `toolCall.arguments` 仍是可 `JSON.stringify` 往返的对象；摘要只出现在 compaction entry 里 |
| `benchmark billion-context#5531: repeated compaction keeps the snapshot bounded` | 2026-11-02 / 💬7 | 压缩泄露，上下文涨到 35 万 token | 连续 5 次压缩（上次 summary 回灌）每代 ≤ `HARD_CAP`，归档恰好有 5 个节 |
| `benchmark billion-context#5538: a stale estimate must not disable preflight compaction` | 2026-11-02 | preflight 只看未校准估算，1.86M payload 上从不触发 | provider 实报用量远高于文本估算时，仍判定超线并压缩 |
| `benchmark billion-context#5542: every degradation is observable in the log` | 2026-11-02 | 代际重置不可观测，执行尾巴被无声吞掉 | `capacity` / `over-cap` / `structure` / `stop:length` 四种降级各自在 `pi-compact.log` 留下可区分的 `result=fallback:<reason>` |
| `benchmark billion-context#5527: compaction is triggerable at a low ratio` | 2026-11-02 | compress 无法触发 | 低占用下 manual 仍能压缩；低 ratio 下自动按配置比例触发 |
| `benchmark pi-prefix-cache-compaction#2: the summary call uses the session model registry` | 2026-09-19 | 压缩走独立 HTTP 层，认证端点 401 | 摘要调用拿到的是会话的同一个模型对象，不带自建 `fetch`/`baseUrl`/`apiKey` |
| `benchmark pi-compaction-control#1: env overrides reach the archive path` | 2026-10-04 | 硬编码 `~/.pi/agent/settings.json`，忽略环境目录覆盖 | `PI_COMPACT_DIR` 决定归档路径，压缩后文件确实在那里 |

## 怎么加新的 benchmark

1. 找到一条**真实报告过**的失败：优先同生态的压缩插件（billion-context、pi-cached-compaction、pi-prefix-cache-compaction、pi-compaction-control、pi-context-threshold 等），其次主流 coding agent 的压缩相关 issue。
2. 判断它能不能落到我们某条代码路径上；落不上（例如纯 UI、纯计费、SQLite 性能）就跳过——**不要为了凑数写测不到代码的用例**。
3. 用例名固定 `benchmark <owner/repo>#<num>: <行为描述>`，注释里写来源日期、热度、原始问题一句话。
4. 断言只钉"可观测行为"，不钉实现细节（不比对日志全文、不依赖内部函数名）。
5. 如果断言跑不过：**先当 bug 查**，不要改产品代码迁就测试、也不要放松断言。确实是产品决策问题（例如"要不要给用户可见提示"）就先写成 `test.todo` 并在本文件记录。

## 已知未覆盖（记录在案，避免误以为已测）

- **摘要质量**：所有 benchmark 都只钉机制，没有一条能量化"压缩后模型还记得多少"。需要探针 eval（取真实会话、在压缩点后问只能靠被压掉内容回答的问题，比较 不压缩 / 快照 / 快照+恢复提示）。
- **压缩发生时的用户可见性**：目前只有 guard 暂停会 notify，正常压缩无提示——属于产品交互，等决策。
- **单轮内暴涨**：裁剪器只在 `turn_end` 生效，一轮内把上下文从 80% 推到 98% 的路径没有 benchmark（测试需要模拟"轮内无 turn_end"的时序，现有 fixture 表达不了）。
- **多模型/窗口切换**：切换模型后 `keepRecentTokens`/`reserve` 的模型级覆盖只读了源码，没有 benchmark。
## 本次 review 已补覆盖

- B1/B2：`claude-code#7502` 分为首次无归档指针与第二次真实落盘两个场景。
- B3：5531 每代硬上限与归档节数、2382 至少 30% serializer 节省、4106 enabled=true 正例均有强断言。
- B4：`summary.test.ts` 覆盖模型/结构/超限/abort/stop 失败不追加，以及写失败仍出无指针快照且不额外调用模型；`boundary.test.ts` 覆盖 no-reduction 不写归档。
- B5：`summary.test.ts` 覆盖最新 ≤20 恢复地址、`+N more`、摘要范围、后续撤回/替换、空列表措辞和 assembled 8k 预算。
- main 首条消息 ≤600 tokens、当前 Goal 规则与 tight-only user 头尾截断均有回归测试；不代表摘要质量已量化。
- C4：三个内部 API 测试与生成脚本共用宿主解析器；不再依赖硬编码安装路径。
