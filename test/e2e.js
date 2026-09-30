'use strict';
// 端到端联锁场景验证（启动前清空测试库）
const BASE = 'http://127.0.0.1:3999';
let pass = 0, fail = 0;

function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✅', msg); }
  else { fail++; console.log('  ❌', msg); }
}
async function call(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

(async () => {
  console.log('--- 0. 复位运行时，保证可重复运行 ---');
  await call('POST', '/api/admin/reset-runtime');

  console.log('--- 1. 初始状态：无事件区段未知（按占用），信号全红 ---');
  let s = (await call('GET', '/api/state')).data;
  ok(s.sections.every((x) => x.occupied === null), '全部区段状态未知');
  ok(s.signals.every((x) => x.aspect === 'red'), '全部信号红灯');

  console.log('--- 2. 未知状态下开放 R1 被拒，指出区段 ---');
  let r = await call('POST', '/api/routes/R1/open', {
    positions: { SW1: 'normal', SW2: 'normal' }, operator: '甲',
  });
  ok(r.status === 409, 'R1 开放被拒绝 409');
  const secs = r.data.details.reasons.find((x) => x.code === 'SECTION_OCCUPIED');
  ok(secs && secs.sections.some((x) => x.section_id === '1G'), '阻断原因指出区段 1G（未知按占用）');

  console.log('--- 3. 按递增序号清空 R1 沿途区段（初始 seq=1） ---');
  for (const sid of ['1G', '3G', '5G']) {
    const ev = await call('POST', '/api/events', { section_id: sid, seq: 1, value: 'clear' });
    ok(ev.status === 200 && ev.data.occupied === false, `${sid} #1 清空气效`);
  }

  console.log('--- 4. 序号规则：同号同内容重传幂等 / 同号异内容拒绝 / 跳号拒绝 ---');
  let dup = await call('POST', '/api/events', { section_id: '1G', seq: 1, value: 'clear' });
  ok(dup.data.duplicated === true, '同号同内容重传幂等');
  let conflict = await call('POST', '/api/events', { section_id: '1G', seq: 1, value: 'occupy' });
  ok(conflict.status === 409 && conflict.data.error === 'SAME_SEQ_CONFLICT', '同号异内容拒绝');
  let gap = await call('POST', '/api/events', { section_id: '1G', seq: 3, value: 'occupy' });
  ok(gap.status === 409 && gap.data.error === 'SEQ_GAP', '跳号(#3)拒绝，提示期望 #2');
  let stale = await call('POST', '/api/events', { section_id: '1G', seq: 0, value: 'occupy' });
  ok(stale.status === 400, '非法序号 400');

  console.log('--- 5. 道岔位置不符拒绝 ---');
  let badSw = await call('POST', '/api/routes/R1/open', {
    positions: { SW1: 'reverse', SW2: 'normal' }, operator: '甲',
  });
  ok(badSw.status === 409, 'R1 用 SW1 反位被拒');
  ok(badSw.data.details.reasons.some((x) => x.code === 'SWITCH_POSITION_MISMATCH' && x.switch_id === 'SW1'),
    '指出道岔 SW1 位置不符（switch_id + 名称）');

  console.log('--- 6. R1 正确开放：原子锁闭 3 区段 + 2 道岔，X1 绿灯 ---');
  let opened = await call('POST', '/api/routes/R1/open', {
    positions: { SW1: 'normal', SW2: 'normal' }, operator: '甲',
  });
  ok(opened.status === 200, 'R1 开放成功');
  const activeId = opened.data.active_id;
  s = (await call('GET', '/api/state')).data;
  const a1 = s.actives.find((x) => x.active_id === activeId);
  ok(a1.locked_sections.length === 3 && a1.locked_switches.length === 2, '锁定 3 区段 + 2 道岔');
  ok(s.signals.find((x) => x.id === 'X1').aspect === 'green', 'X1 绿灯');
  ok(s.signals.find((x) => x.id === 'X3').aspect === 'red', 'X3 仍红灯');

  console.log('--- 7. 争用：R2（争 1G/SW1）、R3（争 5G/SW2）均拒绝 ---');
  const r2 = await call('POST', '/api/routes/R2/open', { positions: { SW1: 'reverse' }, operator: '乙' });
  ok(r2.status === 409, 'R2 冲突被拒');
  const r2c = r2.data.details.reasons.find((x) => x.code === 'ROUTE_CONTENTION');
  ok(r2c.conflicts.some((x) => x.resource_id === '1G') && r2c.conflicts.some((x) => x.resource_id === 'SW1'),
    '指出争用资源 1G 与 SW1');
  const r3 = await call('POST', '/api/routes/R3/open', { positions: { SW2: 'reverse' }, operator: '乙' });
  ok(r3.status === 409 && r3.data.details.reasons.some((x) => x.code === 'ROUTE_CONTENTION'), 'R3 冲突被拒');
  s = (await call('GET', '/api/state')).data;
  ok(s.actives.length === 1, '争用失败未产生部分锁定（仍只有 R1）');

  console.log('--- 8. 并发争用：先清空 R2 资源后两名值班员同时抢 R1/R2 ---');
  // 复位运行时后重做并发场景
  await call('POST', '/api/admin/reset-runtime');
  for (const sid of ['1G', '3G', '5G', '2G']) {
    await call('POST', '/api/events', { section_id: sid, seq: 1, value: 'clear' });
  }
  const [c1, c2] = await Promise.all([
    call('POST', '/api/routes/R1/open', { positions: { SW1: 'normal', SW2: 'normal' }, operator: '甲' }),
    call('POST', '/api/routes/R2/open', { positions: { SW1: 'reverse' }, operator: '乙' }),
  ]);
  ok((c1.status === 200) !== (c2.status === 200), '并发冲突只有一条成功');
  ok([c1, c2].filter((x) => x.status === 409).length === 1, '另一条被拒');
  s = (await call('GET', '/api/state')).data;
  ok(s.actives.length === 1, '只存在一条活动进路');
  await call('POST', '/api/admin/reset-runtime');

  console.log('--- 9. 列车走行：信号回红 + 逐段解锁 + 末段未清空不能解除 ---');
  for (const sid of ['1G', '3G', '5G']) {
    await call('POST', '/api/events', { section_id: sid, seq: 1, value: 'clear' });
  }
  opened = await call('POST', '/api/routes/R1/open', {
    positions: { SW1: 'normal', SW2: 'normal' }, operator: '甲',
  });
  const aid = opened.data.active_id;
  // 列车进入首段
  let e2 = await call('POST', '/api/events', { section_id: '1G', seq: 2, value: 'occupy' });
  ok(e2.data.signal_turned_red === true, '进入 1G 后信号回红');
  s = (await call('GET', '/api/state')).data;
  ok(s.signals.find((x) => x.id === 'X1').aspect === 'red', 'X1 确认红灯');
  // 进入前不能解除限制：进入后，首段占用时空清中间段不应解锁
  await call('POST', '/api/events', { section_id: '3G', seq: 2, value: 'clear' }); // 提前清空 3G
  s = (await call('GET', '/api/state')).data;
  let act = s.actives.find((x) => x.active_id === aid);
  ok(act.locked_sections.includes('3G'), '首段未清空时 3G 暂不解锁');
  // 未清空末段前解除整条进路 -> 拒绝
  let rel = await call('POST', `/api/active/${aid}/release`, {});
  ok(rel.status === 409 && rel.data.details.last_section === '5G', '末段 5G 未清空，解除被拒');
  // 出清首段 -> 仅解锁 1G；列车尚未到达的 3G/5G 不得解锁
  let cl1 = await call('POST', '/api/events', { section_id: '1G', seq: 3, value: 'clear' });
  ok(JSON.stringify(cl1.data.released_sections) === JSON.stringify(['1G']),
    '1G 清空后只解锁 1G（未到达的 3G/5G 不解锁）');
  s = (await call('GET', '/api/state')).data;
  act = s.actives.find((x) => x.active_id === aid);
  ok(!act.locked_sections.includes('1G'), '1G 锁已释放');
  ok(act.locked_sections.includes('3G') && act.locked_sections.includes('5G'), '3G/5G 仍锁闭');
  ok(act.locked_switches.length === 2, '道岔仍锁闭（整条进路未解除）');
  // 列车继续：到达并出清 3G -> 解锁 3G；到达并出清 5G -> 解锁 5G
  await call('POST', '/api/events', { section_id: '3G', seq: 3, value: 'occupy' });
  await call('POST', '/api/events', { section_id: '3G', seq: 4, value: 'clear' });
  s = (await call('GET', '/api/state')).data;
  act = s.actives.find((x) => x.active_id === aid);
  ok(!act.locked_sections.includes('3G') && act.locked_sections.includes('5G'), '3G 出清后解锁，5G 仍锁');
  await call('POST', '/api/events', { section_id: '5G', seq: 2, value: 'occupy' });
  await call('POST', '/api/events', { section_id: '5G', seq: 3, value: 'clear' });
  s = (await call('GET', '/api/state')).data;
  act = s.actives.find((x) => x.active_id === aid);
  ok(act && act.locked_sections.length === 0, '全部区段逐段解锁');
  rel = await call('POST', `/api/active/${aid}/release`, {});
  ok(rel.status === 200, '末段清空后进路整条解除');
  s = (await call('GET', '/api/state')).data;
  ok(s.actives.length === 0, '活动进路清零，道岔锁随之释放');

  console.log('--- 10. 未进入可取消进路（信号未使用） ---');
  const op = await call('POST', '/api/routes/R1/open', {
    positions: { SW1: 'normal', SW2: 'normal' }, operator: '甲',
  });
  const cancel = await call('POST', `/api/active/${op.data.active_id}/release`, {});
  ok(cancel.status === 200 && cancel.data.cancelled, '列车未进入可取消');
  s = (await call('GET', '/api/state')).data;
  ok(s.actives.length === 0, '取消后无锁残留');

  console.log('--- 11. 区段占用阻断：开放时占用区段拒绝并指明 ---');
  await call('POST', '/api/events', { section_id: '3G', seq: 5, value: 'occupy' });
  const occ = await call('POST', '/api/routes/R1/open', {
    positions: { SW1: 'normal', SW2: 'normal' }, operator: '甲',
  });
  ok(occ.status === 409, '占用区段存在时开放拒绝');
  const oc = occ.data.details.reasons.find((x) => x.code === 'SECTION_OCCUPIED');
  ok(oc.sections.some((x) => x.section_id === '3G' && !x.unknown), '指出占用区段 3G');

  console.log('--- 12. 管理员进路拓扑校验 ---');
  const bad = await call('POST', '/api/admin/routes', {
    id: 'RBAD', name: '错误进路', from_signal: 'X1', to_signal: 'X3',
    sections: ['1G', '2G'], switches: [{ switch_id: 'SW2', position: 'normal' }],
  });
  ok(bad.status === 400 && bad.data.details.problems.length >= 1, '拓扑不合法的进路被拒绝并给出问题');

  console.log(`--- 13. 刷新恢复：状态接口恢复全部已提交状态（last_seq/占用/活动锁） ---`);
  s = (await call('GET', '/api/state')).data;
  const s3 = s.sections.find((x) => x.id === '3G');
  ok(s3.occupied === true && s3.last_seq === 5, '3G 恢复为占用、序号 5');

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
