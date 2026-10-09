# WorkBuddy 开发对话上下文

本文件记录「麦麦通勤点单官」在 **腾讯 WorkBuddy** 中完成开发的过程与关键决策，
用于核验本项目符合麦当劳程序员创意开发大赛的 WorkBuddy 联动活动条件。

---

## 一、开发环境

| 项 | 值 |
|---|---|
| 开发工具 | 腾讯 WorkBuddy |
| 会话启动 | 2026-10-09 17:46（北京时间） |
| 工作目录 | `mcd-commute-butler/` |
| 运行时 | Node.js 22.22.2 |
| 外部依赖 | 无（两个脚本均为零依赖纯计算模块） |

## 二、开发过程

### 阶段 1 · 赛事规则研读与选题

向 WorkBuddy 提供了活动主仓库与 MCP Server 仓库地址，由 WorkBuddy 完成情报提取：
读取 `README.md`、`activityGuidelines.md`、`CONTEST_DECLARATION.md`、`RANKING.md`
以及麦当劳 MCP Server 的 30 个 Tool 清单。

**关键产出**：识别出「排名完全由 GitHub Star 数决定」这一机制，
并对现有 11 个上榜项目做了赛道扫描，发现营养类占 4 个、省钱/积分/团餐/早餐各占 1–2 个，
**「时间维度」是唯一成规模且无人占据的切口**，据此确定选题为通勤点单场景。

同时识别出三处规则陷阱：文件清单在 README 页与规则正文中不一致（后者多要求
`mcp-config.example.json`）、`CONTEST_DECLARATION.md` 内容不可改动、
以及禁止将麦当劳产品与其他品牌对比。

### 阶段 2 · 架构设计

与 WorkBuddy 确定了**三层结构**：

```
事实层   → 麦当劳 MCP 提供门店/菜单/券/价格/订单
决策层   → 本地纯函数脚本完成时段判定、组合枚举、券择优、四维评分
副作用层 → 下单必须经过用户显式确认，不存在静默路径
```

分层的直接好处：决策逻辑可离线运行（`--demo`），且决策层不持有任何凭据，
从架构上就无法绕过用户确认去下单。

### 阶段 3 · 编码

由 WorkBuddy 生成并迭代 `scripts/plan-commute-order.mjs` 与
`scripts/coupon-deadline-rescue.mjs`，以及 `SKILL.md` 和全部参考文档。

### 阶段 4 · 缺陷发现与修正

开发过程中 WorkBuddy 在本地运行演示场景，发现并修正了两个真实缺陷：

**缺陷一：候选方案去重失效。**
原实现用「对象拷贝 + `Array.includes`」判断方案是否已被选中，
由于拷贝后对象身份改变，`includes` 恒为假，导致三个策略标签指向同一个方案。
修正方式：改为用 `Set` 保存原始对象引用做去重。

**缺陷二：券到期紧迫度权重过低，差异点体现不出来。**
原实现把券的到期紧迫度处理成一个最大值 8 分的加性奖励，
在 0–100 的评分体系里几乎不起作用 ——
即使「1.7 天后到期的满 20 减 12」能显著降低实付金额，方案也排不进前三。

修正方式：把紧迫度**升格为独立的第四评分轴**（权重 0.25），
并采用绝对尺度 `1 − 剩余天数 / 14` 而非集合内相对位置，
理由是「把即将过期的券用掉本身就是收益」，不应因"在这批候选里不算最便宜"而被忽略。

### 阶段 5 · 外送场景补全

在编写示例时发现引擎原本没有处理配送费，导致「暴雨改外送」场景只能靠文字描述、跑不出真实结果。
据此补充了 `deliveryFee` 与 `deliveryEtaMinutes` 两个输入字段，
使配送费进入价格轴、送达耗时替代取餐耗时，该场景从"讲故事"变为可运行。

### 阶段 6 · 竞争情报驱动的定位调整

报名仓库上线后，WorkBuddy 拉取了活动仓库的全部报名 Issue（当时 65 个）并做赛道聚类，
识别出三类高度重叠的先行项目：纯时段类、纯省钱类、券资产管理类。

据此把项目定位从泛「时间 × 位置」收敛为**「供餐时段 × 券有效期，双时钟对齐」**，
在 README 中新增「为什么是两个时钟」与「与同类方案的差异」两节，明确边界。

同时确认了一个关键事实：**65 个报名项目绝大多数为 0 Star，榜首仅 13 Star**。
结论是新颖度不是瓶颈、触达才是，因此把资源投向执行完成度（测试 + 视觉 + 可验证性），
而非重新选题。

### 阶段 7 · 补齐工程完备度

1. **单元测试**：新增 `tests/plan-commute-order.test.mjs`，从 43 个扩到 53 个，
   补上渠道决策的判定优先级与溢价恒等式。
2. **渠道决策**：新增 `adviseChannel()` 与 `--advise-channel`，
   对比自取 / 外送的实付、耗时与溢价。
   实现时刻意**不**假装"外送可能更便宜"——同菜单同券下外送必然贵一个配送费，
   所以输出的是取舍的量化，而不是一个伪结论。
3. **连接自检**：新增 `scripts/mcp-smoke.mjs`，按 MCP Streamable HTTP 协议
   完整走一遍 `initialize → notifications/initialized → tools/list → tools/call`，
   把「确实接通了麦当劳 MCP」变成一条可复现的命令。
4. **架构图**：新增 `assets/architecture.svg`，呈现「事实层 / 决策层 / 副作用层」三层分离。

## 三、WorkBuddy 在本项目中的具体作用

| 环节 | WorkBuddy 承担的工作 |
|---|---|
| 情报提取 | 抓取并结构化活动规则、MCP Tool 清单、竞品赛道分布 |
| 规则风控 | 识别文件清单不一致、内容红线等参赛陷阱 |
| 架构设计 | 提出「事实 / 决策 / 副作用」三层分离结构 |
| 代码生成 | 生成两个零依赖计算脚本与全部文档 |
| **本地验证** | **实际运行脚本、发现并修正上述两个逻辑缺陷** |
| 文档撰写 | SKILL.md、README、MCP_INTEGRATION 及三个示例 |

其中「本地验证」环节是可核验的关键：两个缺陷都由 WorkBuddy 实际执行脚本后暴露，
而非事后人工审阅发现。相应的执行结果已固化在
`examples/demo-1-morning-commute.md`、`demo-2-rainy-day-delivery.md`、
`demo-3-boundary.md` 三份文档中。

## 四、可复现的验证步骤

任何人可用以下命令复现全部结果（**前三组无需 MCP Token**）：

```bash
# 单元测试：53 个
npm test

# 三个场景演示
node scripts/plan-commute-order.mjs --demo
node scripts/plan-commute-order.mjs --input examples/payload-boundary.json
node scripts/plan-commute-order.mjs --input examples/payload-delivery.json

# 券到期救援
node scripts/coupon-deadline-rescue.mjs --demo

# 渠道决策（自取 vs 外送）
node scripts/plan-commute-order.mjs --input examples/payload-delivery.json --advise-channel

# MCP 连通性自检（需 Token）
MCD_MCP_TOKEN=xxx node scripts/mcp-smoke.mjs
```
