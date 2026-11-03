# 留存探针：压缩后还剩多少事实（retention eval）

> 回答 benchmark 清单里那条唯一没量化的维度（`docs/benchmarks.md` "已知未覆盖 → 摘要质量"，`docs/2026-11-02-work-log.md` C1）：压缩之后，被压掉的对话不再进入模型上下文，模型还能答对多少？当前的三件产物（快照摘要 / `Older details:` 指针 / 可寻址恢复清单）各值多少？
>
> 脚本：`scripts/eval-retention.ts`（bun，只读会话文件与模型元数据）。

## 一、量的是什么

对真实会话里的一个压缩点，把"被压掉的那段"当作事实来源，生成 N 个只能靠它回答的短问答题，然后只给模型看三种上下文，同一套问题重问一遍：

| 条件 | 上下文 | 含义 |
|---|---|---|
| **RAW** | 被压掉的消息原文（按 `convertToLlm` + `context_edit` 投影后的形态渲染） | 上界：压缩前模型看到的 |
| **SNAP** | 压缩提交的快照摘要 + `Older details:` 指针 + `restoreBlock` + `Pruned tool results (entryId ...)` 清单 | 下界：压缩后模型唯一能直接看到的 |
| **SNAP+RESTORE** | SNAP + 清单里每个被裁工具结果的前 8192 codepoints 原文（一次 `read_tool_result` 能取回的上限） | 现实最好情况：模型照指针去读回原文 |

判分用独立 judge 调用（只给问题、参考答案、候选答案，不给条件名，条件提问顺序按问题哈希打散）；同时算一个不看 judge 的精确子串命中率作交叉校验。

## 二、机制：信息在哪一步丢（代码依据）

1. **摘要输入先被裁**：`src/summary.ts:SUMMARY_PROFILE`（第 69 行附近）把工具结果裁成"头 300 + 尾 100 字"，`toolCall` 参数裁到 300/命令 500 字，assistant 正文裁到 4000 字（`cut`/`headTail`）。**本测之后已改**：工具结果变成"头 + 尾 + 中段按信息密度挑选的行"（`toolResultSlice`/`denseLines`），中段预算 full 300 / tight 120 字。
2. **快照有硬上限**：`HARD_CAP = 8000` token（第 8 行）。**本测之后已改**：退让顺序变成"溢出量不超过清单就先丢清单（不调模型）→ 否则先浓缩一次 → 仍超才丢 `Older details:` 指针 → 最后回退"，恢复清单有固定预留预算（`LIST_BUDGET = 200` token）。
3. **压缩后只有快照 + kept 消息**：`src/boundary.ts:prepareBoundaryCompaction` 用 `findCutPoint` 定出 `firstKeptEntryId`（第 21–22 行），此前的一切从模型上下文消失，只剩摘要。
4. **恢复清单只给地址不给内容**：`prunedRestoreList`（第 195 行附近）**本测之后已改**：最多 8 条、每条 `entryId toolName originalChars: 关键片段`（≤120 字），整份清单 ≤200 token；取回仍要调 `read_tool_result`（`extensions/tool-result-pruner.ts` 第 39 行），单次上限 8192 codepoints（第 10 行 `KEEP_LIMIT`）。

## 三、怎么跑

```bash
# 计划（不调模型）：看会选哪些会话、discarded/snapshot token 与可恢复数量
bun scripts/eval-retention.ts --plan --sessions 5

# 实测（默认：~/.pi/agent/sessions 下所有含压缩的会话，选 5 个；每题三种条件各问一次）
bun scripts/eval-retention.ts --questions 6 --sessions 5 --model deepseek/deepseek-flash

# 指定会话 / 换缓存位置
bun scripts/eval-retention.ts <session.jsonl ...> --out /tmp/retention.json

# 无网络自检（区间切分、裁剪识别、快照尾部、问答校验、类别、精确子串）
bun scripts/eval-retention.ts --selftest
```

要点：

- **只读**：读 `~/.pi/agent/sessions/**/*.jsonl`、`models.json`（只取模型 id/窗口，不打印凭据）、`compaction-archive/` 是否存在；唯一的写入是 `--out` 缓存（默认 `~/.pi/agent/.eval-retention/cache.json`，在仓库之外）。
- **可续跑**：缓存按 `sessionId@compactionEntryId@model` + 每题三条件的答案/判分存盘，每完成一对就落盘。重跑只补缺的部分，已完成的答案不会再计费。
- **会话选择**：优先"提交的摘要里带 `Pruned tool results (entryId`（新产物真的落盘了）"，其次 discarded token 最大，再次可恢复条数最多。每个会话取 discarded 区间最大的那次压缩。
- **源引校验**：每题的 `sourceQuote` 必须是被压文本的字面子串，否则整题丢弃——防止模型用会话外的知识出题。
- **限速**：内置每分钟 token 预算 + 收到 429 时按 `retry after` 退避，`--concurrency` 默认 2。

## 四、本机实测（2026-11-03，4 个会话 × 6 题 = 24 题）

会话（只报 id 前缀、cwd、压缩次数）：

| session | cwd | 压缩次数 | 快照来源 | discarded token | snapshot token | 压缩比 | 列表可恢复/区间内被裁 |
|---|---|---|---|---|---|---|---|
| 01a1817d | /Users/jyxc-dz-0101310 | 8 | pi 原生 | 104,827 | 4,202 | 24.9x | 12 / 12 |
| 01a18715 | /Users/jyxc-dz-0101310 | 1 | 本插件快照 | 93,852 | 3,462 | 27.1x | 20 / 20 |
| 01a18af1 | /Users/jyxc-dz-0101310 | 4 | 本插件快照 | 88,982 | 3,581 | 24.8x | 15 / 15 |
| 01a18ac4 | /Users/jyxc-dz-0101310 | 1 | 本插件快照 | 85,342 | 4,514 | 18.9x | 19 / 19 |

模型：`deepseek/deepseek-flash`（每题生成、作答、判分同模型；`reasoning=low`）。

准确率（括号内为含 partial 的部分分；n=24）：

| 条件 | 正确率 | 判分 |
|---|---|---|
| RAW | **100% (100%)** | 上界成立：题库确实只能靠被压文本回答 |
| SNAP | **79% (79%)** | 平均丢掉 21% 的事实 |
| SNAP+RESTORE | **83% (83%)** | 跟进指针再找回约 4 个百分点 |

分会话：

| session | RAW | SNAP | SNAP+RESTORE |
|---|---|---|---|
| 01a1817d | 100% | 83% | 83% |
| 01a18715 | 100% | 83% | 83% |
| 01a18af1 | 100% | 100% | 100% |
| 01a18ac4 | 100% | 50% | 67% |

精确子串交叉校验（不看 judge）：RAW 100% / SNAP 67% / SNAP+RESTORE 79%。judge 比严格子串宽松约 12 个百分点（换行、多一句话不算错），方向一致，没有反向。

失败按关键词归类（incorrect，括号内为 partial）：

| 条件 | path | command | decision | number | other |
|---|---|---|---|---|---|
| RAW | 0 (0) | 0 (0) | 0 (0) | 0 (0) | 0 (0) |
| SNAP | 1 (0) | 0 (0) | 0 (0) | 3 (0) | 1 (0) |
| SNAP+RESTORE | 1 (0) | 0 (0) | 0 (0) | 3 (0) | 0 (0) |

失败集中在**数字**（3 个）与路径（1 个）；`other` 的 1 个在恢复原文后消失，说明它落在被裁工具结果的中段。

代价与耗时：72 次作答+判分调用，607,475 输入 token / 8,093 输出 token，**$0.21**，调用耗时累计 146s、整轮墙钟 **308s**（缓存已满，重跑仅复述报表）。

## 五、从数据得到的三个最高价值修法

> 三条均已按本节的形状实现（信息密度切片、清单固定预留预算 + 带关键片段、退让顺序改为先浓缩后丢清单）。**但实测效果是中性（neutral）**：同模型同题库的旧代码 vs 新代码 A/B 为 60% vs 63%，差异在置信区间内（见 §八）。§四的 79%/83% 是**改之前**的产物形态，且快照由 gpt-6.1/opus 写；两轮数字不可直接相减。

1. **让摘要输入保留"中间那段数字"**：全部 5 个失败里 3 个是数字/结果片段，而 `SUMMARY_PROFILE` 对工具结果只留头 300 + 尾 100。把 toolResult 改成"头 300 + 尾 100 + 命中数字/路径的片段"（或把 bash 输出改成头尾 + 每行首尾），比加大快照预算更省 token。
2. **恢复清单要能被找到，而且先于摘要预算被牺牲**：现在是 `HARD_CAP` 一超就先扔掉恢复清单（第 240 行），而数据表明它是唯一能把 50%→67% 拉回来的东西。改成"清单永远占固定小额预算（例如 ≤800 token，只列最新 8 条），先压缩正文再压清单"。
3. **恢复要一次能取回**：`read_tool_result` 单次上限 8192 codepoints，长结果要多次分页；SNAP+RESTORE 只按一次取回算，仍丢事实。清单里带上每个结果的"最值得读的 offset"（如错误发生位置）或直接内联 200 字关键片段，可把"读回"从多跳变成一跳。

## 六、这个 eval 不测什么

- **多步推理与延迟回忆**：只问单跳、可校验的事实；不测"三天后还能不能接着干"。压缩导致的工作连续性损失（重复劳动、误判状态）测不出来。
- **成本不是测量对象**：只统计了本探针自身花掉的 token/$，不是压缩本身的成本模型（那部分是 `scripts/eval-serialize.ts` + `docs/2026-11-02-work-log.md` §七）。
- **样本量小**：24 题、4 个会话、单模型单轮。差异 <10 个百分点（例如 SNAP 79% vs SNAP+RESTORE 83%）在置信区间内，不应据此宣布恢复清单"有效"——只能说方向为正、单会话里最多值 17 个百分点。
- **题库偏科**：生成器只出了 path / number / other 三类，command 与 decision 两类在本次为 0，相关结论缺失。
- **SNAP 的尾部是构造的**：本机 324 次压缩里没有一条提交摘要包含 `Pruned tool results (entryId`（B5 之后还没有真机压缩），所以 SNAP 的 `Older details:`/`restoreBlock`/恢复清单是按当前 `src/summary.ts` 的逻辑对真实条目重算出来的，不是会话里已提交的字节。它衡量的是"当前产物形态值多少"，不是"历史会话里恰好写了什么"。
- **恢复原文按 8192 codepoints 截断**：真实模型可以用 offset 继续读，所以 SNAP+RESTORE 是保守估计。

## 七、怎么复现这张表

```bash
bun scripts/eval-retention.ts --selftest
bun scripts/eval-retention.ts --plan --sessions 4        # 确认选中的会话与 token 量级
bun scripts/eval-retention.ts --questions 6 --sessions 4 --model deepseek/deepseek-flash
```

缓存命中时不重复计费；要重测请换 `--out`（缓存按会话+压缩点+模型分键，换模型不会混用旧答案）。

## 八、同模型代码 A/B（旧代码 vs 新代码）

目的：把"改代码有没有用"和"换模型有没有用"分开。`12a74da` 改了摘要输入的切片（工具结果保留中段信息密集行）和恢复清单（带关键片段 + 固定预留预算），§四的数据是在改之前测的，不能证明改动有效。

**方法**：同一批会话、同一批已缓存的题（不再重新出题），只换 `src/summary.ts` 所在的代码树：

```bash
npm run eval:ab -- --baseline-code e178a65 --snapshot-code 12a74da \
  --questions 6 --sessions 5 --model deepseek/deepseek-flash
```

脚本为每个 ref 建临时 `git worktree`（`git worktree add --detach <tmp> <ref>`），import 那棵树的 `src/summary.ts`，用**同一个模型、同一份 `preparationFor()` 输入**各调一次 `summarize()`，然后用同一套缓存题分别作答判分（条件名 `snap:base` / `snap:head`），最后移除 worktree。缓存键带两个 ref，不同代码的结果不会混。省略 `--snapshot-code` 时 `snap:head` 用当前工作树。

**本轮记录（2026-11-03，deepseek/deepseek-flash，未重跑）**：5 个会话、每侧 n=30、同一套缓存题；快照作者也是 deepseek-flash。

| 条件 | 代码 | 正确率 | 95% Wilson 区间 |
|---|---|---|---|
| SNAP_OLDCODE | `e178a65` | 60% (18/30) | 42–75% |
| SNAP_NEWCODE | `12a74da` | 63% (19/30) | 46–78% |

按关键词类别（old → new）：

| 类别 | 旧代码 | 新代码 | n |
|---|---|---|---|
| number | 67% | 75% | 12 |
| path | 78% | 78% | 9 |
| other | 38% | 38% | 8 |
| command | 0% | 0% | 1 |

快照长度（tokens，5 个会话）：旧 2046 / 3179 / 2431 / 4512 / 2966 → 新 2148 / 3204 / 2589 / 4000 / 2929。整轮花费 **$0.1426**。

**结论**：

1. **在这份样本上，序列化 + 恢复清单的改动是中性（neutral）的**：+3 个百分点（1 道题），两个区间几乎完全重叠，不能宣称改进。唯一的方向性信号是 number 类 67%→75%（n=12，1 道题），而快照 token 并没变短（多数会话反而更长）——即"没有用更多 token 换到更多留存"。
2. **影响大得多的是写快照的模型**：§四那轮 SNAP 79% 的快照由 gpt-6.1/opus 写，这一轮由 deepseek-flash 写，降到 60%（79% → 60%，两轮题库不同、n 也不同，只看量级不看差值）。所以想提高留存，先换/升快照作者模型，再谈序列化细节。
3. **区间警告**：n=30 时 95% Wilson 区间宽度约 ±16 个百分点，1–3 道题的差异完全不可区分。要判定改动的真实效果，至少需要每侧上百题，或者在同一模型上做多次重复的配对比较。

**这个 A/B 仍然不覆盖**：跨会话的真实续跑（多跳回忆、三天后接着干）、长工具结果的完整读回、以及快照作者模型与代码改动的交互。
