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
