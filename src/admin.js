'use strict';
// 管理员站场编辑：区段 / 道岔 / 道岔连接 / 信号机 / 进路 的增删改，
// 以及运行时复位。被活动进路锁定的资源禁止删除。
const db = require('./db');
const { HttpError, POS_NAME } = require('./interlocking');

function assert(value, message, code = 'VALIDATION_ERROR', details = {}) {
  if (!value) throw new HttpError(400, code, message, details);
}

function cleanId(v, prefix) {
  const id = String(v || '').trim();
  assert(/^[A-Za-z0-9_-]{1,24}$/.test(id), `${prefix}标识须为 1-24 位字母数字、下划线或短横线`);
  return id;
}

function activeLockExists(type, id) {
  return !!db.prepare(
    'SELECT 1 FROM route_locks WHERE resource_type = ? AND resource_id = ? AND released = 0 LIMIT 1'
  ).get(type, id);
}

// ---------------- 区段 ----------------
function upsertSection(body, isCreate) {
  const id = cleanId(body.id, '区段');
  assert(body.name && String(body.name).trim(), '区段名称不能为空');
  const x = Number(body.x) || 0;
  const y = Number(body.y) || 0;
  if (isCreate) {
    assert(!db.prepare('SELECT 1 FROM sections WHERE id = ?').get(id), `区段 ${id} 已存在`, 'DUPLICATE');
    db.prepare('INSERT INTO sections (id,name,x,y) VALUES (?,?,?,?)').run(id, body.name.trim(), x, y);
  } else {
    const r = db.prepare('UPDATE sections SET name=?, x=?, y=? WHERE id=?')
      .run(body.name.trim(), x, y, id);
    assert(r.changes, `区段 ${id} 不存在`, 'NOT_FOUND');
  }
  return { id };
}

function updateSectionLayout(id, x, y) {
  const r = db.prepare('UPDATE sections SET x=?, y=? WHERE id=?').run(Number(x) || 0, Number(y) || 0, id);
  assert(r.changes, `区段 ${id} 不存在`, 'NOT_FOUND');
}

function deleteSection(id) {
  const exists = db.prepare('SELECT 1 FROM sections WHERE id=?').get(id);
  if (!exists) throw new HttpError(404, 'NOT_FOUND', `区段 ${id} 不存在`);
  assert(!activeLockExists('sec', id), `区段 ${id} 正被已开放进路锁闭，禁止删除`, 'RESOURCE_LOCKED');
  db.prepare('DELETE FROM sections WHERE id=?').run(id);
  return { id };
}

// ---------------- 道岔 ----------------
function upsertSwitch(body, isCreate) {
  const id = cleanId(body.id, '道岔');
  assert(body.name && String(body.name).trim(), '道岔名称不能为空');
  const x = Number(body.x) || 0;
  const y = Number(body.y) || 0;
  if (isCreate) {
    assert(!db.prepare('SELECT 1 FROM switches WHERE id = ?').get(id), `道岔 ${id} 已存在`, 'DUPLICATE');
    db.prepare('INSERT INTO switches (id,name,x,y) VALUES (?,?,?,?)').run(id, body.name.trim(), x, y);
  } else {
    const r = db.prepare('UPDATE switches SET name=?, x=?, y=? WHERE id=?')
      .run(body.name.trim(), x, y, id);
    assert(r.changes, `道岔 ${id} 不存在`, 'NOT_FOUND');
  }
  return { id };
}

function updateSwitchLayout(id, x, y) {
  const r = db.prepare('UPDATE switches SET x=?, y=? WHERE id=?').run(Number(x) || 0, Number(y) || 0, id);
  assert(r.changes, `道岔 ${id} 不存在`, 'NOT_FOUND');
}

function deleteSwitch(id) {
  const exists = db.prepare('SELECT 1 FROM switches WHERE id=?').get(id);
  if (!exists) throw new HttpError(404, 'NOT_FOUND', `道岔 ${id} 不存在`);
  assert(!activeLockExists('sw', id), `道岔 ${id} 正被已开放进路锁闭，禁止删除`, 'RESOURCE_LOCKED');
  db.prepare('DELETE FROM switches WHERE id=?').run(id);
  return { id };
}

// ---------------- 道岔连接 ----------------
function setSwitchLink(body) {
  const switchId = String(body.switch_id || '').trim();
  const position = body.position;
  const a = String(body.section_a || '').trim();
  const b = String(body.section_b || '').trim();
  assert(db.prepare('SELECT 1 FROM switches WHERE id=?').get(switchId), `道岔 ${switchId} 不存在`);
  assert(['normal', 'reverse'].includes(position), 'position 必须是 normal 或 reverse');
  assert(a && b && a !== b, '必须指定两个不同的区段作为该位置的连接');
  for (const s of [a, b]) {
    assert(db.prepare('SELECT 1 FROM sections WHERE id=?').get(s), `区段 ${s} 不存在`);
  }
  db.prepare(
    `INSERT INTO switch_links (switch_id, position, section_a, section_b) VALUES (?,?,?,?)
     ON CONFLICT(switch_id, position) DO UPDATE SET section_a = excluded.section_a, section_b = excluded.section_b`
  ).run(switchId, position, a, b);
  return { switch_id: switchId, position };
}

function deleteSwitchLink(id) {
  const r = db.prepare('DELETE FROM switch_links WHERE id=?').run(id);
  assert(r.changes, '道岔连接不存在', 'NOT_FOUND');
  return { id };
}

// ---------------- 信号机 ----------------
function upsertSignal(body, isCreate) {
  const id = cleanId(body.id, '信号机');
  assert(body.name && String(body.name).trim(), '信号机名称不能为空');
  const x = Number(body.x) || 0;
  const y = Number(body.y) || 0;
  const sectionId = body.section_id || null;
  if (sectionId) {
    assert(db.prepare('SELECT 1 FROM sections WHERE id=?').get(sectionId),
      `信号机关联区段 ${sectionId} 不存在`);
  }
  if (isCreate) {
    assert(!db.prepare('SELECT 1 FROM signals WHERE id=?').get(id), `信号机 ${id} 已存在`, 'DUPLICATE');
    db.prepare('INSERT INTO signals (id,name,section_id,x,y) VALUES (?,?,?,?,?)')
      .run(id, body.name.trim(), sectionId, x, y);
  } else {
    const r = db.prepare('UPDATE signals SET name=?, section_id=?, x=?, y=? WHERE id=?')
      .run(body.name.trim(), sectionId, x, y, id);
    assert(r.changes, `信号机 ${id} 不存在`, 'NOT_FOUND');
  }
  return { id };
}

function deleteSignal(id) {
  const used = db.prepare(
    'SELECT 1 FROM routes WHERE from_signal=? OR to_signal=? LIMIT 1'
  ).get(id, id);
  assert(!used, `信号机 ${id} 已被进路引用，禁止删除`, 'REFERENCED');
  const r = db.prepare('DELETE FROM signals WHERE id=?').run(id);
  if (!r.changes) throw new HttpError(404, 'NOT_FOUND', `信号机 ${id} 不存在`);
  return { id };
}

// ---------------- 进路 ----------------
// 拓扑校验：
// 1) 区段顺序必须连续——相邻区段要么直接相接（信号/直线端），
//    要么存在道岔在指定位置连接二者，且该道岔必须包含在进路道岔要求中、位置一致；
// 2) 首/末区段须分别与起/终点信号机关联；
// 3) 区段不得重复；道岔要求中的每个道岔都必须实际连接路上的两个相邻区段。
function validateRouteDefinition({ fromSignal, toSignal, sections, switches }) {
  const problems = [];
  const sig = (id) => db.prepare('SELECT * FROM signals WHERE id=?').get(id);
  const from = sig(fromSignal);
  const to = sig(toSignal);
  if (!from) problems.push(`起点信号机 ${fromSignal} 不存在`);
  if (!to) problems.push(`终点信号机 ${toSignal} 不存在`);
  if (!sections.length) problems.push('进路至少包含一个区段');

  const secSet = new Set();
  for (const sid of sections) {
    if (!db.prepare('SELECT 1 FROM sections WHERE id=?').get(sid)) {
      problems.push(`经过区段 ${sid} 不存在`);
    }
    if (secSet.has(sid)) problems.push(`区段 ${sid} 在进路中重复出现`);
    secSet.add(sid);
  }

  if (from && sections.length && from.section_id !== sections[0]) {
    problems.push(`起点信号机 ${fromSignal} 关联区段 ${from.section_id || '(无)'}，与首段 ${sections[0]} 不一致`);
  }
  if (to && sections.length && to.section_id !== sections[sections.length - 1]) {
    problems.push(`终点信号机 ${toSignal} 关联区段 ${to.section_id || '(无)'}，与末段 ${sections[sections.length - 1]} 不一致`);
  }

  const linkOf = (switchId, position) =>
    db.prepare('SELECT * FROM switch_links WHERE switch_id=? AND position=?').get(switchId, position);
  const swReq = new Map(switches.map((s) => [s.switch_id, s.position]));
  const usedSwitches = new Set();

  for (let i = 0; i < sections.length - 1; i++) {
    const [a, b] = [sections[i], sections[i + 1]];
    // 找到在某位置恰好连接 a、b 的道岔
    const links = db.prepare(
      `SELECT * FROM switch_links WHERE
         (section_a=? AND section_b=?) OR (section_a=? AND section_b=?)`
    ).all(a, b, b, a);

    if (links.length === 0) {
      // 非道岔直连：允许（视为无岔连接线），但若定义里为此声明了道岔也不报错
      continue;
    }
    const matched = links.find((l) => swReq.get(l.switch_id) === l.position);
    if (!matched) {
      const opts = links.map((l) => `${l.switch_id}(${POS_NAME[l.position]})`).join(' 或 ');
      problems.push(`区段 ${a}→${b} 须经道岔 ${opts}，请在道岔要求中选择对应位置`);
    } else {
      usedSwitches.add(matched.switch_id);
    }
  }

  // 道岔要求必须都用在区段衔接上，且道岔存在
  for (const [sid, pos] of swReq) {
    if (!db.prepare('SELECT 1 FROM switches WHERE id=?').get(sid)) {
      problems.push(`道岔 ${sid} 不存在`);
      continue;
    }
    if (!['normal', 'reverse'].includes(pos)) {
      problems.push(`道岔 ${sid} 的位置必须是 normal/reverse`);
      continue;
    }
    if (!usedSwitches.has(sid)) {
      const l = linkOf(sid, pos);
      if (!l) {
        problems.push(`道岔 ${sid} 未定义${POS_NAME[pos]}连接`);
      } else {
        problems.push(`道岔 ${sid} 要求${POS_NAME[pos]}，但该位置连接区段 ${l.section_a}↔${l.section_b}，不衔接进路中的相邻区段`);
      }
    }
  }

  return problems;
}

function upsertRoute(body, isCreate) {
  const id = cleanId(body.id, '进路');
  assert(body.name && String(body.name).trim(), '进路名称不能为空');
  const fromSignal = String(body.from_signal || '').trim();
  const toSignal = String(body.to_signal || '').trim();
  const sections = Array.isArray(body.sections) ? body.sections.map(String) : [];
  const switches = Array.isArray(body.switches)
    ? body.switches.map((s) => ({ switch_id: String(s.switch_id), position: s.position }))
    : [];

  const problems = validateRouteDefinition({ fromSignal, toSignal, sections, switches });
  if (problems.length) {
    throw new HttpError(400, 'ROUTE_INVALID', '进路定义未通过拓扑校验', { problems });
  }

  if (isCreate) {
    assert(!db.prepare('SELECT 1 FROM routes WHERE id=?').get(id), `进路 ${id} 已存在`, 'DUPLICATE');
    db.prepare('INSERT INTO routes (id,name,from_signal,to_signal,sections,switches) VALUES (?,?,?,?,?,?)')
      .run(id, body.name.trim(), fromSignal, toSignal, JSON.stringify(sections), JSON.stringify(switches));
  } else {
    // 已开放的进路不允许修改定义
    const open = db.prepare(
      'SELECT 1 FROM active_routes WHERE route_id=? LIMIT 1'
    ).get(id);
    assert(!open, `进路 ${id} 正处于开放状态，禁止修改`, 'RESOURCE_LOCKED');
    const r = db.prepare('UPDATE routes SET name=?, from_signal=?, to_signal=?, sections=?, switches=? WHERE id=?')
      .run(body.name.trim(), fromSignal, toSignal, JSON.stringify(sections), JSON.stringify(switches), id);
    assert(r.changes, `进路 ${id} 不存在`, 'NOT_FOUND');
  }
  return { id };
}

function deleteRoute(id) {
  const open = db.prepare('SELECT 1 FROM active_routes WHERE route_id=? LIMIT 1').get(id);
  assert(!open, `进路 ${id} 正处于开放状态，禁止删除`, 'RESOURCE_LOCKED');
  const r = db.prepare('DELETE FROM routes WHERE id=?').run(id);
  if (!r.changes) throw new HttpError(404, 'NOT_FOUND', `进路 ${id} 不存在`);
  return { id };
}

// ---------------- 运行时复位（培训重来） ----------------
function resetRuntime() {
  db.transaction(() => {
    db.prepare('DELETE FROM route_locks').run();
    db.prepare('DELETE FROM active_routes').run();
    db.prepare('DELETE FROM occupancy_events').run();
    db.prepare('DELETE FROM section_state').run();
  })();
  return { reset: true, message: '运行时已复位：全部锁闭、占用事件与状态已清空（站场定义保留）' };
}

module.exports = {
  upsertSection, updateSectionLayout, deleteSection,
  upsertSwitch, updateSwitchLayout, deleteSwitch,
  setSwitchLink, deleteSwitchLink,
  upsertSignal, deleteSignal,
  upsertRoute, deleteRoute, validateRouteDefinition,
  resetRuntime,
};
