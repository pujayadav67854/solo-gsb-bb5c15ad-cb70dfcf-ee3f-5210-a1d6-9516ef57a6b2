'use strict';
const path = require('path');
const express = require('express');
const db = require('./src/db');
const il = require('./src/interlocking');
const admin = require('./src/admin');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = parseInt(process.env.PORT || '3000', 10);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''; // 为空则不启用口令

function wrap(fn) {
  return async (req, res) => {
    try {
      return await fn(req, res);
    } catch (err) {
      if (err instanceof il.HttpError) {
        return res.status(err.status).json({
          error: err.code,
          message: err.message,
          details: err.details || {},
        });
      }
      console.error(err);
      res.status(500).json({ error: 'INTERNAL', message: err.message });
    }
  };
}

// 管理员鉴权：配置 ADMIN_TOKEN 后，写操作须带 x-admin-token 或 ?token=
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  const token = req.get('x-admin-token') || req.query.token || '';
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: '管理员口令不正确' });
  }
  next();
}

// ---------------- 值班员 / 公共接口 ----------------
app.get('/api/state', wrap((req, res) => {
  res.json(il.getState());
}));

app.post('/api/routes/:id/open', wrap((req, res) => {
  const { positions, operator } = req.body || {};
  const result = il.openRoute(req.params.id, positions || {}, operator || '值班员');
  res.json(result);
}));

app.post('/api/events', wrap((req, res) => {
  const { section_id, seq, value } = req.body || {};
  const result = il.submitEvent(String(section_id || ''), parseInt(seq, 10), String(value || ''));
  res.json(result);
}));

app.post('/api/active/:activeId/release', wrap((req, res) => {
  const { operator } = req.body || {};
  res.json(il.releaseRoute(parseInt(req.params.activeId, 10), operator || '值班员'));
}));

// ---------------- 管理员接口 ----------------
app.post('/api/admin/sections', requireAdmin, wrap((req, res) => {
  const exists = db.prepare('SELECT 1 FROM sections WHERE id=?').get(req.body.id);
  res.status(exists ? 200 : 201).json(admin.upsertSection(req.body, !exists));
}));
app.post('/api/admin/sections/:id/layout', requireAdmin, wrap((req, res) => {
  admin.updateSectionLayout(req.params.id, req.body.x, req.body.y);
  res.json({ ok: true });
}));
app.delete('/api/admin/sections/:id', requireAdmin, wrap((req, res) => {
  res.json(admin.deleteSection(req.params.id));
}));

app.post('/api/admin/switches', requireAdmin, wrap((req, res) => {
  const exists = db.prepare('SELECT 1 FROM switches WHERE id=?').get(req.body.id);
  res.status(exists ? 200 : 201).json(admin.upsertSwitch(req.body, !exists));
}));
app.post('/api/admin/switches/:id/layout', requireAdmin, wrap((req, res) => {
  admin.updateSwitchLayout(req.params.id, req.body.x, req.body.y);
  res.json({ ok: true });
}));
app.delete('/api/admin/switches/:id', requireAdmin, wrap((req, res) => {
  res.json(admin.deleteSwitch(req.params.id));
}));

app.post('/api/admin/switch-links', requireAdmin, wrap((req, res) => {
  res.status(201).json(admin.setSwitchLink(req.body));
}));
app.delete('/api/admin/switch-links/:id', requireAdmin, wrap((req, res) => {
  res.json(admin.deleteSwitchLink(parseInt(req.params.id, 10)));
}));

app.post('/api/admin/signals', requireAdmin, wrap((req, res) => {
  const exists = db.prepare('SELECT 1 FROM signals WHERE id=?').get(req.body.id);
  res.status(exists ? 200 : 201).json(admin.upsertSignal(req.body, !exists));
}));
app.post('/api/admin/signals/:id/layout', requireAdmin, wrap((req, res) => {
  const r = db.prepare('UPDATE signals SET x=?, y=? WHERE id=?')
    .run(Number(req.body.x) || 0, Number(req.body.y) || 0, req.params.id);
  if (!r.changes) throw new il.HttpError(404, 'NOT_FOUND', `信号机 ${req.params.id} 不存在`);
  res.json({ ok: true });
}));
app.delete('/api/admin/signals/:id', requireAdmin, wrap((req, res) => {
  res.json(admin.deleteSignal(req.params.id));
}));

app.post('/api/admin/routes', requireAdmin, wrap((req, res) => {
  const exists = db.prepare('SELECT 1 FROM routes WHERE id=?').get(req.body.id);
  res.status(exists ? 200 : 201).json(admin.upsertRoute(req.body, !exists));
}));
app.delete('/api/admin/routes/:id', requireAdmin, wrap((req, res) => {
  res.json(admin.deleteRoute(req.params.id));
}));

app.post('/api/admin/reset-runtime', requireAdmin, wrap((req, res) => {
  res.json(admin.resetRuntime());
}));

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', message: '接口不存在' });
});

app.listen(PORT, () => {
  console.log(`进路联锁推演台已启动: http://localhost:${PORT}`);
});
