'use strict';
// 进路联锁核心逻辑：开放（原子加锁）、占用/清空事件（序号校验 + 逐段解锁）、状态查询
const db = require('./db');

const POS_NAME = { normal: '定位', reverse: '反位' };

class HttpError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function parseJSONArray(str) {
  try {
    const v = JSON.parse(str);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function getRoute(routeId) {
  const row = db.prepare('SELECT * FROM routes WHERE id = ?').get(routeId);
  if (!row) throw new HttpError(404, 'ROUTE_NOT_FOUND', `进路 ${routeId} 不存在`);
  row.sectionList = parseJSONArray(row.sections);
  row.switchList = parseJSONArray(row.switches);
  return row;
}

function namesById(rows) {
  const m = new Map();
  rows.forEach((r) => m.set(r.id, r.name));
  return m;
}

// ---------------------------------------------------------------------------
// 开放进路：单一 SQLite 事务内完成全部检查与加锁，失败整体回滚，无部分锁定
// ---------------------------------------------------------------------------
function openRoute(routeId, requestedPositions = {}, operator = '值班员') {
  const route = getRoute(routeId);
  const sections = route.sectionList;
  const reqSwitches = route.switchList;

  if (sections.length === 0) {
    throw new HttpError(409, 'ROUTE_EMPTY', `进路 ${route.name} 未定义经过区段`);
  }

  const secNames = namesById(db.prepare('SELECT id,name FROM sections').all());
  const swNames = namesById(db.prepare('SELECT id,name FROM switches').all());
  const reasons = [];

  // 1) 道岔位置必须与进路要求完全一致（未提交位置按不符处理）
  for (const req of reqSwitches) {
    const given = requestedPositions[req.switch_id];
    if (!given || given !== req.position) {
      reasons.push({
        code: 'SWITCH_POSITION_MISMATCH',
        message: `道岔 ${swNames.get(req.switch_id) || req.switch_id} 位置不符：要求${POS_NAME[req.position]}，` +
          (given ? `实际请求${POS_NAME[given] || given}` : '未给出位置'),
        switch_id: req.switch_id,
        required: req.position,
        given: given || null,
      });
    }
  }

  // 2) 沿途区段必须空闲；未知占用状态（从未提交事件）按占用处理
  const occupiedSections = [];
  for (const sid of sections) {
    const st = db.prepare('SELECT occupied FROM section_state WHERE section_id = ?').get(sid);
    if (!st || st.occupied === 1) {
      occupiedSections.push({
        section_id: sid,
        unknown: !st,
        message: `区段 ${secNames.get(sid) || sid} ${!st ? '占用状态未知（按占用处理）' : '已被列车占用'}`,
      });
    }
  }
  if (occupiedSections.length) {
    reasons.push({ code: 'SECTION_OCCUPIED', message: '存在占用/状态未知区段', sections: occupiedSections });
  }

  // 3) 资源争用：与已开放（尚未全部解锁）的进路冲突即拒绝
  const placeholders = (n) => '?,'.repeat(n).slice(0, -1);
  const lockRows = sections.length
    ? db.prepare(
        `SELECT rl.*, ar.route_id AS held_route
         FROM route_locks rl JOIN active_routes ar ON ar.id = rl.active_id
         WHERE rl.released = 0 AND (
           (rl.resource_type = 'sec' AND rl.resource_id IN (${placeholders(sections.length)}))
           ${reqSwitches.length ? `OR (rl.resource_type = 'sw' AND rl.resource_id IN (${placeholders(reqSwitches.length)}))` : ''}
         )`
      ).all(...sections, ...reqSwitches.map((s) => s.switch_id))
    : db.prepare(
        `SELECT rl.*, ar.route_id AS held_route
         FROM route_locks rl JOIN active_routes ar ON ar.id = rl.active_id
         WHERE rl.released = 0 AND rl.resource_type = 'sw' AND rl.resource_id IN (${placeholders(reqSwitches.length)})`
      ).all(...reqSwitches.map((s) => s.switch_id));

  if (lockRows.length) {
    const conflicts = lockRows.map((l) => ({
      resource_type: l.resource_type,
      resource_id: l.resource_id,
      resource_name: (l.resource_type === 'sec' ? secNames : swNames).get(l.resource_id) || l.resource_id,
      held_route: l.held_route,
      message: `${l.resource_type === 'sec' ? '区段' : '道岔'} ${
        (l.resource_type === 'sec' ? secNames : swNames).get(l.resource_id) || l.resource_id
      } 已被进路 ${l.held_route} 锁闭`,
    }));
    reasons.push({ code: 'ROUTE_CONTENTION', message: '与已开放进路争用资源', conflicts });
  }

  if (reasons.length) {
    throw new HttpError(409, 'OPEN_REJECTED', `进路 ${route.name} 不能开放`, { reasons });
  }

  // 全部检查通过 —— 同一事务内插入活动进路与全部资源锁。
  // ux_active_lock_resource 唯一索引是最后一道并发防线：
  // 两名值班员并发冲突时，后到者在此抛约束异常，整个事务回滚。
  try {
    const result = db.transaction(() => {
      const info = db.prepare(
        'INSERT INTO active_routes (route_id, operator, opened_at, entered) VALUES (?,?,?,0)'
      ).run(routeId, operator, Date.now());
      const activeId = info.lastInsertRowid;
      const insLock = db.prepare(
        'INSERT INTO route_locks (active_id, route_id, resource_type, resource_id, position) VALUES (?,?,?,?,?)'
      );
      for (const sid of sections) insLock.run(activeId, routeId, 'sec', sid, null);
      for (const req of reqSwitches) insLock.run(activeId, routeId, 'sw', req.switch_id, req.position);
      return activeId;
    })();
    return { active_id: result, route_id: routeId, route_name: route.name, opened: true };
  } catch (e) {
    if (String(e.message).includes('UNIQUE') || (e.code === 'SQLITE_CONSTRAINT')) {
      throw new HttpError(409, 'ROUTE_CONTENTION',
        `进路 ${route.name} 与另一进路并发争用资源，本次申请被拒绝，未产生任何锁定`,
        { reasons: [{ code: 'ROUTE_CONTENTION', message: '并发争用：资源已被另一条进路抢先锁定' }] });
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// 区段占用 / 清空事件：按区段独立递增序号
//   同号同内容重传 -> 幂等，不重复生效
//   同号异内容     -> 拒绝
//   跳号           -> 拒绝
// ---------------------------------------------------------------------------
function submitEvent(sectionId, seq, value) {
  const section = db.prepare('SELECT * FROM sections WHERE id = ?').get(sectionId);
  if (!section) throw new HttpError(404, 'SECTION_NOT_FOUND', `区段 ${sectionId} 不存在`);
  if (!Number.isInteger(seq) || seq < 1) {
    throw new HttpError(400, 'BAD_SEQ', '序号必须是从 1 开始的正整数', { section_id: sectionId });
  }
  if (!['occupy', 'clear'].includes(value)) {
    throw new HttpError(400, 'BAD_VALUE', '事件内容只能是 occupy(占用) 或 clear(清空)', { section_id: sectionId });
  }

  const st = db.prepare('SELECT * FROM section_state WHERE section_id = ?').get(sectionId);
  const lastSeq = st ? st.last_seq : 0;

  // 重传 / 旧号
  if (seq <= lastSeq) {
    if (seq === lastSeq) {
      const ev = db.prepare('SELECT value FROM occupancy_events WHERE section_id = ? AND seq = ?')
        .get(sectionId, seq);
      if (ev && ev.value === value) {
        return { duplicated: true, section_id: sectionId, seq, value, message: '同号同内容重传，未重复生效' };
      }
      throw new HttpError(409, 'SAME_SEQ_CONFLICT',
        `区段 ${section.name} 序号 ${seq} 已提交内容为 ${ev ? ev.value : '?'}，` +
        `现提交 ${value}，同号异内容拒绝`,
        { section_id: sectionId, seq, existing: ev ? ev.value : null, submitted: value });
    }
    throw new HttpError(409, 'STALE_SEQ',
      `区段 ${section.name} 序号 ${seq} 已过期（最新序号 ${lastSeq}），拒绝`,
      { section_id: sectionId, seq, last_seq: lastSeq });
  }

  // 跳号
  if (seq > lastSeq + 1) {
    throw new HttpError(409, 'SEQ_GAP',
      `区段 ${section.name} 跳号：期望序号 ${lastSeq + 1}，收到 ${seq}，拒绝`,
      { section_id: sectionId, expected: lastSeq + 1, received: seq });
  }

  return db.transaction(() => {
    db.prepare('INSERT INTO occupancy_events (section_id, seq, value, ts) VALUES (?,?,?,?)')
      .run(sectionId, seq, value, Date.now());
    db.prepare(
      `INSERT INTO section_state (section_id, last_seq, occupied) VALUES (?,?,?)
       ON CONFLICT(section_id) DO UPDATE SET last_seq = excluded.last_seq, occupied = excluded.occupied`
    ).run(sectionId, seq, value === 'occupy' ? 1 : 0);

    let signalTurnedRed = false;
    let releasedSections = [];

    if (value === 'occupy') {
      // 列车进入首段（进入任一路内锁闭区段即视为进入）：信号回红
      const updated = db.prepare(
        `UPDATE active_routes SET entered = 1
         WHERE entered = 0 AND id IN (
           SELECT active_id FROM route_locks
           WHERE resource_type = 'sec' AND resource_id = ? AND released = 0
         )`
      ).run(sectionId);
      signalTurnedRed = updated.changes > 0;
      // 推进每条相关进路“已到达最远区段”下标
      advanceReached(sectionId);
    } else {
      // 清空 -> 从进路首段起逐段解锁（不得超过列车实际到达的最远段）
      releasedSections = cascadeRelease(sectionId);
    }

    return {
      duplicated: false,
      section_id: sectionId,
      seq,
      value,
      occupied: value === 'occupy',
      signal_turned_red: signalTurnedRed,
      released_sections: releasedSections,
    };
  })();
}

// 占用事件推进“列车已到达最远区段”
function advanceReached(triggerSection) {
  const rows = db.prepare(
    `SELECT ar.id AS active_id, ar.route_id, ar.reached_idx
     FROM active_routes ar
     JOIN route_locks rl ON rl.active_id = ar.id
     WHERE rl.resource_type = 'sec' AND rl.resource_id = ? AND rl.released = 0`
  ).all(triggerSection);
  for (const a of rows) {
    const route = getRoute(a.route_id);
    const idx = route.sectionList.indexOf(triggerSection);
    if (idx >= 0 && idx > a.reached_idx) {
      db.prepare('UPDATE active_routes SET reached_idx = ? WHERE id = ?').run(idx, a.active_id);
    }
  }
}

// 已清空的经过区段逐段解锁：必须自进路首段顺序推进，且不得越过列车实际到达的最远段；
// 前面区段未清空（仍占用）时，后面区段即便上报清空也暂不解锁
function cascadeRelease(triggerSection) {
  const lock = db.prepare(
    `SELECT rl.* FROM route_locks rl
     JOIN active_routes ar ON ar.id = rl.active_id
     WHERE rl.resource_type = 'sec' AND rl.resource_id = ? AND rl.released = 0`
  ).get(triggerSection);
  if (!lock) return [];

  const active = db.prepare('SELECT * FROM active_routes WHERE id = ?').get(lock.active_id);
  if (!active || !active.entered) return [];

  const route = getRoute(active.route_id);
  const released = [];

  for (let i = 0; i <= active.reached_idx && i < route.sectionList.length; i++) {
    const sid = route.sectionList[i];
    const row = db.prepare(
      'SELECT id FROM route_locks WHERE active_id = ? AND resource_type = \'sec\' AND resource_id = ? AND released = 0'
    ).get(active.id, sid);
    if (!row) continue; // 该段已解锁
    const st = db.prepare('SELECT occupied FROM section_state WHERE section_id = ?').get(sid);
    if (!st || st.occupied === 1) break; // 仍占用 / 未知 -> 停止逐段推进
    db.prepare('UPDATE route_locks SET released = 1 WHERE id = ?').run(row.id);
    released.push(sid);
  }
  return released;
}

// ---------------------------------------------------------------------------
// 解除进路：未进入首段可取消（信号尚未使用）；进入后须末段已清空方可整条解除
// ---------------------------------------------------------------------------
function releaseRoute(activeId, operator) {
  const active = db.prepare('SELECT * FROM active_routes WHERE id = ?').get(activeId);
  if (!active) throw new HttpError(404, 'ACTIVE_ROUTE_NOT_FOUND', `活动进路 #${activeId} 不存在或已解除`);
  const route = getRoute(active.route_id);

  if (operator && active.operator && active.operator !== operator) {
    // 培训场景允许互相解除，仅作记录；不拦截
  }

  if (!active.entered) {
    db.prepare('DELETE FROM active_routes WHERE id = ?').run(active.id); // FK 级联删除锁
    return { active_id: active.id, route_id: route.id, cancelled: true,
      message: `进路 ${route.name} 列车尚未进入，已取消并释放全部锁闭` };
  }

  const lastSec = route.sectionList[route.sectionList.length - 1];
  const lastLock = db.prepare(
    'SELECT id FROM route_locks WHERE active_id = ? AND resource_type = \'sec\' AND resource_id = ? AND released = 0'
  ).get(active.id, lastSec);
  if (lastLock) {
    const st = db.prepare('SELECT occupied FROM section_state WHERE section_id = ?').get(lastSec);
    throw new HttpError(409, 'LAST_SECTION_NOT_CLEAR',
      `进路 ${route.name} 末段 ${lastSec} 尚未清空${!st ? '（状态未知）' : '，仍被占用'}，不得解除整条进路`,
      { route_id: route.id, last_section: lastSec, unknown: !st });
  }

  db.prepare('DELETE FROM active_routes WHERE id = ?').run(active.id);
  return { active_id: active.id, route_id: route.id, completed: true,
    message: `进路 ${route.name} 已全部出清，进路解除` };
}

// ---------------------------------------------------------------------------
// 全站状态查询（刷新页面后据此恢复全部已提交状态）
// ---------------------------------------------------------------------------
function getState() {
  const sections = db.prepare('SELECT id,name,x,y FROM sections ORDER BY id').all().map((s) => {
    const st = db.prepare('SELECT last_seq, occupied FROM section_state WHERE section_id = ?').get(s.id);
    return {
      ...s,
      occupied: st ? !!st.occupied : null, // null = 未知，按占用处理
      last_seq: st ? st.last_seq : 0,
      next_seq: st ? st.last_seq + 1 : 1,
    };
  });

  const switches = db.prepare('SELECT id,name,x,y FROM switches ORDER BY id').all();
  const links = db.prepare('SELECT switch_id,position,section_a,section_b FROM switch_links').all();
  const signals = db.prepare('SELECT id,name,section_id,x,y FROM signals ORDER BY id').all();
  const routes = db.prepare('SELECT * FROM routes ORDER BY id').all().map((r) => ({
    id: r.id,
    name: r.name,
    from_signal: r.from_signal,
    to_signal: r.to_signal,
    sections: parseJSONArray(r.sections),
    switches: parseJSONArray(r.switches),
  }));

  const activeList = db.prepare('SELECT * FROM active_routes ORDER BY id').all();
  const actives = activeList.map((a) => {
    const locks = db.prepare(
      'SELECT resource_type, resource_id, position, released FROM route_locks WHERE active_id = ?'
    ).all(a.id);
    return {
      active_id: a.id,
      route_id: a.route_id,
      operator: a.operator,
      opened_at: a.opened_at,
      entered: !!a.entered,
      locked_sections: locks.filter((l) => l.resource_type === 'sec' && !l.released).map((l) => l.resource_id),
      released_sections: locks.filter((l) => l.resource_type === 'sec' && l.released).map((l) => l.resource_id),
      locked_switches: locks.filter((l) => l.resource_type === 'sw').map((l) => ({
        switch_id: l.resource_id, position: l.position,
      })),
    };
  });

  // 信号状态：有以此信号为起点、列车尚未进入的开放进路 -> 绿灯；否则红灯
  const greenBySignal = new Map();
  for (const a of actives) {
    const rt = routes.find((r) => r.id === a.route_id);
    if (rt && !a.entered && !greenBySignal.has(rt.from_signal)) {
      greenBySignal.set(rt.from_signal, a.active_id);
    }
  }
  const signalsOut = signals.map((s) => ({
    ...s,
    aspect: greenBySignal.has(s.id) ? 'green' : 'red',
    active_id: greenBySignal.get(s.id) || null,
  }));

  // 区段占用图附带锁属主
  const ownerBySec = new Map();
  for (const a of actives) {
    for (const sid of a.locked_sections) {
      ownerBySec.set(sid, { active_id: a.active_id, route_id: a.route_id, operator: a.operator });
    }
  }
  const sectionsOut = sections.map((s) => ({ ...s, locked_by: ownerBySec.get(s.id) || null }));

  const events = db.prepare(
    'SELECT section_id, seq, value, ts FROM occupancy_events ORDER BY id DESC LIMIT 30'
  ).all().reverse();

  return {
    now: Date.now(),
    sections: sectionsOut,
    switches,
    links,
    signals: signalsOut,
    routes,
    actives,
    events,
  };
}

module.exports = { HttpError, POS_NAME, openRoute, submitEvent, releaseRoute, getState, getRoute };
