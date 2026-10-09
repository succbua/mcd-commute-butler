#!/usr/bin/env node
/**
 * 麦麦通勤点单官 · 通勤方案计算引擎
 * ------------------------------------------------------------------
 * 纯计算模块：不发起任何网络请求，也不持有任何凭据。
 * 输入 = 用户通勤参数 + 麦当劳 MCP 返回的原始数据（门店 / 菜单 / 券）
 * 输出 = 按时段可行性过滤、按价格·热量·取餐耗时三维加权排序后的候选方案
 *
 * 这是本 Skill 的「时间引擎」：把「现在几点 / 到达几点」翻译成
 * 「到达时还能买到什么、还能不能赶在时段切换前下单」。
 *
 * 用法：
 *   node scripts/plan-commute-order.mjs --demo                    # 内置早八通勤场景
 *   node scripts/plan-commute-order.mjs --input p.json            # 读取自定义输入
 *   node scripts/plan-commute-order.mjs --demo --json             # 输出机器可读 JSON
 *   node scripts/plan-commute-order.mjs --input p.json --advise-channel  # 自取 vs 外送决策
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const MS_PER_MINUTE = 60000;
const MS_PER_DAY = 86400000;
const BEIJING_OFFSET_MINUTES = 480;

/**
 * 供应时段定义（北京时间）—— **兜底估算表**。
 *
 * ⚠ 这是估算，不是事实。实测麦当劳 MCP 的 `query-nearby-stores` 会在
 * `reservationTimeOptions[].reservationOptionText` 中返回**门店级的真实可预约时段**，
 * 同一时刻不同门店的早餐开始时间并不相同（实测有 06:44、07:14 等）。
 *
 * 因此优先使用 `resolveStoreWindows()` 从 MCP 返回结果解析出的真实时段；
 * 本表仅在拿不到门店时段数据时兜底。解析出的时段会覆盖本表。
 */
export const MEAL_WINDOWS = [
  { key: 'breakfast', label: '早餐', start: '05:00', end: '10:30' },
  { key: 'lunch', label: '正餐', start: '10:30', end: '14:00' },
  { key: 'afternoon', label: '下午茶', start: '14:00', end: '17:00' },
  { key: 'dinner', label: '晚餐', start: '17:00', end: '22:00' },
  { key: 'late-night', label: '夜宵', start: '22:00', end: '05:00' },
];

/** 门店实际时段名 → 本项目的时段 key */
const WINDOW_LABEL_TO_KEY = {
  早餐: 'breakfast',
  午餐: 'lunch',
  正餐: 'lunch',
  下午茶: 'afternoon',
  晚餐: 'dinner',
  夜市: 'dinner',
  宵夜: 'late-night',
  夜宵: 'late-night',
  breakfast: 'breakfast',
  lunch: 'lunch',
  afternoon: 'afternoon',
  dinner: 'dinner',
};

/**
 * 解析门店返回的可预约时段文本。
 *
 * 输入示例：
 *   "早餐(07:14至10:15)，午餐(10:44至14:15)，下午茶(14:44至16:45)，夜市(17:14至21:45)"
 * 输出示例：
 *   [{ key:'breakfast', label:'早餐', start:'07:14', end:'10:15' }, ...]
 */
export function parseReservationOptions(text) {
  if (!text) return [];
  const out = [];
  const re = /([^（()），,]+)[（(](\d{1,2}:\d{2})\s*至\s*(\d{1,2}:\d{2})[)）]/g;
  let m;
  while ((m = re.exec(String(text))) !== null) {
    const label = m[1].trim();
    out.push({
      key: WINDOW_LABEL_TO_KEY[label] || label,
      label,
      start: m[2],
      end: m[3],
      source: 'store',
    });
  }
  return out;
}

/**
 * 从 `query-nearby-stores` 返回的门店对象中取出指定日期的真实可售时段。
 * 找不到对应日期时回退到 `today` 标记的条目，再回退到第一条。
 * 拿不到任何时段数据时返回 null（由调用方回退到 MEAL_WINDOWS）。
 */
export function resolveStoreWindows(store, dateStr) {
  const options = store?.reservationTimeOptions;
  if (!Array.isArray(options) || !options.length) return null;
  const hit =
    (dateStr && options.find((o) => o.date === dateStr)) ||
    options.find((o) => o.today) ||
    options[0];
  const parsed = parseReservationOptions(hit?.reservationOptionText);
  return parsed.length ? parsed : null;
}

/** 券到期紧迫度分档（剩余天数） */
export const URGENCY_TIERS = [
  { tier: 'critical', maxDays: 1, label: '今天到期', bonus: 8 },
  { tier: 'urgent', maxDays: 3, label: '3 天内到期', bonus: 5 },
  { tier: 'soon', maxDays: 7, label: '本周内到期', bonus: 2 },
  { tier: 'normal', maxDays: Infinity, label: '有效期充裕', bonus: 0 },
];

/** 默认评分权重：通勤场景下「价格」与「取餐耗时」优先，「券到期紧迫度」单列一轴 */
export const DEFAULT_WEIGHTS = { price: 0.35, calories: 0.10, wait: 0.30, expiry: 0.25 };

/** 券到期紧迫度的评分视界：剩余天数超过该值即视为「不紧迫」 */
export const EXPIRY_HORIZON_DAYS = 14;

// ---------------------------------------------------------------- 时间工具

function hmToMinutes(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim());
  if (!m) throw new Error(`无法解析时间点: ${text}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * 解析 ISO 8601 时间为 epoch 毫秒。
 * 显式解析时区偏移，不依赖运行机器的本地时区，保证结果可复现。
 */
export function toEpoch(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?$/.exec(
    String(iso).trim(),
  );
  if (!m) throw new Error(`无法解析 ISO 时间: ${iso}`);
  const [, y, mo, d, h, mi, s, off] = m;
  let offsetMinutes = 0;
  if (off && off !== 'Z') {
    const sign = off[0] === '-' ? -1 : 1;
    const digits = off.slice(1).replace(':', '');
    offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
  }
  const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0));
  return utc - offsetMinutes * MS_PER_MINUTE;
}

function beijingShift(epochMs) {
  return epochMs + BEIJING_OFFSET_MINUTES * MS_PER_MINUTE;
}

/** 北京时间的「当天第几分钟」（0–1439） */
export function minuteOfDay(epochMs) {
  return Math.floor(beijingShift(epochMs) / MS_PER_MINUTE) % 1440;
}

/** 格式化为北京时间字符串 */
export function formatBeijing(epochMs) {
  const d = new Date(beijingShift(epochMs));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(
    d.getUTCHours(),
  )}:${p(d.getUTCMinutes())}`;
}

function formatHm(minutes) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(minutes / 60))}:${p(minutes % 60)}`;
}

// ---------------------------------------------------------------- 时段引擎

function isWithin(minute, startMin, endMin) {
  if (startMin <= endMin) return minute >= startMin && minute < endMin;
  return minute >= startMin || minute < endMin;
}

/**
 * 判定某一时刻所处的供应时段。
 * 返回距该时段结束还剩多少分钟 —— 这是通勤场景最关键的决策变量。
 *
 * @param {number} epochMs 目标时刻（epoch 毫秒）
 * @param {Array}  windows 时段表；默认用兜底的 MEAL_WINDOWS，
 *                         接入 MCP 后应传入 resolveStoreWindows() 解析出的门店真实时段
 */
export function windowAt(epochMs, windows = MEAL_WINDOWS) {
  const minute = minuteOfDay(epochMs);
  for (const w of windows) {
    const startMin = hmToMinutes(w.start);
    const endMin = hmToMinutes(w.end);
    if (!isWithin(minute, startMin, endMin)) continue;
    const untilClose = (endMin - minute + 1440) % 1440;
    return {
      key: w.key,
      label: w.label,
      start: w.start,
      end: w.end,
      startMin,
      endMin,
      minutesUntilClose: untilClose,
      /** 距时段结束不足 30 分钟，视为「临界状态」，需要提前决策 */
      isCritical: untilClose <= 30,
      /** 该时段是否来自门店真实数据（而非兜底估算表） */
      fromStore: w.source === 'store',
    };
  }
  return null;
}

/** 根据出发时间与通勤时长推算到达时间 */
export function resolveArrival(departIso, travelMinutes) {
  const travel = Number(travelMinutes);
  if (!Number.isFinite(travel) || travel < 0) {
    throw new Error(`通勤时长无效: ${travelMinutes}`);
  }
  return toEpoch(departIso) + travel * MS_PER_MINUTE;
}

/**
 * 找到给定时刻之后最近的一个供应时段。
 *
 * 真实门店时段之间存在**空档**。实测某门店为：
 *   早餐 07:14–10:15，午餐 10:44–14:15 —— 中间 10:15–10:44 买不到正餐。
 * 落到空档里时，告诉用户「下一时段几点开始」比笼统地说「不可售」有用得多。
 */
export function nextWindowAfter(epochMs, windows = MEAL_WINDOWS) {
  const minute = minuteOfDay(epochMs);
  let best = null;
  for (const w of windows) {
    const startMin = hmToMinutes(w.start);
    const delta = (startMin - minute + 1440) % 1440;
    if (!best || delta < best.minutesUntil) {
      best = { ...w, startMin, minutesUntil: delta };
    }
  }
  return best;
}

// ---------------------------------------------------------------- 券工具

export function daysUntil(expireEpochMs, nowEpochMs) {
  return (expireEpochMs - nowEpochMs) / MS_PER_DAY;
}

export function urgencyOf(coupon, nowEpochMs) {
  if (!coupon.expireAt) return { ...URGENCY_TIERS[URGENCY_TIERS.length - 1], days: Infinity };
  const days = daysUntil(toEpoch(coupon.expireAt), nowEpochMs);
  const hit = URGENCY_TIERS.find((t) => days <= t.maxDays) || URGENCY_TIERS.at(-1);
  return { tier: hit.tier, label: hit.label, bonus: hit.bonus, days };
}

/**
 * 解析 MCP 返回的券有效期字段 `tradeDateTime`。
 *
 * 实测格式：`"2026-10-05 10:30:00-2026-10-09 23:59:59"`
 * 返回 { start, end, expireAt }，其中 expireAt 为 ISO 8601（按北京时间）。
 */
export function parseCouponPeriod(tradeDateTime) {
  if (!tradeDateTime) return { start: null, end: null, expireAt: null };
  const parts = String(tradeDateTime).split('-');
  if (parts.length < 6) return { start: null, end: null, expireAt: null };
  // 形如 YYYY-MM-DD HH:mm:ss-YYYY-MM-DD HH:mm:ss，中间的 "-" 也是分隔符
  const text = String(tradeDateTime);
  const m = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*-\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(text);
  if (!m) return { start: null, end: null, expireAt: null };
  const toIso = (s) => `${s.replace(' ', 'T')}+08:00`;
  return { start: toIso(m[1]), end: toIso(m[2]), expireAt: toIso(m[2]) };
}

/**
 * 从券的商品名推导「品类关键词」。
 *
 * 实测发现：麦当劳的券多为**品类级「任选」券** ——
 * `productName` 形如「麦旋风任选1」「薯薯任选」，而 `productCode`（如 9900014239）
 * 并**不**出现在门店菜单里。也就是说券适用于某一类商品，而非某个确定 SKU。
 *
 * 这里只做保守推导，用于给用户提示；**绝不用它自动抵扣金额** ——
 * 猜错品类会导致报价错误，比不抵扣更糟。
 */
export function deriveVoucherCategory(productNames) {
  for (const raw of productNames || []) {
    const name = String(raw || '').trim();
    if (!name) continue;
    const stripped = name.replace(/任选\s*\d*$/, '').replace(/\d+$/, '').trim();
    if (stripped && stripped !== name) return stripped;
    return name;
  }
  return null;
}

/**
 * 找出「编码没匹配上、但品类关键词可能匹配」的兑换券，供 Skill 层向用户确认。
 * 结果**不参与计价**，只作提示。
 */
export function findVoucherHints(coupons, items = []) {
  const hits = [];
  for (const coupon of coupons || []) {
    const category = coupon.voucherCategory || deriveVoucherCategory(coupon.productNames);
    if (!category) continue;

    const codes = coupon.applicableProductCodes || [];
    const exact = items.some((i) => codes.includes(String(i.code)));
    if (exact) continue; // 已精确匹配，无需提示

    const candidates = items
      .filter((i) => String(i.name || '').includes(category))
      .map((i) => i.name);
    if (candidates.length) {
      hits.push({
        couponId: coupon.couponId,
        title: coupon.title,
        category,
        candidates,
      });
    }
  }
  return hits;
}

/**
 * 把麦当劳 MCP 返回的原始券对象归一化为本模块的券模型。
 *
 * ⚠ 实测麦当劳的券**多為兑换券**（免费兑换指定商品），而非「满 X 减 Y」。
 * 原始结构示例：
 *   { title, couponId, couponCode, tradeDateTime,
 *     products: [{ productCode: '9900014239', productName: '麦旋风任选1' }] }
 *
 * 归一化后：
 *   - 兑换券 → `applicableProductCodes`，抵扣额 = 组合中命中商品的售价之和
 *   - 满减券 → 保留 `discount` / `minSpend` / `discountRate`
 */
export function normalizeCoupon(raw) {
  const period = parseCouponPeriod(raw.tradeDateTime);
  const productCodes = (raw.products || [])
    .map((p) => p?.productCode)
    .filter(Boolean)
    .map(String);
  const productNames = (raw.products || []).map((p) => p?.productName).filter(Boolean);

  const base = {
    couponId: raw.couponId,
    couponCode: raw.couponCode,
    title: raw.title,
    expireAt: raw.expireAt || period.expireAt,
    validFrom: period.start,
  };

  if (productCodes.length) {
    return {
      ...base,
      type: 'voucher',
      applicableProductCodes: productCodes,
      productNames,
      /** 仅用于提示，不参与自动计价 */
      voucherCategory: deriveVoucherCategory(productNames),
    };
  }

  return {
    ...base,
    type: raw.discount != null || raw.discountRate != null ? 'amount' : 'unknown',
    discount: raw.discount != null ? Number(raw.discount) : undefined,
    minSpend: raw.minSpend != null ? Number(raw.minSpend) : 0,
    discountRate: raw.discountRate,
    discountCap: raw.discountCap,
  };
}

/**
 * 计算券在当前订单下的实际抵扣额。
 *
 * - 兑换券：抵扣额 = 组合中命中适用商品的售价之和（免费兑换）
 * - 满减券：需满足门槛，返回固定抵扣额
 * - 折扣券：subtotal × 折扣率，受封顶约束
 *
 * @param {object} coupon 券（原始或 normalizeCoupon 归一化后均可）
 * @param {number} subtotal 商品小计
 * @param {Array}  items    当前组合的餐品列表（兑换券需要）
 */
export function effectiveDiscount(coupon, subtotal, items = []) {
  const codes = coupon.applicableProductCodes || (coupon.products || [])
    .map((p) => p?.productCode)
    .filter(Boolean)
    .map(String);

  if (codes.length) {
    const set = new Set(codes);
    return items
      .filter((i) => set.has(String(i.code)))
      .reduce((sum, i) => sum + Number(i.price || 0), 0);
  }

  const minSpend = Number(coupon.minSpend || 0);
  if (subtotal < minSpend) return 0;
  if (coupon.discount != null) return Number(coupon.discount);
  if (coupon.discountRate != null) {
    const cap = coupon.discountCap != null ? Number(coupon.discountCap) : Infinity;
    return Math.min(subtotal * Number(coupon.discountRate), cap);
  }
  return 0;
}

/** 为一个小计金额挑选最优券：应付最低优先，同价取更早到期的 */
export function pickBestCoupon(coupons, subtotal, nowEpochMs, items = []) {
  let best = null;
  for (const coupon of coupons || []) {
    const discount = effectiveDiscount(coupon, subtotal, items);
    if (discount <= 0) continue;
    const urgency = urgencyOf(coupon, nowEpochMs);
    const payable = subtotal - discount;
    if (
      !best ||
      payable < best.payable - 1e-9 ||
      (Math.abs(payable - best.payable) < 1e-9 && urgency.days < best.urgency.days)
    ) {
      best = { coupon, discount, payable, urgency };
    }
  }
  return best;
}

// ---------------------------------------------------------------- 方案生成

function matchesPreference(item, preference) {
  if (!preference) return true;
  const needle = String(preference).trim().toLowerCase();
  if (!needle) return true;
  const haystack = [item.name, item.category, ...(item.tags || [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
}

function comboOf(items) {
  return {
    items,
    subtotal: items.reduce((s, i) => s + Number(i.price || 0), 0),
    calories: items.reduce((s, i) => s + Number(i.calories || 0), 0),
    prepMinutes: items.reduce((m, i) => Math.max(m, Number(i.prepMinutes || 0)), 0),
  };
}

function enumerateCombos(pool) {
  const combos = [];
  for (const a of pool) combos.push(comboOf([a]));
  for (let i = 0; i < pool.length; i += 1) {
    for (let j = i + 1; j < pool.length; j += 1) {
      const a = pool[i];
      const b = pool[j];
      if (a.category && a.category === b.category) continue;
      combos.push(comboOf([a, b]));
    }
  }
  return combos;
}

function normalize(value, min, max) {
  if (max - min < 1e-9) return 1;
  return (max - value) / (max - min);
}

/**
 * 生成候选方案。
 * 核心过滤链：时段可行性 → 预算 → 热量上限 → 偏好匹配 → 券适配
 */
export function buildPlans(input) {
  const {
    now,
    departTime,
    travelMinutes,
    budget = Infinity,
    maxCalories = Infinity,
    preference = '',
    fulfillment = 'pickup',
    stores = [],
    meals = [],
    coupons = [],
    queueBaseMinutes = 4,
    deliveryFee = 0,
    deliveryEtaMinutes = 0,
    /** 组合必须包含的餐品类别（如「主食」），避免推荐出一份零食当正餐 */
    requireCategory = null,
    weights = DEFAULT_WEIGHTS,
  } = input;

  const isDelivery = fulfillment === 'delivery';
  const extraFee = isDelivery ? Number(deliveryFee || 0) : 0;
  const extraEta = isDelivery ? Number(deliveryEtaMinutes || 0) : 0;

  const departEpoch = toEpoch(departTime);
  const nowEpoch = now ? toEpoch(now) : departEpoch;
  const arrivalEpoch = resolveArrival(departTime, travelMinutes);
  const notes = [];

  // 1) 门店：优先选距离最近的营业门店（外送场景由 MCP 侧给出门店列表）
  const openStores = stores.filter((s) => s.open !== false);
  if (stores.length && !openStores.length) {
    notes.push('目标地址附近没有营业中的门店，建议由 MCP 侧改用麦乐送或换址搜索。');
  }
  const store = openStores.slice().sort((a, b) => (a.distanceMeters ?? 1e9) - (b.distanceMeters ?? 1e9))[0] || null;

  // 2) 时段表：优先使用门店返回的真实可预约时段，拿不到才回退到兜底估算表
  const arrivalDateStr = formatBeijing(arrivalEpoch).slice(0, 10);
  const storeWindows = resolveStoreWindows(store, arrivalDateStr);
  const activeWindows = storeWindows || MEAL_WINDOWS;
  if (storeWindows) {
    notes.push(
      `时段取自门店「${store.name}」的真实可预约时段（${arrivalDateStr}），非估算值。`,
    );
  }
  const arrivalWindow = windowAt(arrivalEpoch, activeWindows);
  const windowsSource = storeWindows ? 'store' : 'fallback';

  // 3) 时段可行性：到达时已过供应时段的餐品直接剔除
  let windowFiltered = meals;
  if (arrivalWindow) {
    const allowed = meals.filter((m) => !m.windows || m.windows.includes(arrivalWindow.key));
    if (allowed.length < meals.length) {
      notes.push(
        `按到达时间 ${formatBeijing(arrivalEpoch)}（${arrivalWindow.label}时段）过滤掉 ${
          meals.length - allowed.length
        } 个当前不可售餐品。`,
      );
    }
    windowFiltered = allowed;
  } else {
    const next = nextWindowAfter(arrivalEpoch, activeWindows);
    if (next) {
      notes.push(
        `到达时落在供应时段的空档期，最近的下一时段「${next.label}」将于 ${next.start} 开始` +
          `（约 ${next.minutesUntil} 分钟后）。建议按该时段预约，或调整出发时间。`,
      );
    } else {
      notes.push('到达时间不在任何已知供应时段内，请以门店实际营业时间为准。');
    }
    windowFiltered = meals;
  }

  if (arrivalWindow && arrivalWindow.isCritical) {
    notes.push(
      `到达后距「${arrivalWindow.label}」时段结束仅剩 ${arrivalWindow.minutesUntilClose} 分钟，建议提前下单预约。`,
    );
  }

  // 3) 偏好与预算过滤
  const preferred = windowFiltered.filter((m) => matchesPreference(m, preference));
  let pool = preferred;
  if (!pool.length && preference) {
    notes.push(`没有完全匹配「${preference}」的餐品，已放宽为全量菜单。`);
    pool = windowFiltered;
  }
  if (!pool.length) {
    return {
      store,
      departure: departEpoch,
      arrival: arrivalEpoch,
      arrivalWindow,
      windowsSource,
      notes: [...notes, '当前时段没有任何可售餐品，无法生成方案。'],
      plans: [],
    };
  }

  // 4) 枚举组合并套用券
  const scored = [];
  for (const combo of enumerateCombos(pool)) {
    if (combo.subtotal > budget) continue;
    if (combo.calories > maxCalories) continue;
    // 类别硬约束：例如通勤正餐必须含一份主食，否则最低价零食会永远胜出
    if (requireCategory && !combo.items.some((i) => i.category === requireCategory)) continue;
    const best = pickBestCoupon(coupons, combo.subtotal, nowEpoch, combo.items);
    const discount = best ? best.discount : 0;
    const payable = combo.subtotal - discount + extraFee;
    const waitMinutes = Number(queueBaseMinutes) + combo.prepMinutes + extraEta;
    scored.push({
      ...combo,
      discount,
      deliveryFee: extraFee,
      payable,
      waitMinutes,
      coupon: best ? best.coupon : null,
      couponUrgency: best ? best.urgency : null,
    });
  }

  if (!scored.length) {
    return {
      store,
      departure: departEpoch,
      arrival: arrivalEpoch,
      arrivalWindow,
      windowsSource,
      notes: [
        ...notes,
        `在预算 ¥${budget} 与热量上限 ${maxCalories} kcal 内没有可用组合` +
          (requireCategory ? `（且要求包含「${requireCategory}」类餐品）` : '') +
          '。',
      ],
      plans: [],
    };
  }

  // 5) 四维归一化打分：价格 / 热量 / 取餐耗时 采用集合内相对位置（min-max），
  //    「券到期紧迫度」采用绝对尺度 —— 越接近过期越高分，因为把将过期的券用掉
  //    本身就是一种收益。没有可用券的方案在该轴上得 0 分。
  const prices = scored.map((s) => s.payable);
  const cals = scored.map((s) => s.calories);
  const waits = scored.map((s) => s.waitMinutes);
  const bounds = {
    price: [Math.min(...prices), Math.max(...prices)],
    calories: [Math.min(...cals), Math.max(...cals)],
    wait: [Math.min(...waits), Math.max(...waits)],
  };
  const totalWeight = weights.price + weights.calories + weights.wait + weights.expiry || 1;

  const ranked = scored
    .map((plan) => {
      const expiryScore = plan.couponUrgency
        ? Math.max(0, Math.min(1, 1 - plan.couponUrgency.days / EXPIRY_HORIZON_DAYS))
        : 0;
      const blended =
        normalize(plan.payable, ...bounds.price) * weights.price +
        normalize(plan.calories, ...bounds.calories) * weights.calories +
        normalize(plan.waitMinutes, ...bounds.wait) * weights.wait +
        expiryScore * weights.expiry;
      return {
        ...plan,
        expiryScore: Number(expiryScore.toFixed(3)),
        score: Number(((100 * blended) / totalWeight).toFixed(1)),
      };
    })
    .sort((a, b) => b.score - a.score);

  // 6) 选出最多 3 个互不相同的方案，优先覆盖「最优 / 最省 / 最低热量」三种取向，
  //    不足时按评分顺位补齐。标签反映方案在候选集中的相对位置，不做虚假归因。
  const minPayable = Math.min(...ranked.map((p) => p.payable));
  const minCalories = Math.min(...ranked.map((p) => p.calories));
  const minWait = Math.min(...ranked.map((p) => p.waitMinutes));

  const selection = [];
  const used = new Set();
  const tryAdd = (hit) => {
    if (hit && !used.has(hit)) {
      used.add(hit);
      selection.push(hit);
    }
  };
  tryAdd(ranked[0]);
  tryAdd([...ranked].sort((a, b) => a.payable - b.payable)[0]);
  tryAdd([...ranked].sort((a, b) => a.calories - b.calories)[0]);
  for (const p of ranked) {
    if (selection.length >= 3) break;
    tryAdd(p);
  }

  const plans = selection
    .slice(0, 3)
    .map((p) => {
      const tags = [];
      if (p.payable === minPayable) tags.push('最省');
      if (p.calories === minCalories) tags.push('最低热量');
      if (p.waitMinutes === minWait) tags.push(isDelivery ? '最快送达' : '最快取餐');
      if (!tags.length) tags.push('均衡');
      return { ...p, tags, recommended: p === ranked[0] };
    })
    .sort((a, b) => b.score - a.score);

  // 7) 兑换券的品类级提示：编码未命中但品类关键词可能有对应商品。
  //    只提示、不自动抵扣 —— 猜错品类会导致报价错误。
  for (const hint of findVoucherHints(coupons, pool)) {
    notes.push(
      `券「${hint.title}」是「${hint.category}」品类任选券，其商品编码未出现在当前菜单中；` +
        `可能适用的在售商品：${hint.candidates.join('、')}。该券未参与自动计价，需确认后再使用。`,
    );
  }

  return {
    store,
    fulfillment,
    departure: departEpoch,
    arrival: arrivalEpoch,
    arrivalWindow,
    windowsSource,
    budget,
    notes,
    plans,
  };
}

// ---------------------------------------------------------------- 渲染

export function renderReport(result) {
  const out = [];
  out.push('=== 麦麦通勤点单官 · 通勤点单方案 ===');
  out.push(`出发时间  ${formatBeijing(result.departure)}`);
  out.push(`预计到达  ${formatBeijing(result.arrival)}`);
  if (result.arrivalWindow) {
    const w = result.arrivalWindow;
    const src = result.windowsSource === 'store' ? '门店实时时段' : '估算时段';
    out.push(
      `到达时段  ${w.label}（供应 ${w.start}–${w.end}，到达后剩余 ${w.minutesUntilClose} 分钟${
        w.isCritical ? ' ⚠ 临界' : ''
      }）[${src}]`,
    );
  } else {
    out.push('到达时段  不在已知供应时段内');
  }
  out.push(
    `目标门店  ${
      result.store
        ? `${result.store.name}${result.store.distanceMeters != null ? `（距目的地约 ${result.store.distanceMeters} 米）` : ''}`
        : '未提供候选门店'
    }`,
  );
  out.push('');

  if (result.notes.length) {
    out.push('提示：');
    for (const n of result.notes) out.push(`  · ${n}`);
    out.push('');
  }

  if (!result.plans.length) {
    out.push('没有可执行的候选方案。');
    return out.join('\n');
  }

  out.push(`候选方案（${result.plans.length} 个）：`);
  result.plans.forEach((p, i) => {
    const mark = p.recommended ? '★ 推荐　' : '';
    out.push(`  [${i + 1}] ${mark}评分 ${p.score}　[${p.tags.join(' · ')}]`);
    out.push(`      组合：${p.items.map((it) => it.name).join(' + ')}`);
    const isDelivery = result.fulfillment === 'delivery';
    const parts = [`原价 ¥${p.subtotal.toFixed(2)}`];
    if (p.discount > 0) parts.push(`− 优惠 ¥${p.discount.toFixed(2)}`);
    if (p.deliveryFee > 0) parts.push(`+ 配送费 ¥${p.deliveryFee.toFixed(2)}`);
    parts.push(`= 应付 ¥${p.payable.toFixed(2)}`);
    out.push(`      金额：${parts.join(' ')}`);
    out.push(
      `      热量：${p.calories} kcal　${isDelivery ? '预计送达' : '预计取餐'}：约 ${p.waitMinutes} 分钟`,
    );
    if (p.coupon) {
      out.push(
        `      用券：${p.coupon.title}（${p.couponUrgency.label}${
          Number.isFinite(p.couponUrgency.days) ? `，剩余 ${p.couponUrgency.days.toFixed(1)} 天` : ''
        }）`,
      );
    }
    out.push('');
  });

  const top = result.plans.find((p) => p.recommended) || result.plans[0];
  out.push(`推荐：方案 ${result.plans.indexOf(top) + 1}（评分 ${top.score}）`);
  out.push('下单前请确认方案与支付金额 —— 本工具不会自动扣款。');
  return out.join('\n');
}

// ---------------------------------------------------------------- 渠道决策

/**
 * 渠道决策规则。
 *
 * 需要先说清楚一件事：在**同一门店、同一菜单、同一券**的前提下，
 * 外送必然比自取贵，差额恰好等于配送费。所以「渠道决策」的实质不是比价，
 * 而是把「用多少钱换不用出门 / 多少时间」这笔账算清楚，供用户判断。
 */
export const CHANNEL_RULES = {
  /** 配送费占预算超过该比例即提示强烈建议自取 */
  deliveryFeeBudgetRatioWarn: 0.2,
  /** 到达时距时段结束不足该分钟数，视为临界，外送时效不可控 */
  criticalWindowMinutes: 30,
};

/**
 * 对比自取与外送两个渠道，给出建议与量化理由。
 *
 * 输入在 buildPlans 的基础上额外支持：
 *   - cannotGoOut: true  → 用户无法出门，优先外送
 *   - deliveryFee / deliveryEtaMinutes → 外送成本与时效
 */
export function adviseChannel(input) {
  const pickupResult = buildPlans({ ...input, fulfillment: 'pickup' });
  const deliveryResult = buildPlans({ ...input, fulfillment: 'delivery' });
  const pickupBest =
    pickupResult.plans.find((p) => p.recommended) || pickupResult.plans[0] || null;
  const deliveryBest =
    deliveryResult.plans.find((p) => p.recommended) || deliveryResult.plans[0] || null;

  const reasons = [];
  const budget = Number(input.budget || 0);

  if (!pickupBest && !deliveryBest) {
    return {
      recommended: null,
      reasons: ['自取与外送两个渠道都没有可用方案，请检查地址或放宽预算。'],
      pickupResult,
      deliveryResult,
      comparison: null,
    };
  }

  let recommended;
  if (!deliveryBest) {
    recommended = 'pickup';
    reasons.push('外送渠道无可用方案（可能超出配送范围或无配送门店），只能到店自取。');
  } else if (!pickupBest) {
    recommended = 'delivery';
    reasons.push('附近没有可到店取餐的门店，只能选择外送。');
  } else {
    const fee = Number(deliveryBest.deliveryFee || 0);
    const feeRatio = budget > 0 ? fee / budget : 0;
    const window = pickupResult.arrivalWindow;
    const isCritical = window && window.minutesUntilClose <= CHANNEL_RULES.criticalWindowMinutes;

    if (input.cannotGoOut) {
      recommended = 'delivery';
      reasons.push(
        `你已说明无法出门，选择外送。相比自取需多付 ¥${fee.toFixed(2)} 配送费，` +
          `但无需在 ${window ? window.minutesUntilClose : '—'} 分钟内赶到门店。`,
      );
    } else if (isCritical) {
      recommended = 'pickup';
      reasons.push(
        `到达时距「${window.label}」时段结束仅剩 ${window.minutesUntilClose} 分钟，` +
          '外送时效不可控，建议到店自取或提前预约。',
      );
    } else if (budget > 0 && feeRatio > CHANNEL_RULES.deliveryFeeBudgetRatioWarn) {
      recommended = 'pickup';
      reasons.push(
        `配送费 ¥${fee.toFixed(2)} 占预算的 ${(feeRatio * 100).toFixed(0)}%，` +
          `已超过 ${(CHANNEL_RULES.deliveryFeeBudgetRatioWarn * 100).toFixed(0)}% 的警戒线，建议自取。`,
      );
    } else {
      recommended = 'pickup';
      reasons.push(
        `同为 ¥${pickupBest.payable.toFixed(2)} 的自取方案，外送需多付 ¥${fee.toFixed(2)} 配送费` +
          `（+${deliveryBest.waitMinutes - pickupBest.waitMinutes} 分钟），自取更省。`,
      );
    }
  }

  const comparison =
    pickupBest && deliveryBest
      ? {
          fee: deliveryBest.deliveryFee,
          pickup: {
            payable: pickupBest.payable,
            waitMinutes: pickupBest.waitMinutes,
            items: pickupBest.items.map((i) => i.name),
          },
          delivery: {
            payable: deliveryBest.payable,
            waitMinutes: deliveryBest.waitMinutes,
            items: deliveryBest.items.map((i) => i.name),
          },
          /** 选外送需要多付的钱 */
          deliveryPremium: Number((deliveryBest.payable - pickupBest.payable).toFixed(2)),
          /** 选外送换来的时间差（负数表示外送更快） */
          timeDelta: deliveryBest.waitMinutes - pickupBest.waitMinutes,
        }
      : null;

  return { recommended, reasons, pickupResult, deliveryResult, comparison };
}

export function renderChannelAdvice(result) {
  const out = [];
  out.push('=== 麦麦通勤点单官 · 渠道决策 ===');
  out.push('');
  if (!result.recommended) {
    for (const r of result.reasons) out.push(`  ${r}`);
    return out.join('\n');
  }
  out.push(`建议渠道：${result.recommended === 'pickup' ? '到店自取' : '麦乐送外送'}`);
  out.push('');
  for (const r of result.reasons) out.push(`  理由：${r}`);

  if (result.comparison) {
    const c = result.comparison;
    out.push('');
    out.push('  对比（取各自最优方案）：');
    out.push(
      `    自取　实付 ¥${c.pickup.payable.toFixed(2)}　耗时约 ${c.pickup.waitMinutes} 分钟　${c.pickup.items.join(' + ')}`,
    );
    out.push(
      `    外送　实付 ¥${c.delivery.payable.toFixed(2)}　耗时约 ${c.delivery.waitMinutes} 分钟　${c.delivery.items.join(' + ')}`,
    );
    out.push(
      `    → 选外送需多付 ¥${c.deliveryPremium.toFixed(2)}（含配送费 ¥${Number(c.fee).toFixed(2)}），` +
        `耗时差 ${c.timeDelta >= 0 ? '+' : ''}${c.timeDelta} 分钟`,
    );
  }
  out.push('');
  out.push('渠道建议只说明取舍，最终选择请由用户决定。');
  return out.join('\n');
}

// ---------------------------------------------------------------- 内置演示数据

export const DEMO_INPUT = {
  now: '2026-10-10T08:15:00+08:00',
  departTime: '2026-10-10T08:20:00+08:00',
  travelMinutes: 40,
  budget: 40,
  maxCalories: 600,
  preference: '咖啡',
  fulfillment: 'pickup',
  queueBaseMinutes: 4,
  stores: [
    { storeCode: 'SH-PD-001', name: '世纪大道店', distanceMeters: 260, open: true },
    { storeCode: 'SH-PD-002', name: '陆家嘴环路店', distanceMeters: 540, open: true },
  ],
  meals: [
    { code: 'M001', name: '香浓拿铁', category: '饮品', price: 15, calories: 130, prepMinutes: 2, tags: ['咖啡', '热饮'], windows: ['breakfast', 'lunch', 'afternoon'] },
    { code: 'M002', name: '美式咖啡', category: '饮品', price: 12, calories: 10, prepMinutes: 2, tags: ['咖啡'], windows: ['breakfast', 'lunch', 'afternoon'] },
    { code: 'M003', name: '咖啡可颂套餐', category: '套餐', price: 19.5, calories: 320, prepMinutes: 4, tags: ['咖啡', '早餐', '套餐'], windows: ['breakfast'] },
    { code: 'M004', name: '早安咖啡组合', category: '套餐', price: 22, calories: 380, prepMinutes: 4, tags: ['咖啡', '早餐', '套餐'], windows: ['breakfast'] },
    { code: 'M005', name: '原味豆浆', category: '饮品', price: 9, calories: 110, prepMinutes: 1, tags: ['早餐'], windows: ['breakfast'] },
    { code: 'M006', name: '双层吉士汉堡', category: '主食', price: 22, calories: 450, prepMinutes: 6, tags: ['正餐'], windows: ['lunch', 'dinner'] },
  ],
  coupons: [
    { couponId: 'C-001', title: '通勤专享 满20减12', discount: 12, minSpend: 20, expireAt: '2026-10-11T23:59:00+08:00' },
    { couponId: 'C-002', title: '饮品立减3元', discount: 3, minSpend: 10, expireAt: '2026-10-20T23:59:00+08:00' },
    { couponId: 'C-003', title: '满30减8', discount: 8, minSpend: 30, expireAt: '2026-10-15T23:59:00+08:00' },
  ],
};

// ---------------------------------------------------------------- CLI

function main(argv) {
  const args = new Set(argv.slice(2));
  const asJson = args.has('--json');
  let input = DEMO_INPUT;

  const inputFlag = argv.indexOf('--input');
  if (inputFlag !== -1) {
    const file = argv[inputFlag + 1];
    if (!file) {
      console.error('用法：--input <payload.json>');
      process.exit(2);
    }
    // 读取外部输入，保持脚本零依赖、可直接 node 运行
    input = JSON.parse(readFileSync(file, 'utf8'));
  }

  const result = args.has('--advise-channel') ? adviseChannel(input) : buildPlans(input);
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(args.has('--advise-channel') ? renderChannelAdvice(result) : renderReport(result));
  }
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main(process.argv);
}
