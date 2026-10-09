#!/usr/bin/env node
/**
 * 麦麦通勤点单官 · 券与积分到期救援
 * ------------------------------------------------------------------
 * 把「我的券」「我的积分」按剩余有效期分档，输出核销优先级清单。
 *
 * 设计出发点：优惠券与积分是「会折旧的资产」。多数工具只回答
 * 「我有哪些券」，本模块回答「先花哪一张、哪张不花就亏了」。
 *
 * 时间工具复用 plan-commute-order.mjs，避免重复实现。
 *
 * 用法：
 *   node scripts/coupon-deadline-rescue.mjs --demo
 *   node scripts/coupon-deadline-rescue.mjs --input wallet.json
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { toEpoch, daysUntil, formatBeijing, effectiveDiscount } from './plan-commute-order.mjs';

/** 分档阈值（剩余天数下限、上限），从左到右依次判定 */
export const RESCUE_TIERS = [
  { key: 'expired', label: '已过期', min: -Infinity, max: 0, advice: '已失效，可忽略；如需确认请联系门店核销记录。' },
  { key: 'critical', label: '今天 / 明天到期', min: 0, max: 2, advice: '最高优先级：下一餐优先使用。' },
  { key: 'urgent', label: '3 天内到期', min: 2, max: 3, advice: '高优先级：安排在本周内用掉。' },
  { key: 'soon', label: '一周内到期', min: 3, max: 7, advice: '中优先级：留意搭配门槛，别为了用券凑单。' },
  { key: 'normal', label: '有效期充裕', min: 7, max: Infinity, advice: '低优先级：留着搭配更高门槛的订单。' },
];

export function tierOf(coupon, nowEpochMs) {
  if (!coupon.expireAt) return { ...RESCUE_TIERS.at(-1), days: Infinity };
  const days = daysUntil(toEpoch(coupon.expireAt), nowEpochMs);
  const hit = RESCUE_TIERS.find((t) => days > t.min && days <= t.max) || RESCUE_TIERS.at(-1);
  return { ...hit, days };
}

/**
 * 构建核销优先级清单。
 * 排序依据：① 先按到期紧迫度分档 ② 档内按「券面价值」降序
 * 券面价值用「满足门槛时的实际抵扣额」估算，门槛越高价值越高。
 */
export function buildRescueList(wallet) {
  const { now, coupons = [], account = {} } = wallet;
  const nowEpoch = toEpoch(now);

  const rows = coupons.map((coupon) => {
    const tier = tierOf(coupon, nowEpoch);
    const minSpend = Number(coupon.minSpend || 0);
    const value = coupon.discount != null
      ? Number(coupon.discount)
      : effectiveDiscount(coupon, minSpend || Number(coupon.discountCap || 0));
    return {
      coupon,
      tier,
      minSpend,
      value,
      /** 单位门槛价值：衡量「凑单效率」，数值越高越划算 */
      efficiency: minSpend > 0 ? Number((value / minSpend).toFixed(3)) : 1,
    };
  });

  const tierOrder = new Map(RESCUE_TIERS.map((t, i) => [t.key, i]));
  rows.sort((a, b) => {
    const ta = tierOrder.get(a.tier.key) ?? 99;
    const tb = tierOrder.get(b.tier.key) ?? 99;
    if (ta !== tb) return ta - tb;
    if (b.value !== a.value) return b.value - a.value;
    return a.tier.days - b.tier.days;
  });

  const points = {
    available: Number(account.availablePoints || 0),
    expiring: Number(account.expiringPoints || 0),
    expiringAt: account.pointsExpireAt || null,
  };
  if (points.expiringAt) {
    points.daysLeft = daysUntil(toEpoch(points.expiringAt), nowEpoch);
  }

  return { now: nowEpoch, rows, points };
}

export function renderRescue(result) {
  const out = [];
  out.push('=== 麦麦通勤点单官 · 券与积分到期救援 ===');
  out.push(`基准时间  ${formatBeijing(result.now)}`);
  out.push('');

  const grouped = new Map();
  for (const row of result.rows) {
    if (!grouped.has(row.tier.key)) grouped.set(row.tier.key, []);
    grouped.get(row.tier.key).push(row);
  }

  if (!result.rows.length) {
    out.push('没有查询到可用优惠券。');
  }

  for (const tier of RESCUE_TIERS) {
    const list = grouped.get(tier.key);
    if (!list || !list.length) continue;
    out.push(`【${tier.label}】${list.length} 张`);
    for (const row of list) {
      const days = Number.isFinite(row.tier.days) ? `剩余 ${row.tier.days.toFixed(1)} 天` : '无到期日';
      out.push(
        `  · ${row.coupon.title}　抵扣 ¥${row.value.toFixed(2)}　门槛 ¥${row.minSpend.toFixed(2)}　${days}`,
      );
      if (row.efficiency < 0.2 && row.minSpend > 0) {
        out.push('      注意：抵扣额相对门槛偏低，不建议为用券而凑单。');
      }
    }
    out.push(`  建议：${tier.advice}`);
    out.push('');
  }

  if (result.points.available || result.points.expiring) {
    out.push('【积分账户】');
    out.push(`  可用积分  ${result.points.available}`);
    if (result.points.expiring) {
      out.push(
        `  即将过期  ${result.points.expiring} 分${
          Number.isFinite(result.points.daysLeft) ? `（剩余 ${result.points.daysLeft.toFixed(1)} 天）` : ''
        }`,
      );
    }
    out.push('');
  }

  const urgent = result.rows.filter((r) => r.tier.key === 'critical');
  if (urgent.length) {
    out.push(`最优先：${urgent.map((r) => r.coupon.title).join('、')} —— 这两天内用掉。`);
  }
  out.push('本清单仅为核销建议，不构成消费建议；券的实际可用范围以麦当劳官方渠道为准。');
  return out.join('\n');
}

export const DEMO_WALLET = {
  now: '2026-10-10T08:15:00+08:00',
  coupons: [
    { couponId: 'C-001', title: '通勤专享 满20减12', discount: 12, minSpend: 20, expireAt: '2026-10-11T23:59:00+08:00' },
    { couponId: 'C-002', title: '饮品立减3元', discount: 3, minSpend: 10, expireAt: '2026-10-20T23:59:00+08:00' },
    { couponId: 'C-003', title: '满30减8', discount: 8, minSpend: 30, expireAt: '2026-10-15T23:59:00+08:00' },
    { couponId: 'C-004', title: '新客满50减5', discount: 5, minSpend: 50, expireAt: '2026-10-13T23:59:00+08:00' },
    { couponId: 'C-005', title: '已过期券', discount: 6, minSpend: 15, expireAt: '2026-10-08T23:59:00+08:00' },
  ],
  account: {
    availablePoints: 1860,
    expiringPoints: 420,
    pointsExpireAt: '2026-10-14T23:59:00+08:00',
  },
};

function main(argv) {
  const args = new Set(argv.slice(2));
  const asJson = args.has('--json');
  let wallet = DEMO_WALLET;

  const inputFlag = argv.indexOf('--input');
  if (inputFlag !== -1) {
    const file = argv[inputFlag + 1];
    if (!file) {
      console.error('用法：--input <wallet.json>');
      process.exit(2);
    }
    wallet = JSON.parse(readFileSync(file, 'utf8'));
  }

  const result = buildRescueList(wallet);
  console.log(asJson ? JSON.stringify(result, null, 2) : renderRescue(result));
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main(process.argv);
}
