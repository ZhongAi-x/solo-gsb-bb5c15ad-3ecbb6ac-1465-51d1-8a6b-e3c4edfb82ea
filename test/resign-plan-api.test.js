'use strict';

/* 跨道具补签计划接口集成测试：node test/resign-plan-api.test.js
 * 使用独立临时数据文件，真实启动服务走 HTTP 全流程。 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'tmp-resign-plan-api-store.json');
process.env.DATA_FILE = DATA_FILE;

for (const f of [DATA_FILE, `${DATA_FILE}.tmp`]) {
  try { fs.unlinkSync(f); } catch { /* 不存在则忽略 */ }
}

const app = require('../server');

let server;
let base;
let passed = 0;

async function api(url, options = {}) {
  const res = await fetch(`${base}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = res.status === 204 ? null : await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** 取记录当前内容指纹并签收指定一侧 */
async function sign(recordId, side, name) {
  const cur = (await api(`/api/records/${recordId}/signoff`)).body;
  return api(`/api/records/${recordId}/signoff`, {
    method: 'POST',
    body: JSON.stringify({ side, name, recordHash: cur.recordHash }),
  });
}
async function signBoth(recordId, from, to) {
  await sign(recordId, 'from', from);
  await sign(recordId, 'to', to);
}

async function main() {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;

  // 初始演示数据：青龙剑 p_sword（r_sw1..r_sw4 完整归仓链）、折扇 p_fan（第5分钟歧义冲突）、
  // 宫灯 p_lantern（断链冲突）、御印 p_seal（未归仓）；初始无任何签收

  // 1. 初始计划：跨道具选择使新增已核实总数最大，同收益取字典序最小待签列表
  await test('补签计划：跨道具最大延伸 + 各道具新增长度 + 待签列表', async () => {
    const revBefore = (await api('/api/state')).body.rev;
    const res = await api('/api/resign-plan?minute=12&quota=12');
    assert.strictEqual(res.status, 200);
    const plan = res.body;
    assert.strictEqual(plan.minute, 12);
    assert.strictEqual(plan.quota, 12);
    // 每条记录缺两侧耗 2 次，额度 12 -> 最多新增 6 条；
    // 字典序最小：p_fan、p_lantern 各 1 条，p_seal 2 条，p_sword 前 2 条
    assert.strictEqual(plan.summary.newVerifiedTotal, 6);
    assert.strictEqual(plan.summary.signoffTotal, 12);
    assert.strictEqual(plan.summary.pendingTotal, 12);
    assert.strictEqual(plan.summary.propsWithExtension, 4);
    assert.strictEqual(plan.summary.plannableProps, 4);
    // 各道具新增长度（按道具ID排序）
    assert.deepStrictEqual(
      plan.props.map((p) => [p.propId, p.newVerified, p.signoffCost]),
      [['p_fan', 1, 2], ['p_lantern', 1, 2], ['p_seal', 2, 4], ['p_sword', 2, 4]]
    );
    // 冲突道具：冲突及之后的记录不规划，并标注冲突
    assert.deepStrictEqual(plan.props[0].conflict, { type: 'AMBIGUOUS', minute: 5 });
    assert.deepStrictEqual(plan.props[1].conflict, { type: 'BROKEN', minute: 4 });
    assert.strictEqual(plan.props[0].plannable, 1); // 折扇只有冲突前的 r_fa1 可规划
    assert.strictEqual(plan.props[3].conflict, null);
    // 待签列表按（道具ID、记录分钟、记录ID、签收方）排序，待签姓名为该侧角色本人
    assert.deepStrictEqual(
      plan.pending.map((e) => [e.propId, e.recordId, e.side, e.name]),
      [
        ['p_fan', 'r_fa1', 'from', '仓库'],
        ['p_fan', 'r_fa1', 'to', '张三'],
        ['p_lantern', 'r_la1', 'from', '仓库'],
        ['p_lantern', 'r_la1', 'to', '王五'],
        ['p_seal', 'r_se1', 'from', '仓库'],
        ['p_seal', 'r_se1', 'to', '周八'],
        ['p_seal', 'r_se2', 'from', '周八'],
        ['p_seal', 'r_se2', 'to', '孙七'],
        ['p_sword', 'r_sw1', 'from', '仓库'],
        ['p_sword', 'r_sw1', 'to', '张三'],
        ['p_sword', 'r_sw2', 'from', '张三'],
        ['p_sword', 'r_sw2', 'to', '李四'],
      ]
    );
    const revAfter = (await api('/api/state')).body.rev;
    assert.strictEqual(revAfter, revBefore); // 只读，不写数据
  });

  // 2. 额度收紧：同收益下取字典序最小的道具组合
  await test('补签计划：额度限制下的字典序最小选择', async () => {
    const res = await api('/api/resign-plan?minute=12&quota=4');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.summary.newVerifiedTotal, 2); // 额度 4 -> 2 条
    assert.strictEqual(res.body.summary.signoffTotal, 4);
    // 所有记录每条耗 2：可任选两件道具各延伸 1 条，字典序最小为 p_fan + p_lantern
    assert.deepStrictEqual(
      res.body.pending.map((e) => e.propId),
      ['p_fan', 'p_fan', 'p_lantern', 'p_lantern']
    );
  });

  // 3. 截止分钟之外的记录不参与
  await test('补签计划：截止分钟之外的记录不规划', async () => {
    const res = await api('/api/resign-plan?minute=3&quota=12');
    assert.strictEqual(res.status, 200);
    // 窗口内：p_sword r_sw1/r_sw2、p_fan r_fa1、p_seal r_se1（p_lantern r_la1 第2分也在）
    const ids = res.body.pending.map((e) => e.recordId);
    assert.ok(!ids.includes('r_sw3') && !ids.includes('r_sw4'));
    assert.ok(!ids.includes('r_se2'));
  });

  // 4. 参数校验：缺参数 / 非法额度 -> 400
  await test('补签计划：参数校验 400', async () => {
    assert.strictEqual((await api('/api/resign-plan?quota=12')).status, 400);
    assert.strictEqual((await api('/api/resign-plan?minute=12')).status, 400);
    assert.strictEqual((await api('/api/resign-plan?minute=-1&quota=12')).status, 400);
    assert.strictEqual((await api('/api/resign-plan?minute=12&quota=-1')).status, 400);
    assert.strictEqual((await api('/api/resign-plan?minute=12&quota=13')).status, 400); // 最多 12 次
    assert.strictEqual((await api('/api/resign-plan?minute=12&quota=abc')).status, 400);
    assert.strictEqual((await api('/api/resign-plan?minute=1.5&quota=12')).status, 400);
  });

  // 5. 实际签收后重新计算：已核实前缀前移，计划随之变化
  await test('实际签收后重新计算：计划随签收状态更新', async () => {
    await signBoth('r_fa1', '仓库', '张三'); // 折扇冲突前唯一记录双方签收
    await signBoth('r_la1', '仓库', '王五'); // 宫灯断链前唯一记录双方签收
    const res = await api('/api/resign-plan?minute=12&quota=12');
    assert.strictEqual(res.status, 200);
    // 折扇 / 宫灯已核实前缀延伸至冲突点，无可规划延伸，退出计划
    assert.strictEqual(res.body.summary.plannableProps, 2);
    assert.deepStrictEqual(
      res.body.props.map((p) => [p.propId, p.verifiedPrefix, p.newVerified]),
      [['p_seal', 0, 2], ['p_sword', 0, 4]]
    );
    // 额度全部投向 p_seal（2 条耗 4）+ p_sword（4 条耗 8）
    assert.strictEqual(res.body.summary.newVerifiedTotal, 6);
    assert.strictEqual(res.body.summary.signoffTotal, 12);
    assert.deepStrictEqual(
      res.body.pending.map((e) => e.propId),
      ['p_seal', 'p_seal', 'p_seal', 'p_seal', 'p_sword', 'p_sword', 'p_sword', 'p_sword',
        'p_sword', 'p_sword', 'p_sword', 'p_sword']
    );
  });

  // 6. 延伸区内已有有效签收的记录不耗额度，但计入新增已核实
  await test('零成本记录：延伸区内已签记录不耗额度但计入新增', async () => {
    await signBoth('r_sw2', '张三', '李四'); // r_sw1 未签，r_sw2 已双方签收但被阻断
    const revBefore = (await api('/api/state')).body.rev;
    const res = await api('/api/resign-plan?minute=12&quota=12');
    assert.strictEqual(res.status, 200);
    const sword = res.body.props.find((p) => p.propId === 'p_sword');
    // r_sw1（耗2）+ r_sw2（耗0）+ r_sw3（耗2）+ r_sw4（耗2）：延伸 4 条只耗 6 次
    assert.strictEqual(sword.newVerified, 4);
    assert.strictEqual(sword.signoffCost, 6);
    assert.deepStrictEqual(
      sword.records.map((r) => [r.id, r.cost]),
      [['r_sw1', 2], ['r_sw2', 0], ['r_sw3', 2], ['r_sw4', 2]]
    );
    // 待签列表不含 r_sw2（双方均已有效签收）
    assert.ok(res.body.pending.every((e) => e.recordId !== 'r_sw2'));
    // 全局：p_seal 2 条耗 4 + p_sword 4 条耗 6 = 新增 6 条耗 10
    assert.strictEqual(res.body.summary.newVerifiedTotal, 6);
    assert.strictEqual(res.body.summary.signoffTotal, 10);
    assert.strictEqual(res.body.summary.pendingTotal, 10);
    const revAfter = (await api('/api/state')).body.rev;
    assert.strictEqual(revAfter, revBefore); // 查询只读
  });

  // 7. 额度 0：空计划
  await test('补签计划：额度 0 返回空计划', async () => {
    const res = await api('/api/resign-plan?minute=12&quota=0');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.summary.newVerifiedTotal, 0);
    assert.strictEqual(res.body.summary.signoffTotal, 0);
    assert.deepStrictEqual(res.body.pending, []);
  });

  server.close();
  for (const f of [DATA_FILE, `${DATA_FILE}.tmp`]) {
    try { fs.unlinkSync(f); } catch { /* 忽略 */ }
  }
  console.log(`\n全部 ${passed} 个跨道具补签计划接口测试通过 ✔`);
}

main().catch((err) => {
  console.error(err);
  if (server) server.close();
  process.exit(1);
});
