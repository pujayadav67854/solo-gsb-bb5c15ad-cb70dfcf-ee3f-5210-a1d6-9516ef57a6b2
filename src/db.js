'use strict';
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'interlocking.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function init() {
  db.transaction(() => {
    // ---------- 站场静态数据（管理员绘制） ----------
    db.exec(`
      CREATE TABLE IF NOT EXISTS sections (
        id        TEXT PRIMARY KEY,
        name      TEXT NOT NULL,
        x         REAL NOT NULL DEFAULT 100,
        y         REAL NOT NULL DEFAULT 100
      );

      CREATE TABLE IF NOT EXISTS switches (
        id        TEXT PRIMARY KEY,
        name      TEXT NOT NULL,
        x         REAL NOT NULL DEFAULT 200,
        y         REAL NOT NULL DEFAULT 100
      );

      -- 道岔连接：同 switch_id 下 position=normal(定位)/reverse(反位)
      -- 各自连接两个区段（道岔的前后端），完整表达站场拓扑
      CREATE TABLE IF NOT EXISTS switch_links (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        switch_id   TEXT NOT NULL REFERENCES switches(id) ON DELETE CASCADE,
        position    TEXT NOT NULL CHECK (position IN ('normal','reverse')),
        section_a   TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
        section_b   TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
        UNIQUE (switch_id, position)
      );

      CREATE TABLE IF NOT EXISTS signals (
        id        TEXT PRIMARY KEY,
        name      TEXT NOT NULL,
        section_id TEXT REFERENCES sections(id) ON DELETE SET NULL,
        x         REAL NOT NULL DEFAULT 120,
        y         REAL NOT NULL DEFAULT 60
      );

      -- 进路：起点信号 -> 终点信号，按顺序经过 sections(JSON) 与道岔要求 switches(JSON [{switch_id, position}])
      CREATE TABLE IF NOT EXISTS routes (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        from_signal TEXT NOT NULL REFERENCES signals(id),
        to_signal   TEXT NOT NULL REFERENCES signals(id),
        sections    TEXT NOT NULL DEFAULT '[]',
        switches    TEXT NOT NULL DEFAULT '[]'
      );

      -- ---------- 运行时数据 ----------
      -- 区段占用事件：按区段递增序号，占用 occupy / 清空 clear
      CREATE TABLE IF NOT EXISTS occupancy_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        section_id TEXT NOT NULL,
        seq        INTEGER NOT NULL,
        value      TEXT NOT NULL CHECK (value IN ('occupy','clear')),
        ts         INTEGER NOT NULL,
        UNIQUE (section_id, seq)
      );

      CREATE TABLE IF NOT EXISTS section_state (
        section_id TEXT PRIMARY KEY REFERENCES sections(id) ON DELETE CASCADE,
        last_seq   INTEGER NOT NULL,
        occupied   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS active_routes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        route_id    TEXT NOT NULL,
        operator    TEXT NOT NULL DEFAULT '值班员',
        opened_at   INTEGER NOT NULL,
        entered     INTEGER NOT NULL DEFAULT 0, -- 列车是否已进入首段（进入后信号回红）
        reached_idx INTEGER NOT NULL DEFAULT -1 -- 列车已到达的最远区段下标
      );

      -- 已开放进路持有的资源锁（资源：sec:区段 / sw:道岔；
      -- 区段清空后可逐段解锁，道岔锁在整条进路解除前不释放）
      CREATE TABLE IF NOT EXISTS route_locks (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        active_id     INTEGER NOT NULL REFERENCES active_routes(id) ON DELETE CASCADE,
        route_id      TEXT NOT NULL,
        resource_type TEXT NOT NULL CHECK (resource_type IN ('sec','sw')),
        resource_id   TEXT NOT NULL,
        position      TEXT,
        released      INTEGER NOT NULL DEFAULT 0,
        UNIQUE (resource_type, resource_id, active_id)
      );

      -- 关键并发兜底：同一资源在任一未释放（released=0）的进路锁中最多出现一次。
      -- 两名值班员同时申请冲突进路时，后提交者插锁失败 -> 整笔事务回滚，不留下部分锁定。
      CREATE UNIQUE INDEX IF NOT EXISTS ux_active_lock_resource
        ON route_locks(resource_type, resource_id)
        WHERE released = 0;
    `);
  })();

  // 旧库迁移：active_routes.reached_idx
  try {
    const cols = db.prepare('PRAGMA table_info(active_routes)').all();
    if (cols.length && !cols.some((c) => c.name === 'reached_idx')) {
      db.exec('ALTER TABLE active_routes ADD COLUMN reached_idx INTEGER NOT NULL DEFAULT -1');
    }
  } catch (e) { /* 全新建库时无此表，忽略 */ }
}

function isSeeded() {
  return db.prepare('SELECT COUNT(*) AS n FROM sections').get().n > 0;
}

// 示例站场：
//
//   X1 ─ 1G ─ SW1 ─ 3G ─ SW2 ─ 5G ─ X3
//                  ╲                ╲
//                   2G ─ X2          4G ─ X4
//
// SW1 定位连 1G↔3G，反位连 1G↔2G；SW2 定位连 3G↔5G，反位连 5G↔4G
// R1: X1→X3 经 1G,3G,5G（SW1/SW2 定位）
// R2: X1→X2 经 1G,2G    （SW1 反位）—— 与 R1 争用 1G、SW1
// R3: X3→X4 经 5G,4G    （SW2 反位）—— 与 R1 争用 5G、SW2
function seed() {
  if (isSeeded()) return;
  const tx = db.transaction(() => {
    const insSec = db.prepare('INSERT INTO sections (id,name,x,y) VALUES (?,?,?,?)');
    [
      ['1G', '1G', 150, 150],
      ['3G', '3G', 360, 150],
      ['5G', '5G', 570, 150],
      ['2G', '2G', 360, 290],
      ['4G', '4G', 570, 290],
    ].forEach((r) => insSec.run(...r));

    const insSw = db.prepare('INSERT INTO switches (id,name,x,y) VALUES (?,?,?,?)');
    [
      ['SW1', '1号道岔', 255, 150],
      ['SW2', '3号道岔', 465, 150],
    ].forEach((r) => insSw.run(...r));

    const insLink = db.prepare(
      'INSERT INTO switch_links (switch_id,position,section_a,section_b) VALUES (?,?,?,?)'
    );
    [
      ['SW1', 'normal', '1G', '3G'],
      ['SW1', 'reverse', '1G', '2G'],
      ['SW2', 'normal', '3G', '5G'],
      ['SW2', 'reverse', '5G', '4G'],
    ].forEach((r) => insLink.run(...r));

    const insSig = db.prepare(
      'INSERT INTO signals (id,name,section_id,x,y) VALUES (?,?,?,?,?)'
    );
    [
      ['X1', '下行进站 X1', '1G', 60, 150],
      ['X2', '2股道 X2', '2G', 360, 340],
      ['X3', '上行出站 X3', '5G', 660, 150],
      ['X4', '4股道 X4', '4G', 570, 340],
    ].forEach((r) => insSig.run(...r));

    const insRoute = db.prepare(
      'INSERT INTO routes (id,name,from_signal,to_signal,sections,switches) VALUES (?,?,?,?,?,?)'
    );
    insRoute.run('R1', 'X1→X3 正线通过', 'X1', 'X3',
      JSON.stringify(['1G', '3G', '5G']),
      JSON.stringify([
        { switch_id: 'SW1', position: 'normal' },
        { switch_id: 'SW2', position: 'normal' },
      ]));
    insRoute.run('R2', 'X1→X2 接入2G', 'X1', 'X2',
      JSON.stringify(['1G', '2G']),
      JSON.stringify([{ switch_id: 'SW1', position: 'reverse' }]));
    insRoute.run('R3', 'X3→X4 折返4G', 'X3', 'X4',
      JSON.stringify(['5G', '4G']),
      JSON.stringify([{ switch_id: 'SW2', position: 'reverse' }]));
  });
  tx();
  console.log('[db] 已写入示例站场数据');
}

init();
seed();

module.exports = db;
