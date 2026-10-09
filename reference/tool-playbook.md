# MCP Tool 调用手册

本文件给出各场景下麦当劳 MCP Tool 的调用序列、参数依赖与编排顺序。
工具清单以麦当劳 MCP Server 官方文档为准。

## 场景一 · 到店取餐（通勤主场景）

```
now-time-info                       → 当前时间
   ↓
query-nearby-stores(地址)            → 目的地附近门店列表
   ↓ 用户选定门店
┌──────────────── 以下四路可并行 ────────────────┐
query-meals(门店)         → 实时可售菜单
query-store-coupons(门店) → 该门店可用券
query-my-coupons          → 我的券（是否值得先领再用）
available-coupons         → 可领取的麦麦省券
└───────────────────────────────────────────────┘
   ↓
query-meal-detail(餐品编码)   → 仅当需要看套餐组成 / 可替换项时
   ↓
calculate-price(商品列表 + 券) → 金额校验（本地计算的交叉验证）
   ↓
【用户确认闸门】
   ↓
create-order(门店 + 就餐方式 + 商品列表) → 订单号 + 支付链接
   ↓
query-order(订单号)          → 确认状态、取餐柜二维码
```

**参数依赖**：`query-meals` 依赖 `query-nearby-stores` 返回的门店编码；
`create-order` 依赖 `query-meal-detail` 或 `query-meals` 返回的餐品编码。
因此这几步**必须串行**，不能并行发出。

**可并行**：菜单、门店券、我的券三者互不依赖，可同时发出以降低总耗时。

## 场景二 · 外送（暴雨 / 高温 / 时间充裕时）

```
delivery-query-addresses          → 已有配送地址
   ↓ 若无地址
delivery-create-address           → 新增地址
   ↓
delivery-query-stores(地址)        → 可配送门店
   ↓
query-meals → calculate-price → 【确认】 → create-order
```

外送场景的评分应把「配送费」并入价格轴，并把「预计送达时间」替代「取餐耗时」轴。

## 场景三 · 券与积分到期救援

```
query-my-coupons      → 我的券及到期时间
query-my-account      → 积分账户（可用 / 即将过期）
   ↓
available-coupons     → 可补充领取的券
   ↓
auto-bind-coupons     → 一键领取（注意：会改变账户状态，需先告知用户）
   ↓
（交给 scripts/coupon-deadline-rescue.mjs 分档排序）
```

`auto-bind-coupons` 会**实际领取**优惠券并写入用户账户，属于有副作用的操作，
执行前应告知用户「将自动领取当前所有可领券」，得到同意后再调用。

## 场景四 · 企业团餐

```
query-nearby-stores → query-meal-assistance(门店) → 确认该门店支持的助餐服务
   ↓
query-meals → calculate-price → create-order
```

团餐关键在于「助餐服务」是否可用，必须先查 `query-meal-assistance`，否则可能下单失败。

## 场景五 · 主题活动 / 派对预约

```
query-party-city          → 可参与城市
   ↓
query-party-store(城市)     → 可参与门店
   ↓
query-partystore-date(门店) → 可预约日期
   ↓
query-partystore-session(门店, 日期) → 可预约场次
   ↓
party-order-create(城市 + 门店 + 日期 + 场次)
```

这四步是严格的下钻依赖关系，**不可跳步**，也不能并行。

## 错误处理速查

| 错误码 | 含义 | 处理 |
|---|---|---|
| 401 | Token 无效 / 过期 / 未提供 | 停止调用，引导用户检查 `Authorization` 头与 Token 配置 |
| 429 | 超过 600 次/分钟限流 | 指数退避重试（1s → 2s → 4s），并降低并发 |

## 调用频次控制建议

- 单次完整点单流程的合理调用量约为 **6–10 次**，不应显著超出。
- 多门店比价时不要对每家门店都跑全量菜单，先按距离筛出前 3 家再取菜单。
- `list-nutrition-foods` 属于全量数据接口，仅在用户明确提出营养需求时调用。
