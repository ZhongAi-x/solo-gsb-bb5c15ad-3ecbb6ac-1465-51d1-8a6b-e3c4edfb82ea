'use strict';

/* 跨道具补签计划引擎单元测试：node test/resign-plan.test.js */

const assert = require('assert');
const { planResign, MAX_QUOTA } = require('../src/resign-plan');
const { recordHash, applySignoff } = require('../src/signoff');
const { WAREHOUSE } = require('../src/verify');

let seq = 0;
const t = (n) => 1000 + n;

function mkProp(id, name) {
  return { id, name: name || id, note: '', createdAt: t(seq++) };
}
function mkData(props, records, signoffs = []) {
  return { props, records, signoffs };
}
function rec(propId, minute, from, to, id, note = '') {
  return { id, propId, minute, from, to, note, createdAt: t(seq++) };
}
/** 用引擎给一条记录签收指定一侧（模拟服务端流程） */
function sign(data, recordId, side) {
  const record = data.records.find((r) => r.id === recordId);
  data.signoffs = applySignoff(data, recordId, side, record[side], recordHash(record)).signoffs;
}
function signBoth(data, recordId) {
  sign(data, recordId, 'from');
  sign(data, recordId, 'to');
}

let passed = 0;
function test(name, fn) {
  seq = 0;
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// 1. 单道具：从已核实前缀起连续补齐，额度限制延伸长度
test('单道具：缺两侧每条耗 2 次，额度限制连续延伸长度', () => {
  const data = mkData([mkProp('pa', '剑')], [
    rec('pa', 0, WAREHOUSE, '张三', 'r1'),
    rec('pa', 3, '张三', '李四', 'r2'),
    rec('pa', 8, '李四', WAREHOUSE, 'r3'),
  ]);
  const r = planResign(data, 12, 4);
  assert.strictEqual(r.summary.newVerifiedTotal, 2); // 每条耗 2，额度 4 -> 延伸 2 条
  assert.strictEqual(r.summary.signoffTotal, 4);
  assert.strictEqual(r.summary.pendingTotal, 4);
  assert.strictEqual(r.props.length, 1);
  assert.strictEqual(r.props[0].newVerified, 2);
  assert.strictEqual(r.props[0].verifiedPrefix, 0);
  assert.strictEqual(r.props[0].plannable, 3);
  assert.deepStrictEqual(r.props[0].records.map((x) => x.id), ['r1', 'r2']); // 连续前缀，不跳过
  assert.deepStrictEqual(
    r.pending.map((e) => [e.recordId, e.side, e.name]),
    [['r1', 'from', WAREHOUSE], ['r1', 'to', '张三'], ['r2', 'from', '张三'], ['r2', 'to', '李四']]
  );
});

// 2. 已有有效签收构成已核实前缀，不耗额度
test('已核实前缀不耗额度，只规划前缀之后的缺签记录', () => {
  const data = mkData([mkProp('pa', '剑')], [
    rec('pa', 0, WAREHOUSE, '张三', 'r1'),
    rec('pa', 3, '张三', '李四', 'r2'),
    rec('pa', 8, '李四', WAREHOUSE, 'r3'),
  ]);
  signBoth(data, 'r1');
  const r = planResign(data, 12, 2);
  assert.strictEqual(r.props[0].verifiedPrefix, 1);
  assert.strictEqual(r.summary.newVerifiedTotal, 1);
  assert.strictEqual(r.summary.signoffTotal, 2);
  assert.deepStrictEqual(r.pending.map((e) => e.recordId), ['r2', 'r2']);
});

// 3. 延伸区内双方已签的记录不耗额度，但前缀延伸经过后计入新增
test('延伸区内已双方签收的记录：不耗额度但计入新增已核实', () => {
  const data = mkData([mkProp('pa', '剑')], [
    rec('pa', 0, WAREHOUSE, '张三', 'r1'),
    rec('pa', 3, '张三', '李四', 'r2'),
    rec('pa', 8, '李四', WAREHOUSE, 'r3'),
  ]);
  signBoth(data, 'r2'); // r2 已签但被未签的 r1 阻断，不计入当前已核实前缀
  const r = planResign(data, 12, 2);
  assert.strictEqual(r.props[0].verifiedPrefix, 0);
  assert.strictEqual(r.summary.newVerifiedTotal, 2); // r1（耗 2）+ r2（耗 0）
  assert.strictEqual(r.summary.signoffTotal, 2);
  assert.deepStrictEqual(r.props[0].records.map((x) => [x.id, x.cost]), [['r1', 2], ['r2', 0]]);
  assert.deepStrictEqual(r.pending.map((e) => [e.recordId, e.side]), [['r1', 'from'], ['r1', 'to']]);
});

// 4. 缺一侧只耗一次
test('一条记录缺一侧耗 1 次', () => {
  const data = mkData([mkProp('pa', '剑')], [
    rec('pa', 0, WAREHOUSE, '张三', 'r1'),
    rec('pa', 3, '张三', '李四', 'r2'),
  ]);
  sign(data, 'r1', 'from'); // 交出者已签，只缺接收者
  const r = planResign(data, 12, 1);
  assert.strictEqual(r.summary.newVerifiedTotal, 1);
  assert.strictEqual(r.summary.signoffTotal, 1);
  assert.deepStrictEqual(r.pending, [{
    propId: 'pa', propName: '剑', recordId: 'r1', minute: 0,
    from: WAREHOUSE, to: '张三', side: 'to', name: '张三',
  }]);
});

// 5. 原链首个冲突之后的记录不得规划（歧义冲突）
test('歧义冲突：冲突及之后的记录不参与规划', () => {
  const data = mkData([mkProp('pa', '扇')], [
    rec('pa', 1, WAREHOUSE, '张三', 'r1'),
    rec('pa', 5, '张三', '王五', 'r2'),
    rec('pa', 5, '张三', '赵六', 'r3'), // 第 5 分钟多条可接续
  ]);
  signBoth(data, 'r1'); // 冲突前的记录已双方签收
  const r = planResign(data, 12, MAX_QUOTA);
  assert.strictEqual(r.summary.newVerifiedTotal, 0);
  assert.strictEqual(r.summary.plannableProps, 0); // 冲突记录不在重放链内，无可规划延伸
  assert.deepStrictEqual(r.pending, []);
});

// 6. 断链：冲突前的缺签记录可规划，冲突及之后不行
test('断链冲突：冲突前的缺签记录可规划，冲突及之后不行', () => {
  const data = mkData([mkProp('pa', '灯')], [
    rec('pa', 2, WAREHOUSE, '王五', 'r1'),
    rec('pa', 4, '李四', '钱七', 'r2'), // 断链：当前持有人是王五
    rec('pa', 9, '钱七', WAREHOUSE, 'r3'),
  ]);
  const r = planResign(data, 12, MAX_QUOTA);
  assert.strictEqual(r.summary.newVerifiedTotal, 1);
  assert.strictEqual(r.summary.signoffTotal, 2);
  assert.strictEqual(r.props[0].plannable, 1); // 只有冲突前的 r1 可规划
  assert.deepStrictEqual(r.props[0].conflict, { type: 'BROKEN', minute: 4 });
  assert.deepStrictEqual(r.pending.map((e) => e.recordId), ['r1', 'r1']);
});

// 7. 截止分钟（含）之外的记录不参与
test('截止分钟之外的记录不参与规划', () => {
  const data = mkData([mkProp('pa', '剑')], [
    rec('pa', 0, WAREHOUSE, '张三', 'r1'),
    rec('pa', 3, '张三', '李四', 'r2'),
    rec('pa', 8, '李四', WAREHOUSE, 'r3'),
  ]);
  const r = planResign(data, 3, MAX_QUOTA);
  assert.strictEqual(r.props[0].plannable, 2);
  assert.strictEqual(r.summary.newVerifiedTotal, 2);
  assert.deepStrictEqual(r.pending.map((e) => e.recordId), ['r1', 'r1', 'r2', 'r2']);
});

// 8. 跨道具：额度优先使新增总数最大
test('跨道具选择：新增已核实总数最大', () => {
  const data = mkData([mkProp('pa', '剑'), mkProp('pb', '扇')], [
    rec('pa', 0, WAREHOUSE, '甲', 'a1'),               // 缺两侧，耗 2
    rec('pb', 1, WAREHOUSE, '乙', 'b1'),               // 交出者已签，耗 1
  ]);
  sign(data, 'b1', 'from');
  const r = planResign(data, 12, 2);
  // pa 延伸 1 条耗 2，pb 延伸 1 条耗 1；额度 2 时二者不可兼得，最大总数都是 1
  assert.strictEqual(r.summary.newVerifiedTotal, 1);
  // 同收益取补签次数更少：选 pb（耗 1）而非 pa（耗 2）
  assert.strictEqual(r.summary.signoffTotal, 1);
  assert.strictEqual(r.props.find((p) => p.propId === 'pa').newVerified, 0);
  assert.strictEqual(r.props.find((p) => p.propId === 'pb').newVerified, 1);
  assert.deepStrictEqual(r.pending.map((e) => [e.propId, e.recordId, e.side]), [['pb', 'b1', 'to']]);
});

// 9. 同收益同次数：按道具ID取字典序最小
test('同收益同次数：待签列表按道具ID字典序最小', () => {
  const data = mkData([mkProp('pa', '甲道具'), mkProp('pb', '乙道具')], [
    rec('pa', 0, WAREHOUSE, '甲', 'a1'),
    rec('pb', 1, WAREHOUSE, '乙', 'b1'),
  ]);
  sign(data, 'a1', 'from');
  sign(data, 'b1', 'from'); // 两件道具延伸 1 条都耗 1，额度只够一件
  const r = planResign(data, 12, 1);
  assert.strictEqual(r.summary.newVerifiedTotal, 1);
  assert.strictEqual(r.summary.signoffTotal, 1);
  assert.deepStrictEqual(r.pending.map((e) => e.propId), ['pa']); // pa < pb
  assert.strictEqual(r.props.find((p) => p.propId === 'pa').newVerified, 1);
  assert.strictEqual(r.props.find((p) => p.propId === 'pb').newVerified, 0);
});

// 10. 字典序：集中于小ID道具的延伸优先于分散到多道具
test('字典序：同等收益与次数下集中延伸小ID道具', () => {
  const data = mkData([mkProp('pa', '甲道具'), mkProp('pb', '乙道具')], [
    rec('pa', 0, WAREHOUSE, '甲', 'a1'),
    rec('pa', 3, '甲', '乙', 'a2'),
    rec('pb', 1, WAREHOUSE, '丙', 'b1'),
  ]);
  sign(data, 'a1', 'from');
  sign(data, 'a2', 'from');
  sign(data, 'b1', 'from'); // 每条记录都只缺接收者，耗 1
  const r = planResign(data, 12, 2);
  // 方案一：pa 延伸 2 条（a1、a2）；方案二：pa 延伸 a1 + pb 延伸 b1。收益都是 2、次数都是 2。
  // 待签列表 [(pa,a1),(pa,a2)] < [(pa,a1),(pb,b1)]，取方案一
  assert.strictEqual(r.summary.newVerifiedTotal, 2);
  assert.strictEqual(r.summary.signoffTotal, 2);
  assert.strictEqual(r.props.find((p) => p.propId === 'pa').newVerified, 2);
  assert.strictEqual(r.props.find((p) => p.propId === 'pb').newVerified, 0);
  assert.deepStrictEqual(r.pending.map((e) => [e.propId, e.recordId]), [['pa', 'a1'], ['pa', 'a2']]);
});

// 11. 记录被编辑后旧签收失效，按未签计入成本
test('记录编辑后旧签收（指纹不符）失效，重新计入补签成本', () => {
  const data = mkData([mkProp('pa', '剑')], [
    rec('pa', 0, WAREHOUSE, '张三', 'r1'),
    rec('pa', 3, '张三', '李四', 'r2'),
  ]);
  signBoth(data, 'r1');
  data.records = data.records.map((x) => (x.id === 'r1' ? { ...x, note: '改过的备注' } : x));
  const r = planResign(data, 12, MAX_QUOTA);
  assert.strictEqual(r.props[0].verifiedPrefix, 0); // r1 旧签收失效，前缀退回 0
  assert.strictEqual(r.summary.signoffTotal, 4); // r1 需重新双方签收
  assert.deepStrictEqual(r.pending.map((e) => e.recordId), ['r1', 'r1', 'r2', 'r2']);
});

// 12. 额度 0 -> 空计划
test('补签额度为 0：空计划', () => {
  const data = mkData([mkProp('pa', '剑')], [rec('pa', 0, WAREHOUSE, '张三', 'r1')]);
  const r = planResign(data, 12, 0);
  assert.strictEqual(r.summary.newVerifiedTotal, 0);
  assert.strictEqual(r.summary.signoffTotal, 0);
  assert.strictEqual(r.summary.plannableProps, 1); // 有可规划记录，但额度不足
  assert.strictEqual(r.props[0].newVerified, 0);
  assert.deepStrictEqual(r.pending, []);
});

// 13. 窗口内全部已核实 -> 无可规划
test('窗口内记录均已核实：无可规划延伸', () => {
  const data = mkData([mkProp('pa', '剑')], [
    rec('pa', 0, WAREHOUSE, '张三', 'r1'),
    rec('pa', 3, '张三', WAREHOUSE, 'r2'),
  ]);
  signBoth(data, 'r1');
  signBoth(data, 'r2');
  const r = planResign(data, 12, MAX_QUOTA);
  assert.strictEqual(r.summary.newVerifiedTotal, 0);
  assert.strictEqual(r.summary.plannableProps, 0);
  assert.deepStrictEqual(r.props, []);
  assert.deepStrictEqual(r.pending, []);
});

// 14. 同分钟链式记录：待签列表按（分钟、记录ID、签收方）排序，而非重放顺序
test('同分钟链式：待签列表按记录ID排序', () => {
  const data = mkData([mkProp('pa', '剑')], [
    rec('pa', 5, WAREHOUSE, '甲', 'r_z'), // 先录入，重放时先接续
    rec('pa', 5, '甲', '乙', 'r_a'),      // 同分钟链式第二棒
  ]);
  const r = planResign(data, 12, MAX_QUOTA);
  assert.strictEqual(r.summary.newVerifiedTotal, 2);
  assert.deepStrictEqual(
    r.pending.map((e) => [e.recordId, e.side]),
    [['r_a', 'from'], ['r_a', 'to'], ['r_z', 'from'], ['r_z', 'to']] // 'r_a' < 'r_z'
  );
});

// 15. 多道具汇总：各道具新增长度与待签姓名
test('多道具计划：各道具新增长度与待签姓名汇总', () => {
  const data = mkData([mkProp('pa', '剑'), mkProp('pb', '印')], [
    rec('pa', 0, WAREHOUSE, '张三', 'a1'),
    rec('pb', 1, WAREHOUSE, '周八', 'b1'),
    rec('pb', 6, '周八', '孙七', 'b2'),
  ]);
  const r = planResign(data, 12, 6);
  assert.strictEqual(r.summary.newVerifiedTotal, 3);
  assert.strictEqual(r.summary.signoffTotal, 6);
  assert.strictEqual(r.summary.propsWithExtension, 2);
  assert.strictEqual(r.props.find((p) => p.propId === 'pa').newVerified, 1);
  assert.strictEqual(r.props.find((p) => p.propId === 'pb').newVerified, 2);
  // 待签姓名 = 该侧角色本人
  assert.deepStrictEqual(
    r.pending.map((e) => e.name),
    [WAREHOUSE, '张三', WAREHOUSE, '周八', '周八', '孙七']
  );
});

// 16. 额度上限常量
test('补签额度上限为 12 次', () => {
  assert.strictEqual(MAX_QUOTA, 12);
});

console.log(`\n全部 ${passed} 个跨道具补签计划引擎测试通过 ✔`);
