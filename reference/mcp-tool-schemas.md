# 麦当劳 MCP 工具参数表（实测导出）

> 本文件由 `node scripts/mcp-smoke.mjs --schemas` 从 **麦当劳 MCP Server 实际返回的
> `tools/list`** 导出，非抄录官方文档。
> 导出时间：2026-10-09 18:18（北京时间）
> 服务端：`mcd-mcp v1.0.0`，协议版本 `2025-06-18`，端点 `https://mcp.mcd.cn`
> **工具总数：35**

## 为什么单独维护这份表

官方仓库 README 的「工具列表」章节列了 30 个工具，且**不含参数定义**。
实测服务端返回 35 个，多出 `query-promotions`、`query-survey-coupon` 等；
若干工具的参数名也与直觉不符（例如 `query-nearby-stores` **不接受地址字符串**，
而是用 `beType` + `searchType` + `city`）。

照文档猜参数会直接踩坑 —— 本项目最初按 `address` 传参，服务端返回
`{"success":false,"code":400,"message":"缺少参数"}`。因此以实测为准。

## 两个贯穿全局的枚举

几乎所有点餐类工具都要求 `beType` 与 `orderType` 成对出现：

| 参数 | 取值 | 含义 |
|---|---|---|
| `beType` | `1` | 到店取餐 |
| | `2` | 麦乐送到家 |
| | `5` | **得来速车道取餐（DT）** |
| | `6` | 企业团餐 |
| `orderType` | `1` | 到店（含到店自取 + 得来速车道取餐） |
| | `2` | 外送（含麦乐送 + 企业团餐） |

> `beType=5`（得来速）与 `beType=1`（到店自取）共用 `orderType=1`。

**`beCode` 的坑**：`beCode` 是可选参数，但官方在 `query-meal-detail` /
`query-meal-assistance` 的描述中明确警告 ——
`orderType=1` 场景下 `beCode` 是无效参数，**传了会报错**。

## 无需入参的工具

| 工具 | 用途 |
|---|---|
| `now-time-info` | 服务器时间信息 |
| `list-nutrition-foods` | 餐品营养信息列表 |
| `query-my-account` | 我的积分账户 |
| `query-my-coupons` * | 我的优惠券（`page` / `pageSize` 可选，默认 200 条/页，最多 5 页） |
| `available-coupons` | 麦麦省可领券列表 |
| `query-lottery-info` | 积分抽奖活动信息 |
| `draw-lottery` | 执行一次积分抽奖 |
| `auto-bind-coupons` | 一键领取全部可领券（**有副作用**） |
| `order-list` | 近期到店/外送历史订单 |
| `delivery-query-addresses` | 我的配送地址列表 |

## 核心点餐链路

### `query-nearby-stores`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `beType` | integer | ✅ | `1` 到店自提；`5` 得来速车道取餐 |
| `searchType` | integer | ✅ | `2` 按位置搜索；`1` 搜索收藏餐厅 |
| `city` | string | — | 城市名 |
| `keyword` | string | — | 关键词 |

> ⚠ 不接受 `address` 字符串参数。按位置搜索需走 `searchType=2`。
> 返回中的 `storeCode` 与 `beCode` 是后续所有工具的门店入参；`reservation` 表示是否支持预约。

### `query-meals`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `storeCode` | string | ✅ | 门店编码，不能为空 |
| `beType` | integer | ✅ | 见上表 |
| `orderType` | integer | ✅ | 见上表 |
| `beCode` | string | — | 与 `storeCode` 配对 |
| `reservationDate` | string | — | 预约场景必传，格式 `yyyy-MM-dd HH:mm` |

### `query-meal-detail`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `code` | string | ✅ | 餐品唯一编码 |
| `storeCode` | string | ✅ | 门店编码 |
| `beType` | integer | ✅ | 见上表 |
| `orderType` | integer | ✅ | 见上表 |
| `beCode` | string | — | ⚠ `orderType=1` 时不要传 |
| `reservationDate` | string | — | 预约场景必传 |

### `query-store-coupons`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `storeCode` | string | ✅ | **必须全部由数字组成** |
| `beType` | integer | ✅ | 见上表 |
| `orderType` | integer | ✅ | 见上表 |
| `beCode` | string | — | 与 `storeCode` 配对 |
| `reservationDate` | string | — | 预约场景必传 |

### `calculate-price`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `storeCode` | string | ✅ | 门店编码 |
| `beType` | integer | ✅ | 见上表 |
| `orderType` | integer | ✅ | 见上表 |
| `items` | array | — | 待计算的商品列表 |
| `beCode` / `gmServiceCode` | string | — | `gmServiceCode` 为团餐助餐服务码 |
| `needTableware` | boolean | — | 是否需要餐具 |
| `reservationDate` | string | — | 预约场景必传 |
| `withOrder` | object | — | 随单购商品 |

> 返回的 `takeWayCode` 是 `create-order` 在 `orderType=1` 下的**必传**参数。

### `create-order`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `storeCode` | string | ✅ | 门店编码 |
| `beType` | integer | ✅ | 见上表 |
| `orderType` | integer | ✅ | 见上表 |
| `takeWayCode` | string | — | **`orderType=1` 时必传**（值来自 `calculate-price`）；`orderType=2` 不传 |
| `addressId` | string | — | 外送 / 团餐的配送地址 id |
| `gmServiceCode` | string | — | `beType=6`（企业团餐）时必传，来自 `query-meal-assistance` |
| `items` | array | — | 商品列表 |
| `reservationDate` | string | — | 预约场景必传，格式 `yyyy-MM-dd HH:mm` |
| `needTableware` | boolean | — | 是否需要餐具 |
| `remark` | string | — | 订单备注，≤50 字，仅 `orderType=2` 引导填写 |
| `withOrder` | object | — | 随单购商品 |

### `query-order` / `cancel-order`

| 工具 | 参数 |
|---|---|
| `query-order` | `orderId` ✅ |
| `cancel-order` | `orderId` ✅、`cancelReasonCode` ✅（默认 `1`） |

## 外送链路

| 工具 | 参数 |
|---|---|
| `delivery-query-stores` | `addressId` ✅（来自 `delivery-query-addresses`）、`beType` ✅（`2` 麦乐送 / `6` 团餐） |
| `delivery-create-address` | `address` ✅、`addressDetail` ✅、`city` ✅、`contactName` ✅、`phone` ✅（11 位纯数字）、`gender` — |

## 企业团餐

| 工具 | 参数 |
|---|---|
| `query-meal-assistance` | `storeCode` ✅、`beType` —（固定 `6`）、`orderType` —、`reservationDate` —；⚠ `orderType=1` 时不要传 `beCode` |
| `query-promotions` | `storeCode` ✅、`beType` ✅（固定 `6`）、`orderType` ✅（固定 `2`）、`beCode` —（团餐场景必传）、`reservationDate` — |

## 主题活动（严格下钻，不可跳步）

| 工具 | 参数 |
|---|---|
| `query-party-city` | `spuId` ✅ |
| `query-party-store` | `code` ✅（城市 code）、`latitude` —、`longitude` —、`spuId` — |
| `query-party-store-date` | `storeCode` ✅、`spuId` ✅ |
| `query-party-store-session` | `storeCode` ✅、`dateStr` ✅、`spuId` ✅ |
| `party-order-create` | `partyType` ✅（`1` 包场 / `2` 拼团）、`code`、`storeCode`、`dateStr`、`id`、`skuId`、`spuId`、`count`、`leftNum`、`timeStart`、`timeEnd`、`partyTimeInfo` |

## 积分商城

| 工具 | 参数 |
|---|---|
| `mall-points-products` | `catRuleIds` —（类目筛选，逗号分隔） |
| `mall-product-detail` | `spuId` ✅ |
| `mall-create-order` | `skuId` ✅、`spuCategory` ✅（`1` 虚拟商品 / `2` 实体物品）、`addressId`（`spuCategory=2` 时必填）、`count` |
| `mall-order-list` | `lastId` —、`size` —（默认 10，上限 10） |
| `mall-order-detail` | `orderId` ✅ |

## 其他

| 工具 | 参数 |
|---|---|
| `query-my-prizes` | `pageNum` —、`pageSize` —（默认 10，上限 50） |
| `campaign-calendar` | `specifiedDate` —（`yyyy-MM-dd`，以该日为锚点返回前后最近的三天） |
| `query-survey-coupon` | `orderId` ✅ |
| `order-list` | 无入参 |

## 错误码

| code | 含义 | 处理 |
|---|---|---|
| 400 | 缺少参数 / 参数非法 | 对照本表检查 `beType` / `orderType` / `storeCode` 组合 |
| 401 | Token 无效或过期 | 重新申请 Token |
| 429 | 超过 600 次/分钟 | 指数退避重试 |

复现本表：

```bash
MCD_MCP_TOKEN=xxx node scripts/mcp-smoke.mjs --schemas
```
