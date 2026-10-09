#!/usr/bin/env node
/**
 * 麦麦通勤点单官 · 单元测试
 * ------------------------------------------------------------------
 * 零依赖，直接用 node 运行：node --test tests/
 * 覆盖时段引擎、到达推算、券择优与四维评分四组核心逻辑。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MEAL_WINDOWS,
  URGENCY_TIERS,
  DEFAULT_WEIGHTS,
  CHANNEL_RULES,
  toEpoch,
  minuteOfDay,
  formatBeijing,
  windowAt,
  resolveArrival,
  daysUntil,
  urgencyOf,
  effectiveDiscount,
  pickBestCoupon,
  buildPlans,
  adviseChannel,
  renderChannelAdvice,
  parseReservationOptions,
  resolveStoreWindows,
  nextWindowAfter,
  parseCouponPeriod,
  normalizeCoupon,
  deriveVoucherCategory,
  findVoucherHints,
  DEMO_INPUT,
} from '../scripts/plan-commute-order.mjs';

import { RESCUE_TIERS, tierOf, buildRescueList, DEMO_WALLET } from '../scripts/coupon-deadline-rescue.mjs';

// ---------------------------------------------------------------- 时间解析

test('toEpoch: 显式时区偏移解析正确，且不依赖运行机器时区', () => {
  const a = toEpoch('2026-10-10T08:20:00+08:00');
  const b = toEpoch('2026-10-10T00:20:00Z');
  assert.equal(a, b);
});

test('toEpoch: 支持省略秒与使用空格分隔', () => {
  assert.equal(toEpoch('2026-10-10T08:20+08:00'), toEpoch('2026-10-10 08:20:00+08:00'));
});

test('toEpoch: 非法输入应抛出异常', () => {
  assert.throws(() => toEpoch('not-a-time'));
});

test('minuteOfDay / formatBeijing: 按北京时间计算', () => {
  const t = toEpoch('2026-10-10T08:20:00+08:00');
  assert.equal(minuteOfDay(t), 8 * 60 + 20);
  assert.equal(formatBeijing(t), '2026-10-10 08:20');
});

test('minuteOfDay: UTC 时间正确换算为北京时间', () => {
  // 00:20 UTC === 08:20 北京时间
  assert.equal(minuteOfDay(toEpoch('2026-10-10T00:20:00Z')), 8 * 60 + 20);
});

// ---------------------------------------------------------------- 时段引擎

test('windowAt: 正常时段内判定正确并算出剩余分钟', () => {
  const w = windowAt(toEpoch('2026-10-10T09:00:00+08:00'));
  assert.equal(w.key, 'breakfast');
  assert.equal(w.minutesUntilClose, 90); // 10:30 - 09:00
  assert.equal(w.isCritical, false);
});

test('windowAt: 距结束不足 30 分钟判定为临界', () => {
  const w = windowAt(toEpoch('2026-10-10T10:20:00+08:00'));
  assert.equal(w.key, 'breakfast');
  assert.equal(w.minutesUntilClose, 10);
  assert.equal(w.isCritical, true);
});

test('windowAt: 时段边界按左闭右开处理', () => {
  assert.equal(windowAt(toEpoch('2026-10-10T10:30:00+08:00')).key, 'lunch');
  assert.equal(windowAt(toEpoch('2026-10-10T10:29:00+08:00')).key, 'breakfast');
});

test('windowAt: 夜宵时段跨越零点，剩余分钟计算正确', () => {
  const w = windowAt(toEpoch('2026-10-10T23:30:00+08:00'));
  assert.equal(w.key, 'late-night');
  assert.equal(w.minutesUntilClose, 330); // 到次日 05:00
});

test('windowAt: 凌晨落在夜宵时段', () => {
  assert.equal(windowAt(toEpoch('2026-10-10T02:00:00+08:00')).key, 'late-night');
});

test('MEAL_WINDOWS: 五个时段连续覆盖全天且不重叠', () => {
  const total = MEAL_WINDOWS.reduce((sum, w) => {
    const [sh, sm] = w.start.split(':').map(Number);
    const [eh, em] = w.end.split(':').map(Number);
    const span = (eh * 60 + em - sh * 60 - sm + 1440) % 1440;
    return sum + span;
  }, 0);
  assert.equal(total, 1440);
});

// ---------------------------------------------------------------- 到达推算

test('resolveArrival: 出发时间加通勤时长', () => {
  const arrival = resolveArrival('2026-10-10T08:20:00+08:00', 40);
  assert.equal(formatBeijing(arrival), '2026-10-10 09:00');
});

test('resolveArrival: 跨零点正确进位', () => {
  const arrival = resolveArrival('2026-10-10T23:40:00+08:00', 40);
  assert.equal(formatBeijing(arrival), '2026-10-11 00:20');
});

test('resolveArrival: 非法通勤时长应抛出异常', () => {
  assert.throws(() => resolveArrival('2026-10-10T08:20:00+08:00', -5));
  assert.throws(() => resolveArrival('2026-10-10T08:20:00+08:00', 'abc'));
});

// ---------------------------------------------------------------- 券逻辑

test('daysUntil: 剩余天数计算为浮点数', () => {
  const now = toEpoch('2026-10-10T00:00:00+08:00');
  const exp = toEpoch('2026-10-11T00:00:00+08:00');
  assert.equal(daysUntil(exp, now), 1);
});

test('urgencyOf: 按剩余天数落到正确档位', () => {
  const now = toEpoch('2026-10-10T00:00:00+08:00');
  assert.equal(urgencyOf({ expireAt: '2026-10-10T12:00:00+08:00' }, now).tier, 'critical');
  assert.equal(urgencyOf({ expireAt: '2026-10-12T00:00:00+08:00' }, now).tier, 'urgent');
  assert.equal(urgencyOf({ expireAt: '2026-10-15T00:00:00+08:00' }, now).tier, 'soon');
  assert.equal(urgencyOf({ expireAt: '2026-11-01T00:00:00+08:00' }, now).tier, 'normal');
});

test('urgencyOf: 无到期日的券归入最低紧迫档', () => {
  assert.equal(urgencyOf({}, toEpoch('2026-10-10T00:00:00+08:00')).tier, 'normal');
});

test('effectiveDiscount: 不满足门槛返回 0', () => {
  assert.equal(effectiveDiscount({ discount: 12, minSpend: 20 }, 19.9), 0);
  assert.equal(effectiveDiscount({ discount: 12, minSpend: 20 }, 20), 12);
});

test('effectiveDiscount: 支持折扣率加封顶', () => {
  const coupon = { discountRate: 0.2, discountCap: 5 };
  assert.equal(effectiveDiscount(coupon, 10), 2);
  assert.equal(effectiveDiscount(coupon, 100), 5); // 20 元被封顶到 5 元
});

test('pickBestCoupon: 选应付最低的券', () => {
  const now = toEpoch('2026-10-10T00:00:00+08:00');
  const coupons = [
    { couponId: 'a', title: '减3', discount: 3, minSpend: 10, expireAt: '2026-10-20T00:00:00+08:00' },
    { couponId: 'b', title: '减8', discount: 8, minSpend: 20, expireAt: '2026-10-14T00:00:00+08:00' },
  ];
  assert.equal(pickBestCoupon(coupons, 25, now).coupon.couponId, 'b');
});

test('pickBestCoupon: 应付相同时优先用更早到期的券', () => {
  const now = toEpoch('2026-10-10T00:00:00+08:00');
  const coupons = [
    { couponId: 'late', title: '减5', discount: 5, minSpend: 10, expireAt: '2026-11-20T00:00:00+08:00' },
    { couponId: 'soon', title: '减5', discount: 5, minSpend: 10, expireAt: '2026-10-11T00:00:00+08:00' },
  ];
  assert.equal(pickBestCoupon(coupons, 25, now).coupon.couponId, 'soon');
});

test('pickBestCoupon: 无可用券返回 null', () => {
  const now = toEpoch('2026-10-10T00:00:00+08:00');
  assert.equal(pickBestCoupon([{ discount: 5, minSpend: 999 }], 10, now), null);
  assert.equal(pickBestCoupon([], 10, now), null);
});

// ---------------------------------------------------------------- 方案生成

test('buildPlans: 到达时段外不可售的餐品被过滤', () => {
  const result = buildPlans(DEMO_INPUT);
  const names = result.plans.flatMap((p) => p.items.map((i) => i.name));
  // 双层吉士汉堡标记为 lunch/dinner，09:00 到达（早餐时段）不应出现
  assert.ok(!names.includes('双层吉士汉堡'));
  assert.ok(result.notes.some((n) => n.includes('过滤掉')));
});

test('buildPlans: 到达时间推算与时段判定正确', () => {
  const result = buildPlans(DEMO_INPUT);
  assert.equal(formatBeijing(result.arrival), '2026-10-10 09:00');
  assert.equal(result.arrivalWindow.key, 'breakfast');
});

test('buildPlans: 输出的方案互不相同', () => {
  const result = buildPlans(DEMO_INPUT);
  const keys = result.plans.map((p) => p.items.map((i) => i.code).join('+'));
  assert.equal(new Set(keys).size, keys.length);
});

test('buildPlans: 方案数量不超过 3 个', () => {
  assert.ok(buildPlans(DEMO_INPUT).plans.length <= 3);
});

test('buildPlans: 恰有一个方案被标记为推荐', () => {
  const result = buildPlans(DEMO_INPUT);
  assert.equal(result.plans.filter((p) => p.recommended).length, 1);
});

test('buildPlans: 应付金额 = 小计 − 优惠', () => {
  for (const p of buildPlans(DEMO_INPUT).plans) {
    assert.ok(Math.abs(p.payable - (p.subtotal - p.discount)) < 1e-9);
  }
});

test('buildPlans: 不满足券门槛的组合不会产生抵扣', () => {
  for (const p of buildPlans(DEMO_INPUT).plans) {
    if (p.discount > 0) {
      assert.ok(p.subtotal >= Number(p.coupon.minSpend || 0));
    }
  }
});

test('buildPlans: 预算上限被严格尊重', () => {
  const result = buildPlans({ ...DEMO_INPUT, budget: 15 });
  for (const p of result.plans) assert.ok(p.payable <= 15);
});

test('buildPlans: 热量上限被严格尊重', () => {
  const result = buildPlans({ ...DEMO_INPUT, maxCalories: 200 });
  for (const p of result.plans) assert.ok(p.calories <= 200);
});

test('buildPlans: 偏好无匹配时放宽为全量菜单并给出提示', () => {
  const result = buildPlans({ ...DEMO_INPUT, preference: '螺蛳粉' });
  assert.ok(result.notes.some((n) => n.includes('放宽')));
  assert.ok(result.plans.length > 0);
});

test('buildPlans: 取餐耗时 = 排队基数 + 出餐耗时', () => {
  const result = buildPlans({ ...DEMO_INPUT, queueBaseMinutes: 10 });
  for (const p of result.plans) {
    const maxPrep = Math.max(...p.items.map((i) => i.prepMinutes));
    assert.equal(p.waitMinutes, 10 + maxPrep);
  }
});

test('buildPlans: 外送场景计入配送费并把耗时换成送达时长', () => {
  const result = buildPlans({
    ...DEMO_INPUT,
    fulfillment: 'delivery',
    deliveryFee: 9,
    deliveryEtaMinutes: 30,
  });
  for (const p of result.plans) {
    assert.ok(Math.abs(p.payable - (p.subtotal - p.discount + 9)) < 1e-9);
    assert.ok(p.waitMinutes >= 30);
  }
  assert.equal(result.fulfillment, 'delivery');
});

test('buildPlans: 到店取餐场景不计配送费', () => {
  const result = buildPlans({ ...DEMO_INPUT, fulfillment: 'pickup', deliveryFee: 9 });
  for (const p of result.plans) {
    assert.ok(Math.abs(p.payable - (p.subtotal - p.discount)) < 1e-9);
  }
});

test('buildPlans: 券到期紧迫度确实参与评分（紧迫券得分被抬升）', () => {
  const now = toEpoch('2026-10-10T00:00:00+08:00');
  const base = {
    now: '2026-10-10T00:00:00+08:00',
    departTime: '2026-10-10T00:00:00+08:00',
    travelMinutes: 0,
    stores: [{ storeCode: 'S1', name: '测试店', distanceMeters: 100, open: true }],
    meals: [
      { code: 'X', name: '测试餐A', category: '主食', price: 20, calories: 300, prepMinutes: 3, windows: ['late-night'] },
      { code: 'Y', name: '测试餐B', category: '主食', price: 20, calories: 300, prepMinutes: 3, windows: ['late-night'] },
    ],
  };
  const withUrgent = buildPlans({
    ...base,
    coupons: [{ couponId: 'u', title: '明天到期减5', discount: 5, minSpend: 20, expireAt: '2026-10-10T20:00:00+08:00' }],
  });
  // 紧迫券方案应带上 3 天内到期的紧迫标记
  const plan = withUrgent.plans[0];
  assert.ok(plan.couponUrgency);
  assert.ok(plan.expiryScore > 0.8);
  assert.ok(daysUntil(toEpoch('2026-10-10T20:00:00+08:00'), now) < 1);
});

test('buildPlans: 无可售餐品时返回空方案并说明原因', () => {
  const result = buildPlans({
    ...DEMO_INPUT,
    meals: [{ code: 'Z', name: '正餐专属', category: '主食', price: 20, calories: 300, prepMinutes: 3, windows: ['dinner'] }],
  });
  assert.equal(result.plans.length, 0);
  assert.ok(result.notes.some((n) => n.includes('无法生成方案') || n.includes('没有')));
});

// ---------------------------------------------------------------- 券到期救援

test('tierOf: 已过期券归入 expired 档', () => {
  const now = toEpoch('2026-10-10T00:00:00+08:00');
  assert.equal(tierOf({ expireAt: '2026-10-08T00:00:00+08:00' }, now).key, 'expired');
});

test('buildRescueList: 按紧迫度分档且档内按抵扣额降序', () => {
  const result = buildRescueList(DEMO_WALLET);
  const tierIndex = (key) => RESCUE_TIERS.findIndex((t) => t.key === key);
  const indices = result.rows.map((r) => tierIndex(r.tier.key));
  for (let i = 1; i < indices.length; i += 1) {
    assert.ok(indices[i] >= indices[i - 1], '分档顺序必须单调不递减');
  }
  // 同一档内抵扣额降序
  for (let i = 1; i < result.rows.length; i += 1) {
    if (result.rows[i].tier.key === result.rows[i - 1].tier.key) {
      assert.ok(result.rows[i].value <= result.rows[i - 1].value);
    }
  }
});

test('buildRescueList: 积分账户与到期天数被正确解析', () => {
  const result = buildRescueList(DEMO_WALLET);
  assert.equal(result.points.available, 1860);
  assert.equal(result.points.expiring, 420);
  assert.ok(Math.abs(result.points.daysLeft - 4.7) < 0.05);
});

test('buildRescueList: 空券包不报错', () => {
  const result = buildRescueList({ now: '2026-10-10T00:00:00+08:00', coupons: [] });
  assert.equal(result.rows.length, 0);
});

// ---------------------------------------------------------------- 渠道决策

const DELIVERY_BASE = {
  ...DEMO_INPUT,
  budget: 100,
  deliveryFee: 9,
  deliveryEtaMinutes: 30,
};

test('adviseChannel: 无特殊约束时推荐自取（外送必然多付配送费）', () => {
  const result = adviseChannel(DELIVERY_BASE);
  assert.equal(result.recommended, 'pickup');
  assert.ok(result.reasons.some((r) => r.includes('配送费')));
});

test('adviseChannel: 选外送的溢价恰好等于配送费', () => {
  const result = adviseChannel(DELIVERY_BASE);
  assert.equal(result.comparison.deliveryPremium, 9);
  assert.equal(result.comparison.fee, 9);
});

test('adviseChannel: 配送费占预算超 20% 时给出警戒理由', () => {
  // 预算 40，配送费 9 → 22.5%
  const result = adviseChannel({ ...DEMO_INPUT, budget: 40, deliveryFee: 9, deliveryEtaMinutes: 30 });
  assert.equal(result.recommended, 'pickup');
  assert.ok(result.reasons.some((r) => r.includes('警戒线')));
});

test('adviseChannel: 无法出门时推荐外送', () => {
  const result = adviseChannel({ ...DELIVERY_BASE, cannotGoOut: true });
  assert.equal(result.recommended, 'delivery');
  assert.ok(result.reasons.some((r) => r.includes('无法出门')));
});

test('adviseChannel: 到达时段临界时推荐自取，避免外送时效不可控', () => {
  // 08:20 出发 + 120 分钟 → 10:20 到达，距早餐结束仅 10 分钟
  const result = adviseChannel({ ...DELIVERY_BASE, travelMinutes: 120, deliveryFee: 5 });
  assert.equal(result.recommended, 'pickup');
  assert.ok(result.reasons.some((r) => r.includes('外送时效不可控')));
});

test('adviseChannel: 无可用方案时返回 null 并说明', () => {
  const result = adviseChannel({
    ...DELIVERY_BASE,
    meals: [{ code: 'Z', name: '正餐专属', category: '主食', price: 20, calories: 300, prepMinutes: 3, windows: ['dinner'] }],
  });
  assert.equal(result.recommended, null);
  assert.equal(result.comparison, null);
  assert.ok(result.reasons.length > 0);
});

test('adviseChannel: cannotGoOut 优先于配送费警戒线', () => {
  // 配送费占预算 22.5%（超警戒线），但用户无法出门 → 仍应推荐外送
  const result = adviseChannel({
    ...DEMO_INPUT,
    budget: 40,
    deliveryFee: 9,
    deliveryEtaMinutes: 30,
    cannotGoOut: true,
  });
  assert.equal(result.recommended, 'delivery');
});

test('adviseChannel: 渲染结果包含渠道对比与溢价说明', () => {
  const text = renderChannelAdvice(adviseChannel(DELIVERY_BASE));
  assert.ok(text.includes('建议渠道：到店自取'));
  assert.ok(text.includes('对比'));
  assert.ok(text.includes('配送费'));
});

test('adviseChannel: 渲染无方案结果时不抛异常', () => {
  const text = renderChannelAdvice(
    adviseChannel({
      ...DELIVERY_BASE,
      meals: [{ code: 'Z', name: '正餐专属', category: '主食', price: 20, calories: 300, prepMinutes: 3, windows: ['dinner'] }],
    }),
  );
  assert.ok(text.includes('渠道决策'));
});

test('CHANNEL_RULES: 警戒线与临界值符合设计预期', () => {
  assert.equal(CHANNEL_RULES.deliveryFeeBudgetRatioWarn, 0.2);
  assert.equal(CHANNEL_RULES.criticalWindowMinutes, 30);
});

// ---------------------------------------------------------------- 门店真实时段

/** 实测自麦当劳 MCP `query-nearby-stores` 的真实返回文本 */
const REAL_OPTION_TEXT =
  '早餐(07:14至10:15)，午餐(10:44至14:15)，下午茶(14:44至16:45)，夜市(17:14至21:45)';

test('parseReservationOptions: 解析实测门店时段文本', () => {
  const windows = parseReservationOptions(REAL_OPTION_TEXT);
  assert.equal(windows.length, 4);
  assert.deepEqual(
    windows.map((w) => [w.key, w.start, w.end]),
    [
      ['breakfast', '07:14', '10:15'],
      ['lunch', '10:44', '14:15'],
      ['afternoon', '14:44', '16:45'],
      ['dinner', '17:14', '21:45'],
    ],
  );
  assert.ok(windows.every((w) => w.source === 'store'));
});

test('parseReservationOptions: 空输入与非法文本返回空数组', () => {
  assert.deepEqual(parseReservationOptions(''), []);
  assert.deepEqual(parseReservationOptions(null), []);
  assert.deepEqual(parseReservationOptions('没有任何时段信息'), []);
});

test('parseReservationOptions: 支持半角括号与「至」以外的空格变体', () => {
  const windows = parseReservationOptions('早餐(06:44 至 10:15)');
  assert.equal(windows.length, 1);
  assert.equal(windows[0].start, '06:44');
});

test('resolveStoreWindows: 按日期选中对应条目', () => {
  const store = {
    reservationTimeOptions: [
      { date: '2026-10-09', today: true, reservationOptionText: '夜市(17:14至21:45)' },
      { date: '2026-10-10', today: false, reservationOptionText: REAL_OPTION_TEXT },
    ],
  };
  const windows = resolveStoreWindows(store, '2026-10-10');
  assert.equal(windows.length, 4);
  assert.equal(windows[0].start, '07:14');
});

test('resolveStoreWindows: 日期不存在时回退到 today 条目', () => {
  const store = {
    reservationTimeOptions: [
      { date: '2026-10-09', today: true, reservationOptionText: '夜市(17:14至21:45)' },
      { date: '2026-10-10', today: false, reservationOptionText: REAL_OPTION_TEXT },
    ],
  };
  const windows = resolveStoreWindows(store, '2030-01-01');
  assert.equal(windows.length, 1);
  assert.equal(windows[0].key, 'dinner');
});

test('resolveStoreWindows: 门店无时段数据时返回 null', () => {
  assert.equal(resolveStoreWindows({}, '2026-10-10'), null);
  assert.equal(resolveStoreWindows(null, '2026-10-10'), null);
  assert.equal(resolveStoreWindows({ reservationTimeOptions: [] }, '2026-10-10'), null);
});

test('windowAt: 传入门店真实时段时按真实边界判定，而非估算表', () => {
  const windows = parseReservationOptions(REAL_OPTION_TEXT);
  // 09:00 在真实早餐时段内，距 10:15 结束还有 75 分钟
  const w = windowAt(toEpoch('2026-10-10T09:00:00+08:00'), windows);
  assert.equal(w.key, 'breakfast');
  assert.equal(w.end, '10:15');
  assert.equal(w.minutesUntilClose, 75);
  assert.equal(w.fromStore, true);
  // 估算表下 10:29 仍算早餐，真实数据下 10:15 就已结束
  assert.equal(windowAt(toEpoch('2026-10-10T10:29:00+08:00'), windows), null);
});

test('nextWindowAfter: 落在空档期时给出下一个时段', () => {
  const windows = parseReservationOptions(REAL_OPTION_TEXT);
  // 10:20 处于 早餐(→10:15) 与 午餐(10:44→) 之间的空档
  const next = nextWindowAfter(toEpoch('2026-10-10T10:20:00+08:00'), windows);
  assert.equal(next.key, 'lunch');
  assert.equal(next.start, '10:44');
  assert.equal(next.minutesUntil, 24);
});

test('buildPlans: 门店带真实时段时优先采用，并标注来源', () => {
  const result = buildPlans({
    ...DEMO_INPUT,
    stores: [
      {
        storeCode: '1450253',
        name: '麦当劳上海世纪汇广场餐厅',
        distanceMeters: 72,
        open: true,
        reservationTimeOptions: [
          { date: '2026-10-10', today: false, reservationOptionText: REAL_OPTION_TEXT },
        ],
      },
    ],
  });
  assert.equal(result.windowsSource, 'store');
  assert.equal(result.arrivalWindow.end, '10:15');
  assert.ok(result.notes.some((n) => n.includes('真实可预约时段')));
});

test('buildPlans: 无门店时段数据时回退到估算表', () => {
  const result = buildPlans(DEMO_INPUT);
  assert.equal(result.windowsSource, 'fallback');
  assert.equal(result.arrivalWindow.end, '10:30');
});

test('buildPlans: 落到时段空档期时提示下一个时段', () => {
  const result = buildPlans({
    ...DEMO_INPUT,
    departTime: '2026-10-10T08:20:00+08:00',
    travelMinutes: 120, // 到达 10:20，落在真实空档期
    stores: [
      {
        storeCode: '1450253',
        name: '麦当劳上海世纪汇广场餐厅',
        distanceMeters: 72,
        open: true,
        reservationTimeOptions: [
          { date: '2026-10-10', today: false, reservationOptionText: REAL_OPTION_TEXT },
        ],
      },
    ],
  });
  assert.equal(result.arrivalWindow, null);
  assert.ok(result.notes.some((n) => n.includes('空档期') && n.includes('10:44')));
});

// ---------------------------------------------------------------- 真实券结构

/** 实测自麦当劳 MCP `query-store-coupons` 的真实返回 */
const REAL_COUPON = {
  title: '麦旋风任选',
  couponId: '71F939A874735C2495517B8B24323CFB',
  couponCode: 'MCD6F2Y2090L00Y190V76',
  tradeDateTime: '2026-10-05 10:30:00-2026-10-09 23:59:59',
  products: [{ productCode: '9900014239', productName: '麦旋风任选1' }],
};

test('parseCouponPeriod: 解析实测 tradeDateTime', () => {
  const p = parseCouponPeriod(REAL_COUPON.tradeDateTime);
  assert.equal(p.start, '2026-10-05T10:30:00+08:00');
  assert.equal(p.end, '2026-10-09T23:59:59+08:00');
  assert.equal(p.expireAt, '2026-10-09T23:59:59+08:00');
});

test('parseCouponPeriod: 非法输入返回空值', () => {
  for (const bad of [null, '', '2026-10-09']) {
    assert.equal(parseCouponPeriod(bad).expireAt, null);
  }
});

test('normalizeCoupon: 兑换券被识别并提取适用商品', () => {
  const c = normalizeCoupon(REAL_COUPON);
  assert.equal(c.type, 'voucher');
  assert.deepEqual(c.applicableProductCodes, ['9900014239']);
  assert.equal(c.expireAt, '2026-10-09T23:59:59+08:00');
  assert.equal(c.couponCode, 'MCD6F2Y2090L00Y190V76');
});

test('normalizeCoupon: 满减券保持 amount 类型', () => {
  const c = normalizeCoupon({ couponId: 'x', title: '满20减5', discount: 5, minSpend: 20 });
  assert.equal(c.type, 'amount');
  assert.equal(c.discount, 5);
  assert.equal(c.applicableProductCodes, undefined);
});

test('effectiveDiscount: 兑换券的抵扣额等于命中商品售价', () => {
  const c = normalizeCoupon(REAL_COUPON);
  const items = [
    { code: '9900014239', name: '麦旋风任选1', price: 13.5 },
    { code: '3010', name: '雪碧', price: 9.5 },
  ];
  assert.equal(effectiveDiscount(c, 23, items), 13.5);
});

test('effectiveDiscount: 兑换券在组合中没有适用商品时不抵扣', () => {
  const c = normalizeCoupon(REAL_COUPON);
  assert.equal(effectiveDiscount(c, 20, [{ code: '3010', price: 9.5 }]), 0);
});

test('effectiveDiscount: 原始券对象（未归一化）也能识别兑换券', () => {
  assert.equal(
    effectiveDiscount(REAL_COUPON, 23, [{ code: '9900014239', price: 13.5 }]),
    13.5,
  );
});

test('pickBestCoupon: 兑换券与满减券同场竞争时取应付更低者', () => {
  const now = toEpoch('2026-10-09T18:00:00+08:00');
  const items = [
    { code: '9900014239', name: '麦旋风任选1', price: 13.5 },
    { code: '3010', name: '雪碧', price: 9.5 },
  ];
  const best = pickBestCoupon(
    [REAL_COUPON, { couponId: 'a', title: '满20减5', discount: 5, minSpend: 20, expireAt: '2026-10-20T00:00:00+08:00' }],
    23,
    now,
    items,
  );
  assert.equal(best.coupon.couponId, REAL_COUPON.couponId);
  assert.equal(best.discount, 13.5);
});

test('buildPlans: 真实兑换券能生成方案并带出到期紧迫度', () => {
  const result = buildPlans({
    ...DEMO_INPUT,
    now: '2026-10-09T18:00:00+08:00',
    departTime: '2026-10-09T18:00:00+08:00',
    travelMinutes: 0,
    budget: 60,
    maxCalories: 2000,
    preference: '',
    meals: [
      { code: '9900014239', name: '麦旋风任选1', category: '甜品', price: 13.5, calories: 300, prepMinutes: 2, windows: ['dinner'] },
      { code: '3010', name: '雪碧', category: '饮品', price: 9.5, calories: 130, prepMinutes: 1, windows: ['dinner'] },
    ],
    coupons: [normalizeCoupon(REAL_COUPON)],
  });
  const withCoupon = result.plans.filter((p) => p.discount > 0);
  assert.ok(withCoupon.length > 0, '应至少有一个方案用上了兑换券');
  assert.ok(withCoupon.every((p) => p.couponUrgency.tier === 'critical'));
});

// ---------------------------------------------------------------- 兑换券品类提示

test('deriveVoucherCategory: 从「任选N」商品名推导品类', () => {
  assert.equal(deriveVoucherCategory(['麦旋风任选1']), '麦旋风');
  assert.equal(deriveVoucherCategory(['薯薯任选']), '薯薯');
  assert.equal(deriveVoucherCategory(['纯商品名']), '纯商品名');
  assert.equal(deriveVoucherCategory([]), null);
  assert.equal(deriveVoucherCategory(null), null);
});

test('normalizeCoupon: 兑换券带上品类提示字段', () => {
  const c = normalizeCoupon(REAL_COUPON);
  assert.equal(c.voucherCategory, '麦旋风');
  assert.deepEqual(c.productNames, ['麦旋风任选1']);
});

test('findVoucherHints: 编码未命中但品类名匹配时给出候选', () => {
  const coupons = [
    normalizeCoupon({
      title: '麦旋风任选',
      couponId: 'v1',
      tradeDateTime: '2026-10-05 10:30:00-2026-10-09 23:59:59',
      products: [{ productCode: '9900014239', productName: '麦旋风任选1' }],
    }),
  ];
  const items = [
    { code: '9900008754', name: '经典麦旋风', price: 15.5 },
    { code: '3010', name: '雪碧', price: 9.5 },
  ];
  const hints = findVoucherHints(coupons, items);
  assert.equal(hints.length, 1);
  assert.equal(hints[0].category, '麦旋风');
  assert.deepEqual(hints[0].candidates, ['经典麦旋风']);
});

test('findVoucherHints: 编码已精确命中时不再提示', () => {
  const coupons = [normalizeCoupon(REAL_COUPON)];
  const items = [{ code: '9900014239', name: '麦旋风任选1', price: 13.5 }];
  assert.deepEqual(findVoucherHints(coupons, items), []);
});

test('findVoucherHints: 品类无匹配商品时不提示', () => {
  const coupons = [normalizeCoupon(REAL_COUPON)];
  assert.deepEqual(findVoucherHints(coupons, [{ code: 'x', name: '雪碧', price: 9.5 }]), []);
});

test('buildPlans: 品类任选券只提示不抵扣', () => {
  const result = buildPlans({
    ...DEMO_INPUT,
    now: '2026-10-09T18:00:00+08:00',
    departTime: '2026-10-09T18:00:00+08:00',
    travelMinutes: 0,
    preference: '',
    budget: 60,
    maxCalories: 2000,
    meals: [
      { code: '9900008754', name: '经典麦旋风', category: '甜品', price: 15.5, calories: 266, prepMinutes: 2 },
      { code: '3010', name: '雪碧', category: '饮品', price: 9.5, calories: 130, prepMinutes: 1 },
    ],
    coupons: [normalizeCoupon(REAL_COUPON)],
  });
  assert.ok(result.notes.some((n) => n.includes('品类任选券') && n.includes('经典麦旋风')));
  assert.ok(result.plans.every((p) => p.discount === 0), '未确认的品类券不得自动抵扣');
});

// ---------------------------------------------------------------- 类别硬约束

test('buildPlans: requireCategory 保证每个方案都含指定类别', () => {
  const result = buildPlans({ ...DEMO_INPUT, preference: '', requireCategory: '套餐' });
  assert.ok(result.plans.length > 0);
  for (const p of result.plans) {
    assert.ok(p.items.some((i) => i.category === '套餐'), '每个方案都应含套餐');
  }
});

test('buildPlans: 无方案满足类别约束时返回空并说明', () => {
  const result = buildPlans({ ...DEMO_INPUT, preference: '', requireCategory: '不存在的类别' });
  assert.equal(result.plans.length, 0);
  assert.ok(result.notes.some((n) => n.includes('不存在的类别')));
});

test('buildPlans: 不加约束时允许出现纯零食方案（对照）', () => {
  const withOut = buildPlans({ ...DEMO_INPUT, preference: '' });
  assert.ok(withOut.plans.length > 0);
});

// ---------------------------------------------------------------- 常量一致性

test('默认评分权重之和为 1，保持四维可比', () => {
  const sum = DEFAULT_WEIGHTS.price + DEFAULT_WEIGHTS.calories + DEFAULT_WEIGHTS.wait + DEFAULT_WEIGHTS.expiry;
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test('URGENCY_TIERS: 档位阈值单调递增', () => {
  for (let i = 1; i < URGENCY_TIERS.length; i += 1) {
    assert.ok(URGENCY_TIERS[i].maxDays > URGENCY_TIERS[i - 1].maxDays);
  }
});
