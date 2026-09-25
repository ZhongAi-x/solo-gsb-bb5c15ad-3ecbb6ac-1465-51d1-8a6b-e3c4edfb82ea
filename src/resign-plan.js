'use strict';

/**
 * 跨道具补签计划引擎（只读，不改写任何数据）。
 *
 * 输入截止分钟（含）与补签额度（最多 MAX_QUOTA 次），在全部道具间规划
 * 「补签哪些记录的哪一侧」，使新增的已核实记录总数最大：
 *
 * 1. 每件道具沿现有同分钟唯一链重放截止分钟及以前的记录，并逐条校验签收内容指纹
 *    （指纹不符的旧签收视为无效）；原链首个冲突之后的记录一律不参与规划。
 * 2. 每件道具只允许从当前已核实前缀（重放顺序上双方均有效签收的最长前缀）起
 *    连续向后补齐：延伸第 1 条缺签记录后才可能延伸其后的记录。
 * 3. 一条记录缺两侧签收就消耗两次额度，缺一侧消耗一次；已有有效签收的一侧不耗额度
 *    （延伸区内双方均已签收的记录不耗额度，但前缀延伸经过它后同样计入新增已核实）。
 * 4. 跨道具选择各道具的延伸长度：先使新增已核实记录总数最大；同收益取补签总次数
 *    更少的方案；仍并列时，按（道具ID、记录分钟、记录ID、签收方）排序的待签列表
 *    取字典序最小。
 */

const { WAREHOUSE, sortRecords, replayPropRecords } = require('./verify');
const { signoffView } = require('./signoff');

/** 单次计划最多可使用的补签次数 */
const MAX_QUOTA = 12;

function cmpStr(a, b) {
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** 待签条目排序键：道具ID、记录分钟、记录ID、签收方 */
function cmpPending(a, b) {
  return (
    cmpStr(a.propId, b.propId) ||
    a.minute - b.minute ||
    cmpStr(a.recordId, b.recordId) ||
    cmpStr(a.side, b.side)
  );
}

/** 合并整数区间（相邻可并：[0,2] 与 [3,5] 并为 [0,5]，收益均为整数） */
function mergeIntervals(list) {
  const sorted = [...list].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged = [];
  for (const [a, b] of sorted) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

/**
 * 可达性 DP：在每件道具延伸长度 j ∈ [lo, hi] 的约束下，返回
 * Map<补签次数, 可达新增已核实数区间列表>。
 * 一件道具的累计成本随延伸长度非递减，同一成本对应连续的一段长度，
 * 因此每个成本的可达收益可压缩为若干区间；收益超过 gainCap 的部分截断。
 */
function reachableCosts(propPlans, lo, hi, costCap, gainCap, startIdx = 0) {
  let reach = new Map([[0, [[0, 0]]]]);
  for (let pi = startIdx; pi < propPlans.length; pi += 1) {
    const p = propPlans[pi];
    // 该道具的选项按成本分组：{ cost, g1, g2 } 表示延伸长度 j ∈ [g1, g2] 均消耗 cost 次
    const groups = [];
    for (let j = lo[pi]; j <= hi[pi]; j += 1) {
      const c = p.cumCost[j];
      if (c > costCap) break; // 累计成本非递减，之后的选项更贵
      const last = groups[groups.length - 1];
      if (last && last.cost === c) last.g2 = j;
      else groups.push({ cost: c, g1: j, g2: j });
    }
    const next = new Map();
    for (const [c0, intervals] of reach) {
      for (const [a, b] of intervals) {
        for (const g of groups) {
          const nc = c0 + g.cost;
          if (nc > costCap) continue;
          const na = Math.min(a + g.g1, gainCap);
          const nb = Math.min(b + g.g2, gainCap);
          if (!next.has(nc)) next.set(nc, []);
          next.get(nc).push([na, nb]);
        }
      }
    }
    reach = new Map([...next].map(([c, list]) => [c, mergeIntervals(list)]));
  }
  return reach;
}

/** 可达集合中是否包含 (gain, cost) */
function reachableHas(reach, gain, cost) {
  const intervals = reach.get(cost);
  return !!intervals && intervals.some(([a, b]) => a <= gain && gain <= b);
}

/**
 * 计算跨道具补签计划（纯计算，不落盘）。
 *
 * @param {{props: Array, records: Array, signoffs: Array}} data 当前数据（只读）
 * @param {number} cutoffMinute 截止分钟（含）
 * @param {number} quota 补签额度（0..MAX_QUOTA）
 */
function planResign(data, cutoffMinute, quota) {
  // 道具按 ID 排序，保证全程（DP、字典序、重建、输出）确定性一致
  const props = [...(data.props || [])].sort((a, b) => cmpStr(a.id, b.id));
  const records = data.records || [];
  const signoffs = data.signoffs || [];

  // 1. 逐件道具重放：已核实前缀 + 可规划延伸区（首个冲突之后的记录不参与）
  const propPlans = [];
  for (const prop of props) {
    const propRecords = sortRecords(
      records.filter((r) => r.propId === prop.id && Number(r.minute) <= cutoffMinute)
    );
    if (propRecords.length === 0) continue;
    const replay = replayPropRecords(propRecords);
    const chain = replay.chain; // 重放链在首个冲突处截断，冲突及之后的记录不得规划
    const views = chain.map((rec) => signoffView(rec, signoffs));

    let prefix = 0;
    while (prefix < chain.length && views[prefix].from && views[prefix].to) prefix += 1;

    const zone = [];
    for (let i = prefix; i < chain.length; i += 1) {
      const missingSides = [];
      if (!views[i].from) missingSides.push('from');
      if (!views[i].to) missingSides.push('to');
      zone.push({ record: chain[i], missingSides, cost: missingSides.length });
    }
    if (zone.length === 0) continue; // 窗口内记录均已核实（或冲突前无可延伸），无可规划

    // 延伸前 j 条的累计补签成本（非递减）
    const cumCost = [0];
    for (let i = 0; i < zone.length; i += 1) cumCost.push(cumCost[i] + zone[i].cost);
    let maxJ = 0;
    while (maxJ < zone.length && cumCost[maxJ + 1] <= quota) maxJ += 1;

    propPlans.push({
      prop,
      prefix,
      zone,
      cumCost,
      maxJ,
      conflict: replay.ok ? null : { type: replay.conflict.type, minute: replay.conflict.minute },
    });
  }

  // 2. 全局最优：新增已核实总数最大 -> 同收益补签次数最少
  const totalZone = propPlans.reduce((s, p) => s + p.zone.length, 0);
  const lo = propPlans.map(() => 0);
  const hi = propPlans.map((p) => p.maxJ);
  const reachAll = reachableCosts(propPlans, lo, hi, quota, totalZone);
  let bestGain = 0;
  for (const intervals of reachAll.values()) {
    for (const [, b] of intervals) bestGain = Math.max(bestGain, b);
  }
  let bestCost = 0;
  for (let c = 0; c <= quota; c += 1) {
    if (reachableHas(reachAll, bestGain, c)) {
      bestCost = c;
      break;
    }
  }

  // 3. 字典序最小的待签列表：按（道具ID、记录分钟、记录ID、签收方）逐条决定取舍——
  //    若某条目纳入后仍存在达到 (bestGain, bestCost) 的方案则纳入，否则排除。
  //    一条记录被纳入即包含其全部缺签侧（延伸长度覆盖该记录）。
  const candidates = [];
  propPlans.forEach((p, pi) => {
    for (let i = 0; i < p.maxJ; i += 1) {
      const z = p.zone[i];
      for (const side of z.missingSides) {
        candidates.push({
          pi,
          pos: i + 1, // 选择该记录所需的延伸长度
          side,
          propId: p.prop.id,
          minute: z.record.minute,
          recordId: z.record.id,
        });
      }
    }
  });
  candidates.sort(cmpPending);

  const feasible = () =>
    reachableHas(reachableCosts(propPlans, lo, hi, bestCost, bestGain), bestGain, bestCost);
  for (const e of candidates) {
    if (e.pos <= lo[e.pi] || e.pos > hi[e.pi]) continue; // 取舍已被之前的决定锁定
    const oldLo = lo[e.pi];
    lo[e.pi] = e.pos; // 尝试纳入：该道具延伸长度至少覆盖该记录
    if (feasible()) continue;
    lo[e.pi] = oldLo;
    hi[e.pi] = Math.min(hi[e.pi], e.pos - 1); // 纳入则达不到最优，排除该记录
  }

  // 4. 在最终约束内重建一组达到最优的延伸长度
  //    （逐道具取可行的最小长度，保证输出确定；同一最优待签列表不变）
  const chosen = propPlans.map(() => 0);
  let remGain = bestGain;
  let remCost = bestCost;
  propPlans.forEach((p, pi) => {
    const suffixReach = reachableCosts(propPlans, lo, hi, bestCost, bestGain, pi + 1);
    for (let j = lo[pi]; j <= hi[pi]; j += 1) {
      const c = p.cumCost[j];
      if (c > remCost || j > remGain) break; // 成本 / 收益随 j 非递减
      if (reachableHas(suffixReach, remGain - j, remCost - c)) {
        chosen[pi] = j;
        remGain -= j;
        remCost -= c;
        break;
      }
    }
  });

  // 5. 汇总输出：各道具新增长度 + 全局待签列表（含待签姓名）
  const propsOut = [];
  const pending = [];
  propPlans.forEach((p, pi) => {
    const j = chosen[pi];
    const planned = [];
    for (let i = 0; i < j; i += 1) {
      const z = p.zone[i];
      planned.push({
        id: z.record.id,
        minute: z.record.minute,
        from: z.record.from,
        to: z.record.to,
        note: z.record.note || '',
        missingSides: z.missingSides,
        cost: z.cost,
      });
      for (const side of z.missingSides) {
        pending.push({
          propId: p.prop.id,
          propName: p.prop.name,
          recordId: z.record.id,
          minute: z.record.minute,
          from: z.record.from,
          to: z.record.to,
          side,
          name: side === 'from' ? z.record.from : z.record.to, // 待签姓名 = 该侧角色本人
        });
      }
    }
    propsOut.push({
      propId: p.prop.id,
      propName: p.prop.name,
      verifiedPrefix: p.prefix,
      plannable: p.zone.length,
      newVerified: j,
      signoffCost: p.cumCost[j],
      conflict: p.conflict,
      records: planned,
    });
  });
  pending.sort(cmpPending);

  return {
    warehouse: WAREHOUSE,
    minute: cutoffMinute,
    quota,
    summary: {
      newVerifiedTotal: bestGain,
      signoffTotal: bestCost,
      pendingTotal: pending.length,
      propsWithExtension: propsOut.filter((p) => p.newVerified > 0).length,
      plannableProps: propPlans.length,
    },
    props: propsOut,
    pending,
  };
}

module.exports = {
  MAX_QUOTA,
  planResign,
};
