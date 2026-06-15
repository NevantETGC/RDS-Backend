// ============================================================
//  RDS Backend API — server.js
//  Ridgeline Fire Rescue — Region Defense System
//  Rewritten clean: 2026-05-02
// ============================================================

const express = require('express');
const { Pool } = require('pg');
const cors    = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
// ============================================================
//  DIGITALOCEAN SPACES — File Upload
// ============================================================
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const multer   = require('multer');
const multerS3 = require('multer-s3');

const s3 = new S3Client({
  endpoint: process.env.SPACES_ENDPOINT,
  region:   process.env.SPACES_REGION,
  credentials: {
    accessKeyId:     process.env.SPACES_KEY,
    secretAccessKey: process.env.SPACES_SECRET
  },
  forcePathStyle: false
});

const upload = multer({
  storage: multerS3({
    s3:      s3,
    bucket:  process.env.SPACES_BUCKET,
    acl:     'public-read',
    key: function (req, file, cb) {
      const folder = req.query.folder || 'general';
      const ext    = file.originalname.split('.').pop();
      const name   = Date.now() + '-' + Math.round(Math.random() * 1e6) + '.' + ext;
      cb(null, folder + '/' + name);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: function (req, file, cb) {
    const allowed = ['image/jpeg','image/png','image/gif','image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

// POST /upload?folder=civilians|perps|vehicles|evidence
app.post('/upload', upload.single('photo'), (req, res) => {
  const url = process.env.SPACES_CDN + '/' + req.file.key;
  res.json({ url, key: req.file.key });
});

// DELETE /upload?key=folder/filename.jpg
app.delete('/upload', async (req, res) => {
  const key = req.query.key;
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.SPACES_BUCKET, Key: key }));
    res.json({ deleted: true, key });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON', detail: err.message });
  }
  next(err);
});
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} - Body: ${JSON.stringify(req.body)}`);
  next();
});

const pool = new Pool({
  user:     process.env.DB_USER     || 'hydrant_user',
  host:     process.env.DB_HOST     || 'localhost',
  database: process.env.DB_NAME     || 'hydrant_db',
  password: process.env.DB_PASSWORD,
  port:     process.env.DB_PORT     || 5432
});

// ============================================================
//  INCIDENTS — Hydrant knockdowns
// ============================================================

app.post('/incident', async (req, res) => {
  const { sim_name, hydrant_name, avatar_name, vehicle_name,
          incident_date, incident_time, world_x, world_y } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const priority = avatar_name === 'UNKNOWN' ? 'investigate' : 'normal';
    const inc = await client.query(
      `INSERT INTO incidents
         (sim_name, hydrant_name, avatar_name, vehicle_name,
          incident_date, incident_time, priority, world_x, world_y)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [sim_name, hydrant_name, avatar_name, vehicle_name,
       incident_date, incident_time, priority,
       world_x || 128, world_y || 128]
    );
    const id = inc.rows[0].id;
    await client.query(
      `INSERT INTO notifications (incident_id, department, message) VALUES ($1,$2,$3)`,
      [id, 'dpw', 'New hydrant down: ' + hydrant_name + ' in ' + sim_name]
    );
    await client.query(
      `INSERT INTO notifications (incident_id, department, message) VALUES ($1,$2,$3)`,
      [id, 'fd', 'Hydrant down: ' + hydrant_name + ' in ' + sim_name]
    );
    if (avatar_name !== 'UNKNOWN') {
      await client.query(
        `INSERT INTO notifications (incident_id, department, message) VALUES ($1,$2,$3)`,
        [id, 'pd', 'Citation candidate: ' + avatar_name + ' in ' + sim_name]
      );
    } else {
      await client.query(
        `INSERT INTO notifications (incident_id, department, message) VALUES ($1,$2,$3)`,
        [id, 'pd', 'Unknown driver investigation needed: ' + sim_name]
      );
    }
    await client.query('COMMIT');
    res.json(inc.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.get('/incidents', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM incidents ORDER BY created_at DESC');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/incidents/:dept', async (req, res) => {
  const dept = req.params.dept;
  try {
    let q = 'SELECT * FROM incidents ORDER BY created_at DESC';
    if (dept === 'pd') q = "SELECT * FROM incidents WHERE resolved = false ORDER BY created_at DESC";
    if (dept === 'fd') q = "SELECT * FROM incidents WHERE hydrant_status = 'down' AND resolved = false AND dismissed_fd = false ORDER BY created_at DESC";
    const r = await pool.query(q);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/incident/:id/assign', async (req, res) => {
  const { department, assigned_by, notes } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      "UPDATE incidents SET assigned_to = $1, assigned_at = NOW() WHERE id = $2 RETURNING *",
      [department, req.params.id]
    );
    await client.query(
      'INSERT INTO assignments (incident_id, assigned_to, assigned_by, notes) VALUES ($1,$2,$3,$4)',
      [req.params.id, department, assigned_by || department, notes || '']
    );
    await client.query(
      'UPDATE notifications SET seen = true WHERE incident_id = $1 AND department = $2',
      [req.params.id, department]
    );
    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.patch('/incident/:id/acknowledge', async (req, res) => {
  const { department } = req.body;
  try {
    const r = await pool.query(
      "UPDATE incidents SET acknowledged_at = NOW(), assigned_to = $1, hydrant_status = 'responding' WHERE id = $2 RETURNING *",
      [department, req.params.id]
    );
    await pool.query(
      'UPDATE notifications SET seen = true WHERE incident_id = $1 AND department = $2',
      [req.params.id, department]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/incident/:id/resolve', async (req, res) => {
  const { notes } = req.body;
  try {
    const r = await pool.query(
      "UPDATE incidents SET resolved = true, hydrant_status = 'repaired', notes = COALESCE($1, notes) WHERE id = $2 RETURNING *",
      [notes || null, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/incident/:id/ticket', async (req, res) => {
  const { notes } = req.body;
  const ticket = 'TKT-' + Date.now().toString().slice(-6);
  try {
    const r = await pool.query(
      "UPDATE incidents SET ticket_number = $1, notes = $2, assigned_to = 'pd' WHERE id = $3 RETURNING *",
      [ticket, notes || '', req.params.id]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/incident/:id/investigate', async (req, res) => {
  const { notes } = req.body;
  try {
    const r = await pool.query(
      "UPDATE incidents SET priority = 'investigate', notes = $1, assigned_to = 'pd' WHERE id = $2 RETURNING *",
      [notes || '', req.params.id]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/incident/:id/notes', async (req, res) => {
  const { notes } = req.body;
  try {
    const r = await pool.query(
      "UPDATE incidents SET notes = $1 WHERE id = $2 RETURNING *",
      [notes || '', req.params.id]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/incidents/dismiss-fd', async (req, res) => {
  try {
    await pool.query(
      'UPDATE incidents SET dismissed_fd = true WHERE dismissed_fd = false AND resolved = false'
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  NOTIFICATIONS — Hydrant/incident notifications per dept
// ============================================================

app.get('/notifications/:dept', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT n.*, i.sim_name, i.hydrant_name, i.avatar_name, i.vehicle_name,
              i.incident_date, i.incident_time, i.assigned_to, i.priority
       FROM notifications n
       JOIN incidents i ON n.incident_id = i.id
       WHERE n.department = $1 AND n.seen = false
       ORDER BY n.created_at DESC`,
      [req.params.dept]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/notifications/:dept/seen', async (req, res) => {
  try {
    await pool.query(
      'UPDATE notifications SET seen = true WHERE department = $1',
      [req.params.dept]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  VIOLATIONS — Speed camera
// ============================================================

app.post('/violation', async (req, res) => {
  const { sim_name, avatar_name, vehicle_name, speed_recorded,
          speed_limit, zone_name, violation_date, violation_time } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const v = await client.query(
      `INSERT INTO violations
         (sim_name, avatar_name, vehicle_name, speed_recorded,
          speed_limit, zone_name, violation_date, violation_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [sim_name, avatar_name, vehicle_name, speed_recorded,
       speed_limit, zone_name || 'Main Road', violation_date, violation_time]
    );
    const vid = v.rows[0].id;
    await client.query(
      `INSERT INTO notifications (incident_id, department, message) VALUES ($1,$2,$3)`,
      [vid, 'pd',
       'Speed violation: ' + avatar_name + ' doing ' + speed_recorded +
       ' mph in ' + (zone_name || 'Main Road') + ' (' + speed_limit + ' mph zone)']
    );
    await client.query('COMMIT');
    res.json(v.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.get('/violations', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM violations ORDER BY created_at DESC');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/violations/pd', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM violations WHERE resolved = false ORDER BY created_at DESC'
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/violation/:id/ticket', async (req, res) => {
  const { notes } = req.body;
  const ticket = 'SPD-' + Date.now().toString().slice(-6);
  try {
    const r = await pool.query(
      "UPDATE violations SET ticket_number = $1, notes = $2, resolved = true WHERE id = $3 RETURNING *",
      [ticket, notes || '', req.params.id]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/violation/:id/dismiss', async (req, res) => {
  const { notes } = req.body;
  try {
    const r = await pool.query(
      "UPDATE violations SET resolved = true, notes = $1 WHERE id = $2 RETURNING *",
      [notes || 'Dismissed', req.params.id]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  FIRE ALARMS — Smoke detector pipeline
// ============================================================

app.post('/alarm', async (req, res) => {
  const { detector_code, sim_code, parcel_code, detector_num, region,
          alarm_type, fire_count, smoke_count, ladder_triggered,
          first_detected, world_x, world_y, slurl } = req.body;
  const org = req.body.org_code || 'rfr';
  const incidentType = req.body.incident_type || null;
  const unitsRaw = req.body.units;
  const units = Array.isArray(unitsRaw) ? unitsRaw.join(',') : (unitsRaw || null);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      "SELECT id, status, ladder_triggered FROM fire_alarms WHERE detector_code = $1 AND status != 'cleared' AND alarm_type != 'CLEAR'",
      [detector_code]
    );
    let alarm;
    if (alarm_type === 'CLEAR') {
      if (existing.rows.length > 0) {
        alarm = await client.query(
          "UPDATE fire_alarms SET alarm_type = 'CLEAR', status = 'cleared', fire_count = 0, smoke_count = 0, last_updated = NOW() WHERE detector_code = $1 AND status != 'cleared' RETURNING *",
          [detector_code]
        );
      } else {
        await client.query('COMMIT');
        return res.json({ ok: true, message: 'No active alarm to clear' });
      }
    } else if (existing.rows.length > 0) {
      const wasLadder = existing.rows[0].ladder_triggered;
      alarm = await client.query(
        "UPDATE fire_alarms SET alarm_type = $1, fire_count = $2, smoke_count = $3, ladder_triggered = $4, last_updated = NOW() WHERE detector_code = $5 AND status != 'cleared' RETURNING *",
        [alarm_type, fire_count || 0, smoke_count || 0, ladder_triggered || false, detector_code]
      );
      if (ladder_triggered && !wasLadder) {
        const alarmId = existing.rows[0].id;
        const location = sim_code + '-' + parcel_code;
        await client.query(
          'INSERT INTO alarm_notifications (alarm_id, department, message, org_code) VALUES ($1,$2,$3,$4)',
          [alarmId, 'fd', 'LADDER ESCALATION: ' + detector_code + ' at ' + location + ' | Fire objects: ' + fire_count, org]
        );
      }
    } else {
      alarm = await client.query(
        "INSERT INTO fire_alarms (detector_code, sim_code, parcel_code, detector_num, region, alarm_type, fire_count, smoke_count, ladder_triggered, first_detected, last_updated, status, world_x, world_y, org_code, incident_type, units_dispatched) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),'active',$11,$12,$13,$14,$15) RETURNING *",
        [detector_code, sim_code, parcel_code, detector_num, region,
         alarm_type, fire_count || 0, smoke_count || 0, ladder_triggered || false,
         first_detected || new Date().toISOString(), world_x || 128, world_y || 128, org, incidentType, units]
      );
      const alarmId = alarm.rows[0].id;
      const location = sim_code + '-' + parcel_code;
      await client.query(
        'INSERT INTO alarm_notifications (alarm_id, department, message, org_code) VALUES ($1,$2,$3,$4)',
        [alarmId, 'fd', 'Fire alarm: ' + detector_code + ' at ' + location + ' | ' + alarm_type, org]
      );
      await client.query(
        'INSERT INTO alarm_notifications (alarm_id, department, message, org_code) VALUES ($1,$2,$3,$4)',
        [alarmId, 'pd', 'Fire alarm reported at ' + location + ' (' + region + ')', org]
      );
      // Auto-create a dispatch_call so the alarm persists in the dispatcher
      // queue until a dispatcher manually clears it (FD side still auto-clears).
      const dispSlurl = slurl || ('secondlife://' + (region||'').replace(/ /g,'%20') + '/' + (world_x||128) + '/' + (world_y||128) + '/0');
      await client.query(
        `INSERT INTO dispatch_calls
           (org_code, caller_name, location, call_type, incident_type, units, notes, status, dispatcher, dispatched, alarm_id, dispatched_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,true,$9,NOW())`,
        [org, 'Smoke Detector (' + detector_code + ')', dispSlurl, 'fire',
         incidentType || 'Structure Fire', units || 'Engine,Ladder,Battalion',
         'Auto-dispatched by detector ' + detector_code + ' at ' + (region||'') + '. Alarm type: ' + alarm_type + '.',
         'AUTO (Detector)', alarmId]
      );
    }
    await client.query('COMMIT');
    res.json(alarm.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.get('/alarms/fd', async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT * FROM fire_alarms WHERE status != 'cleared' ORDER BY last_updated DESC"
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/alarms/pd', async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT id, sim_code, parcel_code, region, alarm_type, first_detected, last_updated, status FROM fire_alarms WHERE status != 'cleared' ORDER BY last_updated DESC"
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/alarms', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM fire_alarms ORDER BY last_updated DESC');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/alarm/:id/claim', async (req, res) => {
  try {
    const r = await pool.query(
      "UPDATE fire_alarms SET status = 'responding', claimed_at = NOW() WHERE id = $1 RETURNING *",
      [req.params.id]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/alarm/:id/silence', async (req, res) => {
  try {
    const r = await pool.query(
      "UPDATE fire_alarms SET status = 'silenced', last_updated = NOW() WHERE id = $1 RETURNING *",
      [req.params.id]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/alarm/:id/reset', async (req, res) => {
  try {
    const r = await pool.query(
      "UPDATE fire_alarms SET status = 'cleared', last_updated = NOW() WHERE id = $1 RETURNING *",
      [req.params.id]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/alarm/:id/notes', async (req, res) => {
  const { notes } = req.body;
  try {
    const r = await pool.query(
      "UPDATE fire_alarms SET notes = $1, last_updated = NOW() WHERE id = $2 RETURNING *",
      [notes || '', req.params.id]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  ALARM NOTIFICATIONS — Panel polling
// ============================================================

app.get('/alarm-notifications/:dept', async (req, res) => {
  try {
    const org = req.query.org || null;
    let query = `SELECT fa.detector_code, fa.sim_code, fa.parcel_code, fa.detector_num,
              fa.region, fa.alarm_type, fa.fire_count, fa.smoke_count,
              fa.ladder_triggered, fa.first_detected,
              COALESCE(fa.incident_type, fa.alarm_type) AS incident_type,
              COALESCE(fa.units_dispatched, '') AS units_dispatched,
              'secondlife://' || replace(fa.region, ' ', '%20') || '/' ||
              fa.world_x || '/' || fa.world_y || '/0' AS slurl
       FROM alarm_notifications an
       JOIN fire_alarms fa ON an.alarm_id = fa.id
       WHERE an.department = $1 AND an.seen_panel = false`;
    const params = [req.params.dept];
    if (org) { params.push(org); query += ` AND an.org_code = $${params.length}`; }
    query += ` ORDER BY an.created_at ASC LIMIT 1`;
    const r = await pool.query(query, params);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/alarm-notifications/:dept/seen', async (req, res) => {
  try {
    const org = req.query.org || null;
    // Require org_code to prevent cross-community contamination
    if (!org) { return res.json({ ok: true, skipped: 'org_code required' }); }
    await pool.query(
      'UPDATE alarm_notifications SET seen = true WHERE department = $1 AND org_code = $2',
      [req.params.dept, org]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


app.patch('/alarm-notifications/:dept/seen-panel', async (req, res) => {
  try {
    var payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch(e) {} }
    const org = (payload && payload.org_code) || req.query.org || null;
    let query = 'UPDATE alarm_notifications SET seen_panel = true WHERE department = $1';
    const params = [req.params.dept];
    if (org) { params.push(org); query += ` AND org_code = $${params.length}`; }
    await pool.query(query, params);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.patch('/alarm-notifications/:dept/reset', async (req, res) => {
  const client = await pool.connect();
  try {
    const org = req.query.org || null;
    // Require org to prevent wiping all communities
    if (!org) { return res.json({ ok: true, skipped: 'org required' }); }
    await client.query('BEGIN');
    await client.query(
      'UPDATE alarm_notifications SET seen = true, seen_panel = true WHERE department = $1 AND org_code = $2',
      [req.params.dept, org]
    );
    await client.query(
      "UPDATE fire_alarms SET status = 'cleared' WHERE id IN (SELECT alarm_id FROM alarm_notifications WHERE department = $1 AND org_code = $2) AND org_code = $2",
      [req.params.dept, org]
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});


// ============================================================
//  BEEPER notifications (separate seen tracking)
// ============================================================
app.get('/alarm-notifications/:dept/beeper', async (req, res) => {
  try {
    const org = req.query.org || null;
    // Time-window based: return active alarms from the last 90 seconds so
    // EVERY pager polling in that window fires (no shared seen-flag race).
    let query = `SELECT fa.detector_code, fa.sim_code, fa.parcel_code, fa.detector_num,
              fa.region, fa.alarm_type, fa.fire_count, fa.smoke_count,
              fa.ladder_triggered, fa.first_detected,
              COALESCE(fa.incident_type, fa.alarm_type) AS incident_type,
              COALESCE(fa.units_dispatched, '') AS units_dispatched,
              'secondlife://' || replace(fa.region, ' ', '%20') || '/' ||
              fa.world_x || '/' || fa.world_y || '/0' AS slurl
       FROM alarm_notifications an
       JOIN fire_alarms fa ON an.alarm_id = fa.id
       WHERE an.department = $1
         AND fa.status = 'active'
         AND an.created_at >= NOW() - INTERVAL '90 seconds'`;
    const params = [req.params.dept];
    if (org) { params.push(org); query += ` AND an.org_code = $${params.length}`; }
    query += ` ORDER BY an.created_at ASC LIMIT 5`;
    const r = await pool.query(query, params);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/alarm-notifications/:dept/beeper/seen', async (req, res) => {
  try {
    const org = req.query.org || null;
    if (!org) return res.json({ ok: true, skipped: 'org required' });
    await pool.query(
      'UPDATE alarm_notifications SET beeper_seen = true WHERE department = $1 AND org_code = $2',
      [req.params.dept, org]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  DISCORD WEBHOOK
// ============================================================
// ============================================================
//  DISCORD WEBHOOKS — one per community
//  Set to "" to disable for that community
// ============================================================
const DISCORD_WEBHOOKS = {
  rfr:     "https://discord.com/api/webhooks/1512701506649063515/bE_chqAycfPnllc0q3cQU4fV500GT423UdonmVe30e5SKS__PUNHZmxx_assudASUpRg",
  harmony: "https://discord.com/api/webhooks/1513684583248429096/1YtEtLUQn4vRaihMAr1MvnFfMMSU2MBZSBpnO75A6EGuUCORzz706pc5vwka4REAASDb",
  willow:  ""
};

async function postDiscord(title, color, fields, org) {
  try {
    const webhook = (org && DISCORD_WEBHOOKS[org]) ? DISCORD_WEBHOOKS[org] : DISCORD_WEBHOOKS.rfr;
    if (!webhook) return;
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [{
          title,
          color,
          fields,
          timestamp: new Date().toISOString()
        }]
      })
    });
  } catch (err) {
    console.error("Discord webhook error:", err.message);
  }
}
// ============================================================
//  DISPATCH — SmartBot fire dispatch
// ============================================================

app.post('/dispatch/fire', async (req, res) => {
  try {
    var payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch(e) {} }
    const { caller_name, region, address, issue, timestamp, org_code, incident_type, units } = payload;
    const org         = org_code || 'rfr';
    const parcel_code = (address || 'UNKNOWN').substring(0, 20);
    const location    = 'DISP-' + parcel_code;
    const alarmResult = await pool.query(
      `INSERT INTO fire_alarms
         (detector_code, sim_code, parcel_code, detector_num, region,
          alarm_type, fire_count, smoke_count, ladder_triggered, status, org_code,
          incident_type, units_dispatched, first_detected)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW()) RETURNING id`,
      ['DISPATCH', 'DISP', parcel_code, 'D1',
       region || 'UNKNOWN', 'FIRE', 1, 0, false, 'active', org,
       incident_type || null, Array.isArray(units) ? units.join(',') : (units || null)]
    );
    const alarmId = alarmResult.rows[0].id;
    const notifResult = await pool.query(
      'INSERT INTO alarm_notifications (alarm_id, department, message, org_code) VALUES ($1,$2,$3,$4) RETURNING id',
      [alarmId, 'fd', 'Fire reported at ' + location + ' by ' + caller_name + ' | ' + issue, org]
    );
    console.log('[dispatch/fire] alarm_id=' + alarmId + ' notif_id=' + notifResult.rows[0].id + ' org=' + org);
    await postDiscord("🔥 FIRE DISPATCH", 0xFF4500, [
      { name: "Caller",   value: caller_name || "Unknown", inline: true },
      { name: "Location", value: address     || "Unknown", inline: true },
      { name: "Incident", value: incident_type || "Fire", inline: true },
      { name: "Units",    value: Array.isArray(units) ? units.join(", ") : (units || "Unknown"), inline: true },
      { name: "Details",  value: issue       || "No details provided", inline: false }
    ], org);
    res.json({ success: true, alarm_id: alarmId });
  } catch (err) {
    console.log('[dispatch/fire] ERROR: ' + err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  DISPATCH — SmartBot medical dispatch
// ============================================================
app.post('/dispatch/medical', async (req, res) => {
  const client = await pool.connect();
  try {
    var payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch(e) {} }
    const { caller_name, region, issue, timestamp, org_code, incident_type, units } = payload;
    const org = org_code || 'rfr';
    const alarmResult = await client.query(
      `INSERT INTO fire_alarms
         (detector_code, sim_code, parcel_code, detector_num, region,
          alarm_type, fire_count, smoke_count, ladder_triggered, status, org_code,
          incident_type, units_dispatched, first_detected)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW()) RETURNING id`,
      ['DISPATCH', 'DISP', region || 'UNKNOWN', 'D1',
       region || 'UNKNOWN', 'MEDICAL', 0, 0, false, 'active', org,
       incident_type || null, Array.isArray(units) ? units.join(',') : (units || null)]
    );
    const alarmId = alarmResult.rows[0].id;
    await client.query(
      'INSERT INTO alarm_notifications (alarm_id, department, message, org_code) VALUES ($1,$2,$3,$4)',
      [alarmId, 'fd',
       'Medical emergency reported by ' + caller_name + ' at ' + region + ' | ' + issue, org]
    );
    await postDiscord("🚑 MEDICAL DISPATCH", 0x9B59B6, [
      { name: "Caller",   value: caller_name || "Unknown", inline: true },
      { name: "Location", value: region      || "Unknown", inline: true },
      { name: "Incident", value: incident_type || "Medical", inline: true },
      { name: "Units",    value: Array.isArray(units) ? units.join(", ") : (units || "Unknown"), inline: true },
      { name: "Details",  value: issue       || "No details provided", inline: false }
    ], org);
    res.json({ success: true, alarm_id: alarmId });
  } catch (err) {
    console.log('[dispatch/medical] ERROR: ' + err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});
// ============================================================
//  MEDICAL ALERTS — Life Alert + SmartBot medical dispatch
// ============================================================

app.post('/medical', async (req, res) => {
  try {
    const { avatar_name, avatar_key, region, world_x, world_y,
            emergency_type, timestamp, slurl } = req.body;
    await pool.query(
      `INSERT INTO medical_alerts
         (avatar_name, avatar_key, region, world_x, world_y,
          emergency_type, timestamp, slurl)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [avatar_name, avatar_key || '', region, world_x || 128, world_y || 128,
       emergency_type, timestamp, slurl || '']
    );
    await postDiscord("🚑 MEDICAL ALERT — 911 Button", 0x9B59B6, [
      { name: "Avatar",    value: avatar_name    || "Unknown",  inline: true },
      { name: "Region",    value: region         || "Unknown",  inline: true },
      { name: "Emergency", value: emergency_type || "Unknown",  inline: false },
      { name: "Location",  value: slurl          || "No SLURL", inline: false }
    ]);
    res.status(201).json({ status: 'ok' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Pending — panel/beeper polls this for unseen medical alerts
app.get('/medical/pending', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM medical_alerts WHERE seen_panel = FALSE ORDER BY created_at ASC'
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Beeper-specific pending — uses separate beeper_seen column
app.get('/medical/pending-beeper', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM medical_alerts WHERE beeper_seen = FALSE ORDER BY created_at ASC'
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Mark seen — panel (seen-panel route that v3.2 actually calls)
app.patch('/medical/seen-panel', async (req, res) => {
  try {
    await pool.query(
      'UPDATE medical_alerts SET seen_panel = TRUE WHERE seen_panel = FALSE'
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Mark seen — beeper
app.patch('/medical/seen-beeper', async (req, res) => {
  try {
    await pool.query(
      'UPDATE medical_alerts SET beeper_seen = TRUE WHERE beeper_seen = FALSE'
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Mark seen — panel calls this AFTER successfully processing alerts
// Only marks the specific IDs it received, not everything in the table
app.patch('/medical/seen', async (req, res) => {
  const { ids } = req.body;
  try {
    if (Array.isArray(ids) && ids.length > 0) {
      await pool.query(
        'UPDATE medical_alerts SET seen_panel = TRUE WHERE id = ANY($1::int[])',
        [ids]
      );
    } else {
      // Fallback: mark all unseen (legacy behaviour)
      await pool.query(
        'UPDATE medical_alerts SET seen_panel = TRUE WHERE seen_panel = FALSE'
      );
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// All medical records — dashboard history view
app.get('/medical/all', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM medical_alerts ORDER BY created_at DESC LIMIT 50'
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Dismiss a single medical alert from dashboard
app.patch('/medical/:id/dismiss', async (req, res) => {
  try {
    await pool.query(
      'UPDATE medical_alerts SET seen_panel = TRUE WHERE id = $1',
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  DETECTORS — Smoke detector registry
// ============================================================

// [removed duplicate detector/register route]

app.get('/detectors', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM detectors ORDER BY state DESC, detector_code ASC'
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/detector/:code/hard_reset', async (req, res) => {
  const code = req.params.code;
  try {
    await pool.query(
      'UPDATE detectors SET state = 0, last_seen = NOW() WHERE detector_code = $1',
      [code]
    );
    await pool.query(
      "UPDATE fire_alarms SET status = 'cleared', last_updated = NOW() WHERE detector_code = $1 AND status != 'cleared'",
      [code]
    );
    await pool.query(
      'INSERT INTO detector_commands (detector_code, command) VALUES ($1,$2)',
      [code, 'HARD_RESET']
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/detector/commands/pending', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM detector_commands WHERE relayed = FALSE ORDER BY created_at ASC'
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/detector/commands/clear', async (req, res) => {
  try {
    await pool.query('UPDATE detector_commands SET relayed = TRUE WHERE relayed = FALSE');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  CAMERA CONFIG — Speed camera zones
// ============================================================

app.get('/camera/config/:sim_name', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM camera_configs WHERE sim_name = $1',
      [req.params.sim_name]
    );
    if (r.rows.length === 0) {
      res.json({
        sim_name: req.params.sim_name, speed_limit: 20.0,
        scan_radius: 25.0, alert_driver: true, zone_name: 'Main Road'
      });
    } else { res.json(r.rows[0]); }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/camera/config', async (req, res) => {
  const { sim_name, speed_limit, scan_radius, alert_driver, zone_name } = req.body;
  try {
    const r = await pool.query(
      `INSERT INTO camera_configs (sim_name, speed_limit, scan_radius, alert_driver, zone_name, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (sim_name) DO UPDATE SET
         speed_limit  = $2,
         scan_radius  = $3,
         alert_driver = $4,
         zone_name    = $5,
         updated_at   = NOW()
       RETURNING *`,
      [sim_name, speed_limit || 20.0, scan_radius || 25.0,
       alert_driver !== false, zone_name || 'Main Road']
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/camera/configs', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM camera_configs ORDER BY sim_name');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  MAP — Live hydrant + alarm map data
// ============================================================

const SIM_CODES = {
  'Cherokee Rose Lake': 'A', 'Oakley Springs':    'B',
  'Crescent Creek':    'C', 'Hidden Hollow':      'E',
  'Meadowview Heights':'F', 'MeadowView Heights': 'F',
  'Cloverdale Ridge':  'I'
};

app.get('/hydrants', async (req, res) => {
  try {
    const org = req.query.org || null;
    let query = `
      SELECT DISTINCT ON (hydrant_name)
        id, hydrant_name AS name, sim_name, world_x, world_y,
        CASE WHEN resolved = true THEN 'ok' ELSE 'knocked' END AS status,
        avatar_name, incident_date, incident_time, created_at, resolved,
        org_code
      FROM incidents
    `;
    const params = [];
    if (org) {
      query += ` WHERE org_code = $1`;
      params.push(org);
    }
    query += ` ORDER BY hydrant_name, created_at DESC`;
    const r = await pool.query(query, params);
    const rows = r.rows.map(row => ({
      ...row,
      sim_code: SIM_CODES[row.sim_name] || row.sim_name.charAt(0).toUpperCase()
    }));
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/map/active', async (req, res) => {
  try {
    const alarms = await pool.query(`
      SELECT id, detector_code AS code, sim_code, parcel_code, region,
             alarm_type, fire_count, smoke_count, ladder_triggered,
             world_x, world_y, status, first_detected, last_updated
      FROM fire_alarms
      WHERE status != 'cleared'
      ORDER BY last_updated DESC
    `);
    const hydrants = await pool.query(`
      SELECT DISTINCT ON (hydrant_name)
        id, hydrant_name AS name, sim_name, world_x, world_y,
        CASE WHEN resolved = true THEN 'ok' ELSE 'knocked' END AS status,
        created_at
      FROM incidents
      ORDER BY hydrant_name, created_at DESC
    `);
    res.json({
      alarms:       alarms.rows,
      hydrants:     hydrants.rows.map(h => ({
        ...h,
        sim_code: SIM_CODES[h.sim_name] || h.sim_name.charAt(0).toUpperCase()
      })),
      generated_at: new Date().toISOString()
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  START
// ============================================================



// ============================================================
//  TIMECLOCK API — Receives events from DM Business Payroll
// ============================================================

const TIMECLOCK_KEYS = {
  'RFR-TC-2024-3430LABS': 'rfr',
  'HH-TC-2024-3430LABS':  'harmony',
  'HK-TC-2024-3430LABS':  'hemlock',
  'WF-TC-2024-3430LABS':  'willow'
};

function validateTimeclockKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.headers['authorization'];
  if (!key || !TIMECLOCK_KEYS[key]) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  req.timeclockOrg = TIMECLOCK_KEYS[key];
  next();
}

app.post('/timeclock', validateTimeclockKey, async (req, res) => {
  try {
    var payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch(e) {} }
    const { event, department, org_code, timestamp, notes } = payload;
    const avatar_name = payload.avatar_name || payload.avata_name || '';
    const avatar_key  = payload.avatar_key  || payload.avata_key  || '';
    const eventLower = (event || '').toLowerCase();
    const org  = req.timeclockOrg || org_code || 'rfr';
    const ts   = timestamp || new Date().toISOString();
    const dept = (department || 'fd').toLowerCase();
    const name = avatar_name || avatar_key || 'Unknown';
    console.log('[timeclock] Event: ' + event + ' | Avatar: ' + avatar_name);
    if (eventLower === 'clock_in' || eventLower === 'clock in') {
      await pool.query('UPDATE timeclock_shifts SET clock_out = NOW(), active = false WHERE avatar_name = $1 AND org_code = $2 AND active = true', [name, org]);
      await pool.query('INSERT INTO timeclock_shifts (avatar_name, avatar_key, department, org_code, clock_in, active, notes) VALUES ($1,$2,$3,$4,NOW(),true,$5)', [name, avatar_key || '', dept, org, notes || '']);
      res.json({ success: true, event: 'Clock In', avatar: name });
    } else if (eventLower === 'clock_out' || eventLower === 'clock out') {
      const result = await pool.query('UPDATE timeclock_shifts SET clock_out = NOW(), active = false WHERE avatar_name = $1 AND org_code = $2 AND active = true RETURNING id, clock_in, clock_out', [name, org]);
      if (result.rows.length > 0) {
        const shift = result.rows[0];
        const hours = ((new Date(shift.clock_out) - new Date(shift.clock_in)) / 3600000).toFixed(2);
        res.json({ success: true, event: 'Clock Out', avatar: name, hours_worked: hours });
      } else {
        res.json({ success: true, event: 'Clock Out', avatar: name, note: 'No active shift found' });
      }
    } else {
      await pool.query('INSERT INTO timeclock_events (avatar_name, avatar_key, department, org_code, event_type, timestamp, notes) VALUES ($1,$2,$3,$4,$5,$6,$7)', [avatar_name, avatar_key || '', dept, org, event, ts, notes || JSON.stringify(payload)]);
      res.json({ success: true, event: event, avatar: avatar_name });
    }
  } catch (err) {
    console.log('[timeclock] ERROR: ' + err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/timeclock/test', validateTimeclockKey, async (req, res) => {
  res.json({ success: true, message: 'API Connection Successful', system: 'RES Timeclock — 3430Labs', timestamp: new Date().toISOString() });
});

app.get('/timeclock/active', async (req, res) => {
  try {
    const org = req.query.org || 'rfr';
    const dept = req.query.dept || null;
    let query = 'SELECT avatar_name, department, org_code, clock_in, ROUND(EXTRACT(EPOCH FROM (NOW() - clock_in))/3600, 2) AS hours_on FROM timeclock_shifts WHERE active = true AND org_code = $1';
    const params = [org];
    if (dept) { query += ' AND department = $2'; params.push(dept); }
    query += ' ORDER BY clock_in ASC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/timeclock/report', async (req, res) => {
  try {
    const org  = req.query.org  || 'rfr';
    const dept = req.query.dept || null;
    const days = parseInt(req.query.days) || 7;
    let query = `SELECT avatar_name, department, org_code, clock_in, clock_out, ROUND(EXTRACT(EPOCH FROM (COALESCE(clock_out, NOW()) - clock_in))/3600, 2) AS hours FROM timeclock_shifts WHERE org_code = $1 AND clock_in >= NOW() - INTERVAL '${days} days'`;
    const params = [org];
    if (dept) { query += ' AND department = $2'; params.push(dept); }
    query += ' ORDER BY clock_in DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});



// ============================================================
//  DISPATCH CAD ROUTES
// ============================================================

app.post('/cad/call', async (req, res) => {
  try {
    var payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch(e) {} }
    const { caller_name, caller_key, region, slurl, call_type, details, org_code } = payload;
    const org = org_code || 'rfr';
    const result = await pool.query(
      'INSERT INTO cad_calls (caller_name, caller_key, region, slurl, call_type, details, org_code, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,\'pending\',NOW()) RETURNING id',
      [caller_name||'Unknown', caller_key||'', region||'Unknown', slurl||'', call_type||'Unknown', details||'', org]
    );
    console.log('[cad] New call id=' + result.rows[0].id + ' from ' + caller_name);
    res.json({ success: true, call_id: result.rows[0].id });
  } catch (err) { console.log('[cad] ERROR: ' + err.message); res.status(500).json({ error: err.message }); }
});

app.get('/cad/calls', async (req, res) => {
  try {
    const org = req.query.org || 'rfr';
    const r = await pool.query(
      "SELECT * FROM cad_calls WHERE org_code = $1 AND status != 'cleared' ORDER BY created_at DESC",
      [org]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/cad/call/:id/claim', async (req, res) => {
  try {
    var payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch(e) {} }
    const { dispatcher } = payload;
    await pool.query("UPDATE cad_calls SET status='claimed', dispatcher=$1, claimed_at=NOW() WHERE id=$2", [dispatcher||'Dispatcher', req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/cad/call/:id/dispatch', async (req, res) => {
  try {
    var payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch(e) {} }
    const { incident_type, units, dispatcher, org_code } = payload;
    const org = org_code || 'rfr';
    await pool.query("UPDATE cad_calls SET status='dispatched', incident_type=$1, units=$2, dispatched_at=NOW() WHERE id=$3", [incident_type||'', JSON.stringify(units||[]), req.params.id]);
    const callRes = await pool.query('SELECT * FROM cad_calls WHERE id=$1', [req.params.id]);
    const call = callRes.rows[0];
    if (!call) return res.status(404).json({ error: 'Call not found' });
    const alarmResult = await pool.query(
      'INSERT INTO fire_alarms (detector_code, sim_code, parcel_code, detector_num, region, alarm_type, fire_count, smoke_count, ladder_triggered, status, first_detected) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW()) RETURNING id',
      ['CAD-DISP','DISP',(call.slurl||'').substring(0,20),'D1',call.region||'Unknown','FIRE',1,0,false,'active']
    );
    const alarmId = alarmResult.rows[0].id;
    const unitStr = (units||[]).join(', ');
    await pool.query('INSERT INTO alarm_notifications (alarm_id, department, message, org_code) VALUES ($1,$2,$3,$4)', [alarmId,'fd',(incident_type||'Fire')+' | Units: '+unitStr+' | '+(call.details||''),org]);
    console.log('[cad] Dispatched call id=' + req.params.id);
    res.json({ success: true, alarm_id: alarmId });
  } catch (err) { console.log('[cad] dispatch ERROR: ' + err.message); res.status(500).json({ error: err.message }); }
});

app.patch('/cad/call/:id/status', async (req, res) => {
  try {
    var payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch(e) {} }
    await pool.query("UPDATE cad_calls SET status=$1, updated_at=NOW() WHERE id=$2", [payload.status, req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/cad/call/:id/clear', async (req, res) => {
  try {
    await pool.query("UPDATE cad_calls SET status='cleared', cleared_at=NOW() WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});



// ============================================================
//  PD — Incidents
// ============================================================
app.post('/pd/incident', async (req, res) => {
  try {
    var p = req.body;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch(e) {} }
    const { community_org, incident_type, location, slurl, description, reporting_officer } = p;
    const org = community_org || 'hemlock';
    const r = await pool.query(
      "INSERT INTO pd_incidents (community_org, incident_type, location, slurl, description, reporting_officer, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,'active',NOW()) RETURNING *",
      [org, incident_type||'Unknown', location||'', slurl||'', description||'', reporting_officer||'']
    );
    res.json({ success: true, incident: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/pd/incidents', async (req, res) => {
  try {
    const org = req.query.org || 'hemlock';
    const r = await pool.query(
      "SELECT * FROM pd_incidents WHERE community_org = $1 ORDER BY created_at DESC LIMIT 50",
      [org]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/pd/incident/:id/close', async (req, res) => {
  try {
    await pool.query("UPDATE pd_incidents SET status='closed', closed_at=NOW() WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  PD — Records
// ============================================================
app.post('/pd/record', async (req, res) => {
  try {
    var p = req.body;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch(e) {} }
    const { subject_uuid, subject_name, community_org, record_type, incident_id, officer_name, charges, notes, photo_url, photo_key } = p;
    const org = community_org || 'hemlock';
    const r = await pool.query(
      "INSERT INTO pd_records (subject_uuid, subject_name, community_org, record_type, incident_id, officer_name, charges, notes, photo_url, photo_key, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW()) RETURNING *",
      [subject_uuid||'', subject_name||'', org, record_type||'arrest', incident_id||null, officer_name||'', charges||'', notes||'', photo_url||'', photo_key||'']
    );
    res.json({ success: true, record: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/pd/records', async (req, res) => {
  try {
    const org = req.query.org || 'hemlock';
    const subject = req.query.subject;
    let query = "SELECT * FROM pd_records WHERE community_org = $1";
    let params = [org];
    if (subject) { query += " AND (subject_name ILIKE $2 OR subject_uuid = $2)"; params.push('%' + subject + '%'); }
    query += ' ORDER BY created_at DESC LIMIT 100';
    const r = await pool.query(query, params);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/pd/record/:id', async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM pd_records WHERE id = $1", [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  PD — Warrants
// ============================================================
app.post('/pd/warrant', async (req, res) => {
  try {
    var p = req.body;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch(e) {} }
    const { subject_uuid, subject_name, community_org, reason, issued_by } = p;
    const org = community_org || 'hemlock';
    const r = await pool.query(
      "INSERT INTO warrants (subject_uuid, subject_name, community_org, reason, issued_by, status, issued_at) VALUES ($1,$2,$3,$4,$5,'active',NOW()) RETURNING *",
      [subject_uuid||'', subject_name||'', org, reason||'', issued_by||'']
    );
    res.json({ success: true, warrant: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/pd/warrants', async (req, res) => {
  try {
    const org = req.query.org || 'hemlock';
    const subject = req.query.subject;
    let query = "SELECT * FROM warrants WHERE community_org = $1 AND status = 'active'";
    let params = [org];
    if (subject) { query += " AND (subject_name ILIKE $2 OR subject_uuid = $2)"; params.push('%' + subject + '%'); }
    query += ' ORDER BY issued_at DESC';
    const r = await pool.query(query, params);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/pd/warrant/:id/serve', async (req, res) => {
  try {
    await pool.query("UPDATE warrants SET status='served', served_at=NOW() WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/pd/warrant/:id/dismiss', async (req, res) => {
  try {
    await pool.query("UPDATE warrants SET status='dismissed' WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  PD — BOLOs
// ============================================================
app.post('/pd/bolo', async (req, res) => {
  try {
    var p = req.body;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch(e) {} }
    const { community_org, subject_name, subject_uuid, vehicle_desc, reason, issued_by, photo_url, photo_key, expires_at } = p;
    const org = community_org || 'hemlock';
    const r = await pool.query(
      "INSERT INTO bolos (community_org, subject_name, subject_uuid, vehicle_desc, reason, issued_by, photo_url, photo_key, status, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',NOW(),$9) RETURNING *",
      [org, subject_name||'', subject_uuid||'', vehicle_desc||'', reason||'', issued_by||'', photo_url||'', photo_key||'', expires_at||null]
    );
    res.json({ success: true, bolo: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/pd/bolos', async (req, res) => {
  try {
    const org = req.query.org || 'hemlock';
    const r = await pool.query(
      "SELECT * FROM bolos WHERE community_org = $1 AND status = 'active' ORDER BY created_at DESC",
      [org]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/pd/bolo/:id/cancel', async (req, res) => {
  try {
    await pool.query("UPDATE bolos SET status='cancelled' WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  PD — Citations
// ============================================================
app.post('/pd/citation', async (req, res) => {
  try {
    var p = req.body;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch(e) {} }
    const { subject_uuid, subject_name, community_org, violation_type, fine_amount, location, officer_name, notes, expires_at } = p;
    const org = community_org || 'hemlock';
    const r = await pool.query(
      "INSERT INTO citations (subject_uuid, subject_name, community_org, violation_type, fine_amount, location, officer_name, notes, status, issued_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'unpaid',NOW(),$9) RETURNING *",
      [subject_uuid||'', subject_name||'', org, violation_type||'', fine_amount||0, location||'', officer_name||'', notes||'', expires_at||null]
    );
    res.json({ success: true, citation: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/pd/citations', async (req, res) => {
  try {
    const org = req.query.org || 'hemlock';
    const subject = req.query.subject;
    let query = "SELECT * FROM citations WHERE community_org = $1";
    let params = [org];
    if (subject) { query += " AND (subject_name ILIKE $2 OR subject_uuid = $2)"; params.push('%' + subject + '%'); }
    query += ' ORDER BY issued_at DESC LIMIT 100';
    const r = await pool.query(query, params);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/pd/citation/:id/pay', async (req, res) => {
  try {
    await pool.query("UPDATE citations SET status='paid' WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  PD — Jail / Booking
// ============================================================
app.post('/pd/jail/book', async (req, res) => {
  try {
    var p = req.body;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch(e) {} }
    const { subject_uuid, subject_name, community_org, reason, booked_by, cell } = p;
    const org = community_org || 'hemlock';
    const r = await pool.query(
      "INSERT INTO jail_log (subject_uuid, subject_name, community_org, reason, booked_by, cell, status, booked_at) VALUES ($1,$2,$3,$4,$5,$6,'held',NOW()) RETURNING *",
      [subject_uuid||'', subject_name||'', org, reason||'', booked_by||'', cell||'']
    );
    res.json({ success: true, booking: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/pd/jail', async (req, res) => {
  try {
    const org = req.query.org || 'hemlock';
    const r = await pool.query(
      "SELECT * FROM jail_log WHERE community_org = $1 AND status = 'held' ORDER BY booked_at DESC",
      [org]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/pd/jail/:id/release', async (req, res) => {
  try {
    await pool.query("UPDATE jail_log SET status='released', released_at=NOW() WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  PD — Subject Lookup
// ============================================================
app.get('/pd/subject', async (req, res) => {
  try {
    const org = req.query.org || 'hemlock';
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: 'Query required' });
    const search = '%' + q + '%';
    const [records, warrants, citations, jail, bolos] = await Promise.all([
      pool.query("SELECT * FROM pd_records WHERE community_org=$1 AND (subject_name ILIKE $2 OR subject_uuid=$3) ORDER BY created_at DESC LIMIT 20", [org, search, q]),
      pool.query("SELECT * FROM warrants WHERE community_org=$1 AND (subject_name ILIKE $2 OR subject_uuid=$3) AND status='active'", [org, search, q]),
      pool.query("SELECT * FROM citations WHERE community_org=$1 AND (subject_name ILIKE $2 OR subject_uuid=$3) ORDER BY issued_at DESC LIMIT 20", [org, search, q]),
      pool.query("SELECT * FROM jail_log WHERE community_org=$1 AND (subject_name ILIKE $2 OR subject_uuid=$3) AND status='held'", [org, search, q]),
      pool.query("SELECT * FROM bolos WHERE community_org=$1 AND (subject_name ILIKE $2 OR subject_uuid=$3) AND status='active'", [org, search, q])
    ]);
    res.json({
      records:   records.rows,
      warrants:  warrants.rows,
      citations: citations.rows,
      jail:      jail.rows,
      bolos:     bolos.rows
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ============================================================
//  DETECTOR REGISTRY ROUTES
// ============================================================

app.post('/detector/register', async (req, res) => {
  try {
    var payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch(e) {} }
    const { detector_code, parcel_name, region, slurl, world_x, world_y, world_z, activated_by, org_code } = payload;
    await pool.query(
      `INSERT INTO detectors (detector_code, parcel_name, region, slurl, world_x, world_y, world_z, activated_by, org_code, status, activated_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',NOW(),NOW())
       ON CONFLICT (detector_code) DO UPDATE SET
         parcel_name=$2, region=$3, slurl=$4, world_x=$5, world_y=$6, world_z=$7,
         activated_by=$8, org_code=$9, status='active', activated_at=NOW(), updated_at=NOW()`,
      [detector_code, parcel_name||'', region||'', slurl||'', world_x||0, world_y||0, world_z||0, activated_by||'unknown', org_code||'rfr']
    );
    console.log('[detector] Registered: ' + detector_code + ' at ' + parcel_name);
    res.json({ success: true, detector_code });
  } catch (err) {
    console.log('[detector/register] ERROR: ' + err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/detector/battery-dead', async (req, res) => {
  try {
    var payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch(e) {} }
    const { detector_code } = payload;
    await pool.query("UPDATE detectors SET status='battery_dead', updated_at=NOW() WHERE detector_code=$1", [detector_code]);
    console.log('[detector] Battery dead: ' + detector_code);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/detector/battery-replaced', async (req, res) => {
  try {
    var payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch(e) {} }
    const { detector_code } = payload;
    await pool.query("UPDATE detectors SET status='active', battery_pct=100, battery_replaced_at=NOW(), updated_at=NOW() WHERE detector_code=$1", [detector_code]);
    console.log('[detector] Battery replaced: ' + detector_code);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/detector/registry', async (req, res) => {
  try {
    const org = req.query.org || 'rfr';
    const r = await pool.query(
      "SELECT * FROM detectors WHERE org_code=$1 ORDER BY region, parcel_name",
      [org]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/detector/:code/label', async (req, res) => {
  try {
    var payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch(e) {} }
    await pool.query("UPDATE detectors SET parcel_name=$1, updated_at=NOW() WHERE detector_code=$2", [payload.label, req.params.code]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ============================================================
//  MEMBER AUTH & ROSTER ROUTES
// ============================================================

const COMMISSIONER_USER = 'RomCom';
const COMMISSIONER_PIN  = '35031832';

const RANKS = {
  8300: 'Fire Chief',
  8301: 'Deputy Chief',
  8310: 'Battalion Chief',
  8320: 'Captain',
  8330: 'Lieutenant',
  8340: 'Firefighter II',
  8345: 'Firefighter I',
  8350: 'Probationary FF',
  8399: 'Cadet'
};

const CHIEF_RANKS = [8300, 8301, 8310, 8320];

// ── Commissioner login ────────────────────────────────────────
app.post('/auth/commissioner', async (req, res) => {
  try {
    var payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch(e) {} }
    const { username, pin } = payload;
    if (username === COMMISSIONER_USER && pin === COMMISSIONER_PIN) {
      res.json({ success: true, role: 'commissioner', name: username });
    } else {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Member login ──────────────────────────────────────────────
app.post('/auth/member', async (req, res) => {
  try {
    var payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch(e) {} }
    const { avatar_name, pin, org_code } = payload;
    const r = await pool.query(
      'SELECT * FROM members WHERE LOWER(avatar_name) = LOWER($1) AND pin = $2 AND active = true',
      [avatar_name, pin]
    );
    if (r.rows.length === 0) return res.status(401).json({ error: 'Invalid name or PIN' });
    const member = r.rows[0];
    const isChief = CHIEF_RANKS.includes(member.rank_code);
    // Check assignments if not chief
    if (!isChief && org_code && member.org_code !== org_code) {
      // Check member_assignments table
      const assign = await pool.query(
        'SELECT id FROM member_assignments WHERE member_id = $1 AND org_code = $2 AND active = true',
        [member.id, org_code]
      );
      if (assign.rows.length === 0) {
        return res.status(403).json({ error: 'Access denied for this community' });
      }
    }
    res.json({
      success:    true,
      id:         member.id,
      avatar_name:member.avatar_name,
      rank_code:  member.rank_code,
      rank_name:  member.rank_name,
      department: member.department,
      org_code:   member.org_code,
      is_chief:   isChief
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Dispatcher login ──────────────────────────────────────────
app.post('/auth/dispatcher', async (req, res) => {
  try {
    var payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch(e) {} }
    const { name, pin, org_code } = payload;
    const r = await pool.query(
      'SELECT * FROM dispatchers WHERE LOWER(name) = LOWER($1) AND pin = $2 AND active = true AND org_code = $3',
      [name, pin, org_code || 'rfr']
    );
    if (r.rows.length === 0) return res.status(401).json({ error: 'Invalid name or PIN' });
    res.json({ success: true, name: r.rows[0].name, org_code: r.rows[0].org_code, role: 'dispatcher' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Get access codes (commissioner only) ─────────────────────
app.get('/auth/codes', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM access_codes ORDER BY org_code, department');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Update access code ────────────────────────────────────────
app.patch('/auth/codes', async (req, res) => {
  try {
    var payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch(e) {} }
    const { org_code, department, code, updated_by } = payload;
    await pool.query(
      'UPDATE access_codes SET code=$1, updated_at=NOW(), updated_by=$2 WHERE org_code=$3 AND department=$4',
      [code, updated_by || 'commissioner', org_code, department]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Get roster ────────────────────────────────────────────────
app.get('/members', async (req, res) => {
  try {
    const org  = req.query.org  || null;
    const dept = req.query.dept || null;
    let query  = 'SELECT id, avatar_name, rank_code, rank_name, department, org_code, active, created_at FROM members WHERE 1=1';
    const params = [];
    if (org)  { params.push(org);  query += ' AND org_code = $'  + params.length; }
    if (dept) { params.push(dept); query += ' AND department = $' + params.length; }
    query += ' ORDER BY rank_code ASC, avatar_name ASC';
    const r = await pool.query(query, params);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Add member ────────────────────────────────────────────────
app.post('/members', async (req, res) => {
  try {
    var payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch(e) {} }
    const { avatar_name, avatar_uuid, rank_code, department, org_code, pin, notes } = payload;
    const rank_name = RANKS[rank_code] || 'Firefighter I';
    const r = await pool.query(
      'INSERT INTO members (avatar_name, avatar_uuid, rank_code, rank_name, department, org_code, pin, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [avatar_name, avatar_uuid||'', rank_code||8350, rank_name, department||'fd', org_code||'rfr', pin, notes||'']
    );
    res.json({ success: true, id: r.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Update member ─────────────────────────────────────────────
app.patch('/members/:id', async (req, res) => {
  try {
    var payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch(e) {} }
    const { rank_code, pin, active, notes, org_code } = payload;
    const rank_name = rank_code ? (RANKS[rank_code] || 'Firefighter I') : undefined;
    const updates = []; const params = [];
    if (rank_code !== undefined) { params.push(rank_code);  updates.push('rank_code=$'  + params.length); }
    if (rank_name !== undefined) { params.push(rank_name);  updates.push('rank_name=$'  + params.length); }
    if (pin       !== undefined) { params.push(pin);        updates.push('pin=$'        + params.length); }
    if (active    !== undefined) { params.push(active);     updates.push('active=$'     + params.length); }
    if (notes     !== undefined) { params.push(notes);      updates.push('notes=$'      + params.length); }
    if (org_code  !== undefined) { params.push(org_code);   updates.push('org_code=$'   + params.length); }
    if (updates.length === 0) return res.json({ ok: true });
    updates.push('updated_at=NOW()');
    params.push(req.params.id);
    await pool.query('UPDATE members SET ' + updates.join(',') + ' WHERE id=$' + params.length, params);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Delete member ─────────────────────────────────────────────
app.delete('/members/:id', async (req, res) => {
  try {
    await pool.query('UPDATE members SET active=false, updated_at=NOW() WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Add dispatcher ────────────────────────────────────────────
app.post('/dispatchers', async (req, res) => {
  try {
    var payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch(e) {} }
    const { name, avatar_name, org_code, pin } = payload;
    const r = await pool.query(
      'INSERT INTO dispatchers (name, avatar_name, org_code, pin) VALUES ($1,$2,$3,$4) RETURNING id',
      [name, avatar_name||'', org_code||'rfr', pin]
    );
    res.json({ success: true, id: r.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Get dispatchers ───────────────────────────────────────────
app.delete('/dispatchers/:id', async (req, res) => {
  try {
    await pool.query('UPDATE dispatchers SET active = false WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/dispatchers/:id', async (req, res) => {
  try {
    await pool.query('UPDATE dispatchers SET active = false WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/dispatchers', async (req, res) => {
  try {
    const org = req.query.org || null;
    let query = 'SELECT id, name, avatar_name, org_code, active, created_at FROM dispatchers WHERE 1=1';
    const params = [];
    if (org) { params.push(org); query += ' AND org_code = $1'; }
    query += ' ORDER BY name ASC';
    const r = await pool.query(query, params);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});


app.patch('/incidents/:id/resolve', async (req, res) => {
  try {
    await pool.query(
      'UPDATE incidents SET resolved = true WHERE id = $1',
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/incidents/resolve-all', async (req, res) => {
  try {
    var payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch(e) {} }
    const org = payload.org_code || null;
    if (org) {
      await pool.query('UPDATE incidents SET resolved = true WHERE resolved = false AND org_code = $1', [org]);
    } else {
      await pool.query('UPDATE incidents SET resolved = true WHERE resolved = false');
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ============================================================
//  PAGER / BEEPER ENDPOINTS
// ============================================================

app.get('/alarm-notifications/:dept/beeper', async (req, res) => {
  try {
    const org = req.query.org || null;
    let query = `SELECT fa.detector_code, fa.sim_code, fa.parcel_code, fa.detector_num,
              fa.region, fa.alarm_type, fa.fire_count, fa.smoke_count,
              fa.ladder_triggered, fa.first_detected,
              COALESCE(fa.incident_type, fa.alarm_type) AS incident_type,
              COALESCE(fa.units_dispatched, '') AS units_dispatched
       FROM alarm_notifications an
       JOIN fire_alarms fa ON an.alarm_id = fa.id
       WHERE an.department = $1 AND an.beeper_seen = false`;
    const params = [req.params.dept];
    if (org) { params.push(org); query += ' AND an.org_code = $' + params.length; }
    query += ' ORDER BY an.created_at ASC LIMIT 5';
    const r = await pool.query(query, params);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/alarm-notifications/:dept/beeper/seen', async (req, res) => {
  try {
    const org = req.query.org || null;
    if (!org) return res.json({ ok: true, skipped: 'org required' });
    await pool.query(
      'UPDATE alarm_notifications SET beeper_seen = true WHERE department = $1 AND org_code = $2',
      [req.params.dept, org]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/medical/pending-beeper', async (req, res) => {
  try {
    const org = req.query.org || null;
    let query = 'SELECT * FROM medical_alerts WHERE beeper_seen = false';
    const params = [];
    if (org) { params.push(org); query += ' AND org_code = $' + params.length; }
    query += ' ORDER BY created_at ASC LIMIT 5';
    const r = await pool.query(query, params);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/medical/seen-beeper', async (req, res) => {
  try {
    const org = req.query.org || null;
    if (!org) return res.json({ ok: true, skipped: 'org required' });
    await pool.query(
      'UPDATE medical_alerts SET beeper_seen = true WHERE org_code = $1',
      [org]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ── Clear individual alarm from dashboard ─────────────────────
app.patch('/alarm-notifications/:dept/clear/:id', async (req, res) => {
  try {
    const org = req.query.org || null;
    if (!org) return res.status(400).json({ error: 'org required' });
    await pool.query(
      'UPDATE alarm_notifications SET seen_panel = true WHERE id = $1 AND org_code = $2',
      [req.params.id, org]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Clear all alarms from dashboard ──────────────────────────
app.patch('/alarm-notifications/:dept/clear-all', async (req, res) => {
  try {
    const org = req.query.org || null;
    if (!org) return res.status(400).json({ error: 'org required' });
    await pool.query(
      'UPDATE alarm_notifications SET seen_panel = true WHERE department = $1 AND org_code = $2 AND seen_panel = false',
      [req.params.dept, org]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ── Clear individual alarm from dashboard ─────────────────────
app.patch('/alarm-notifications/:dept/clear/:id', async (req, res) => {
  try {
    const org = req.query.org || null;
    if (!org) return res.status(400).json({ error: 'org required' });
    await pool.query(
      'UPDATE alarm_notifications SET seen_panel = true WHERE id = $1 AND org_code = $2',
      [req.params.id, org]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Clear all alarms from dashboard ──────────────────────────
app.patch('/alarm-notifications/:dept/clear-all', async (req, res) => {
  try {
    const org = req.query.org || null;
    if (!org) return res.status(400).json({ error: 'org required' });
    await pool.query(
      'UPDATE alarm_notifications SET seen_panel = true WHERE department = $1 AND org_code = $2 AND seen_panel = false',
      [req.params.dept, org]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ── Member assignments ────────────────────────────────────────
app.get('/members/:id/assignments', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT org_code FROM member_assignments WHERE member_id = $1 AND active = true',
      [req.params.id]
    );
    res.json(r.rows.map(r => r.org_code));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/members/:id/assignments', async (req, res) => {
  try {
    var payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch(e) {} }
    const { org_codes } = payload;
    // Remove existing and re-add
    await pool.query('UPDATE member_assignments SET active = false WHERE member_id = $1', [req.params.id]);
    for (const org of org_codes) {
      await pool.query(
        'INSERT INTO member_assignments (member_id, org_code) VALUES ($1,$2) ON CONFLICT (member_id, org_code) DO UPDATE SET active = true',
        [req.params.id, org]
      );
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ============================================================
//  DASHBOARD SELF-SERVICE TIMECLOCK
// ============================================================

app.get('/timeclock/status/:memberId', async (req, res) => {
  try {
    const avatarName = req.query.avatar_name || null;
    let r;
    if (avatarName) {
      r = await pool.query(
        'SELECT id, avatar_name, department, org_code, clock_in, ROUND(EXTRACT(EPOCH FROM (NOW() - clock_in))/3600, 2) AS hours_on FROM timeclock_shifts WHERE avatar_name = $1 AND active = true ORDER BY clock_in DESC LIMIT 1',
        [avatarName]
      );
    } else {
      r = await pool.query(
        'SELECT id, avatar_name, department, org_code, clock_in, ROUND(EXTRACT(EPOCH FROM (NOW() - clock_in))/3600, 2) AS hours_on FROM timeclock_shifts WHERE member_id = $1 AND active = true ORDER BY clock_in DESC LIMIT 1',
        [req.params.memberId]
      );
    }
    if (r.rows.length > 0) res.json({ clocked_in: true, shift: r.rows[0] });
    else res.json({ clocked_in: false });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/timeclock/dashboard', async (req, res) => {
  try {
    var payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch(e) {} }
    const { member_id, avatar_name, department, org_code, action } = payload;
    const org  = org_code || 'rfr';
    const dept = (department || 'fd').toLowerCase();
    if (action === 'clock_in') {
      await pool.query('UPDATE timeclock_shifts SET clock_out = NOW(), active = false WHERE avatar_name = $1 AND active = true', [avatar_name]);
      const r = await pool.query(
        'INSERT INTO timeclock_shifts (member_id, avatar_name, department, org_code, clock_in, active) VALUES ($1,$2,$3,$4,NOW(),true) RETURNING id, clock_in',
        [member_id || null, avatar_name, dept, org]
      );
      res.json({ success: true, action: 'clock_in', shift: r.rows[0] });
    } else if (action === 'clock_out') {
      const r = await pool.query(
        'UPDATE timeclock_shifts SET clock_out = NOW(), active = false WHERE avatar_name = $1 AND active = true RETURNING id, clock_in, clock_out, ROUND(EXTRACT(EPOCH FROM (clock_out - clock_in))/3600, 2) AS hours',
        [avatar_name]
      );
      if (r.rows.length > 0) res.json({ success: true, action: 'clock_out', shift: r.rows[0] });
      else res.json({ success: false, error: 'No active shift found' });
    } else {
      res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/timeclock/history/:memberId', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const r = await pool.query(
      "SELECT id, clock_in, clock_out, active, department, org_code, ROUND(EXTRACT(EPOCH FROM (COALESCE(clock_out, NOW()) - clock_in))/3600, 2) AS hours FROM timeclock_shifts WHERE member_id = $1 AND clock_in >= NOW() - (INTERVAL '1 day' * $2) ORDER BY clock_in DESC",
      [req.params.memberId, days]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ============================================================
//  DISPATCHER CONSOLE — call queue + dispatch
// ============================================================

app.post('/dispatch/call', async (req, res) => {
  try {
    var payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch(e) {} }
    const { org_code, caller_name, location, notes, dispatcher } = payload;
    const org = org_code || 'rfr';
    const r = await pool.query(
      `INSERT INTO dispatch_calls (org_code, caller_name, location, notes, dispatcher, status)
       VALUES ($1,$2,$3,$4,$5,'active') RETURNING *`,
      [org, caller_name || 'Unknown', location || '', notes || '', dispatcher || 'Dispatcher']
    );
    res.json({ success: true, call: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/dispatch/calls', async (req, res) => {
  try {
    const org = req.query.org || null;
    let query = "SELECT * FROM dispatch_calls WHERE status = 'active'";
    const params = [];
    if (org) { params.push(org); query += ' AND org_code = $1'; }
    query += ' ORDER BY created_at DESC';
    const r = await pool.query(query, params);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/dispatch/calls/log', async (req, res) => {
  try {
    const org = req.query.org || null;
    const days = parseInt(req.query.days) || 30;
    let query = "SELECT * FROM dispatch_calls WHERE status = 'closed' AND closed_at >= NOW() - (INTERVAL '1 day' * $1)";
    const params = [days];
    if (org) { params.push(org); query += ' AND org_code = $2'; }
    query += ' ORDER BY closed_at DESC';
    const r = await pool.query(query, params);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/dispatch/call/:id/notes', async (req, res) => {
  try {
    var payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch(e) {} }
    await pool.query('UPDATE dispatch_calls SET notes = $1 WHERE id = $2', [payload.notes || '', req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/dispatch/call/:id/dispatch', async (req, res) => {
  const client = await pool.connect();
  try {
    var payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch(e) {} }
    const { call_type, incident_type, units } = payload;
    const callRes = await client.query('SELECT * FROM dispatch_calls WHERE id = $1', [req.params.id]);
    if (callRes.rows.length === 0) return res.status(404).json({ error: 'Call not found' });
    const call = callRes.rows[0];
    const org = call.org_code;
    const unitsStr = Array.isArray(units) ? units.join(',') : (units || '');
    const alarmType = (call_type === 'medical') ? 'MEDICAL' : 'FIRE';
    const alarmResult = await client.query(
      `INSERT INTO fire_alarms
         (detector_code, sim_code, parcel_code, detector_num, region,
          alarm_type, fire_count, smoke_count, ladder_triggered, status, org_code,
          incident_type, units_dispatched, first_detected)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW()) RETURNING id`,
      ['DISPATCH', 'DISP', (call.location||'UNKNOWN').substring(0,20), 'D1',
       call.location || 'UNKNOWN', alarmType, (alarmType==='FIRE'?1:0), 0, false, 'active', org,
       incident_type || null, unitsStr || null]
    );
    const alarmId = alarmResult.rows[0].id;
    await client.query(
      'INSERT INTO alarm_notifications (alarm_id, department, message, org_code) VALUES ($1,$2,$3,$4)',
      [alarmId, 'fd',
       (alarmType==='MEDICAL'?'Medical':'Fire') + ' dispatch by ' + (call.dispatcher||'Dispatcher') + ' | ' + (incident_type||'') + ' | ' + (call.caller_name||''), org]
    );
    await client.query(
      "UPDATE dispatch_calls SET call_type=$1, incident_type=$2, units=$3, dispatched=true, dispatched_at=NOW(), alarm_id=$4 WHERE id=$5",
      [call_type || 'fire', incident_type || '', unitsStr, alarmId, req.params.id]
    );
    var unitsDisplay = Array.isArray(units) ? units.join(', ') : (units || 'Unknown');
    var discordTitle = (alarmType==='MEDICAL') ? "🚑 MEDICAL DISPATCH" : "🔥 FIRE DISPATCH";
    var discordColor = (alarmType==='MEDICAL') ? 0x9B59B6 : 0xFF4500;
    await postDiscord(discordTitle, discordColor, [
      { name: "Caller",   value: call.caller_name || "Unknown", inline: true },
      { name: "Location", value: call.location    || "Unknown", inline: true },
      { name: "Incident", value: incident_type    || "Unknown", inline: true },
      { name: "Units",    value: unitsDisplay, inline: true },
      { name: "Dispatcher", value: call.dispatcher || "Dispatcher", inline: true }
    ], org);
    res.json({ success: true, alarm_id: alarmId });
  } catch (err) {
    console.log('[dispatch/call/dispatch] ERROR: ' + err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.patch('/dispatch/call/:id/close', async (req, res) => {
  try {
    var payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch(e) {} }
    await pool.query(
      "UPDATE dispatch_calls SET status='closed', closed_at=NOW(), notes=COALESCE($1, notes) WHERE id=$2",
      [payload.notes || null, req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


app.listen(3000, () => console.log('RDS API running on port 3000'));

// ============================================================
//  RES MULTI-ORG ROUTES — /org/:org/...
// ============================================================

app.get('/org/:org/alarm-notifications/:dept', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT fa.detector_code, fa.sim_code, fa.parcel_code, fa.detector_num,
              fa.region, fa.alarm_type, fa.fire_count, fa.smoke_count,
              fa.ladder_triggered, fa.first_detected,
              'secondlife://' || replace(fa.region, ' ', '%20') || '/' ||
              fa.world_x || '/' || fa.world_y || '/0' AS slurl
       FROM alarm_notifications an
       JOIN fire_alarms fa ON an.alarm_id = fa.id
       WHERE an.department = $1 AND an.org_code = $2 AND an.seen = false
       ORDER BY an.created_at ASC LIMIT 1`,
      [req.params.dept, req.params.org]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/org/:org/alarm-notifications/:dept/seen', async (req, res) => {
  try {
    await pool.query(
      'UPDATE alarm_notifications SET seen = true WHERE department = $1 AND org_code = $2',
      [req.params.dept, req.params.org]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/org/:org/alarm-notifications/:dept/beeper', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT fa.detector_code, fa.sim_code, fa.parcel_code, fa.detector_num,
              fa.region, fa.alarm_type, fa.fire_count, fa.smoke_count,
              fa.ladder_triggered, fa.first_detected,
              'secondlife://' || replace(fa.region, ' ', '%20') || '/' ||
              fa.world_x || '/' || fa.world_y || '/0' AS slurl
       FROM alarm_notifications an
       JOIN fire_alarms fa ON an.alarm_id = fa.id
       WHERE an.department = $1 AND an.org_code = $2 AND an.beeper_seen = false
       ORDER BY an.created_at ASC LIMIT 1`,
      [req.params.dept, req.params.org]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/org/:org/alarm-notifications/:dept/beeper/seen', async (req, res) => {
  try {
    await pool.query(
      'UPDATE alarm_notifications SET beeper_seen = true WHERE department = $1 AND org_code = $2',
      [req.params.dept, req.params.org]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/org/:org/dispatch/fire', async (req, res) => {
  const client = await pool.connect();
  try {
    var payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch(e) {} }
    const { caller_name, region, address, issue, timestamp } = payload;
    const org_code = req.params.org;
    const parcel_code = address || 'UNKNOWN';
    const alarmResult = await client.query(
      `INSERT INTO fire_alarms
         (detector_code, sim_code, parcel_code, detector_num, region,
          alarm_type, fire_count, smoke_count, ladder_triggered, status, first_detected, org_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),$11) RETURNING id`,
      ['DISPATCH','DISP',parcel_code,'D1',region||'UNKNOWN','FIRE',1,0,false,'active',org_code]
    );
    const alarmId = alarmResult.rows[0].id;
    await client.query(
      'INSERT INTO alarm_notifications (alarm_id, department, message, org_code) VALUES ($1,$2,$3,$4)',
      [alarmId,'fd','Fire reported by '+caller_name+' | '+issue, org_code]
    );
    res.json({ success: true, alarm_id: alarmId });
  } catch (err) { res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.post('/org/:org/dispatch/medical', async (req, res) => {
  const client = await pool.connect();
  try {
    var payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch(e) {} }
    const { caller_name, region, issue, timestamp } = payload;
    const org_code = req.params.org;
    const alarmResult = await client.query(
      `INSERT INTO fire_alarms
         (detector_code, sim_code, parcel_code, detector_num, region,
          alarm_type, fire_count, smoke_count, ladder_triggered, status, first_detected, org_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),$11) RETURNING id`,
      ['DISPATCH','DISP',region||'UNKNOWN','D1',region||'UNKNOWN','MEDICAL',0,0,false,'active',org_code]
    );
    const alarmId = alarmResult.rows[0].id;
    await client.query(
      'INSERT INTO alarm_notifications (alarm_id, department, message, org_code) VALUES ($1,$2,$3,$4)',
      [alarmId,'fd','Medical reported by '+caller_name+' at '+(region||'UNKNOWN')+' | '+issue, org_code]
    );
    res.json({ success: true, alarm_id: alarmId });
  } catch (err) { res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.post('/org/:org/medical', async (req, res) => {
  try {
    var payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch(e) {} }
    const { avatar_name, avatar_key, region, world_x, world_y, emergency_type, timestamp, slurl } = payload;
    await pool.query(
      `INSERT INTO medical_alerts
         (avatar_name, avatar_key, region, world_x, world_y, emergency_type, timestamp, slurl, org_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [avatar_name, avatar_key, region, world_x, world_y, emergency_type, timestamp, slurl, req.params.org]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/org/:org/medical/pending', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM medical_alerts WHERE dismissed = false AND org_code = $1 ORDER BY id DESC',
      [req.params.org]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/org/:org/medical/pending-beeper', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM medical_alerts WHERE dismissed = false AND beeper_seen = false AND org_code = $1 ORDER BY id DESC',
      [req.params.org]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/org/:org/medical/seen-panel', async (req, res) => {
  try {
    await pool.query('UPDATE medical_alerts SET seen_panel = true WHERE org_code = $1', [req.params.org]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/org/:org/medical/seen-beeper', async (req, res) => {
  try {
    await pool.query('UPDATE medical_alerts SET beeper_seen = true WHERE org_code = $1', [req.params.org]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/org/:org/medical/:id/dismiss', async (req, res) => {
  try {
    await pool.query(
      'UPDATE medical_alerts SET dismissed = true WHERE id = $1 AND org_code = $2',
      [req.params.id, req.params.org]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/org/:org/detectors', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM detectors WHERE org_code = $1 ORDER BY id', [req.params.org]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ============================================================
//  CIVCORE — Civilian Registry
// ============================================================

app.post('/civcore/register', async (req, res) => {
  try {
    var p = req.body;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch(e) {} }
    const { avatar_uuid, avatar_name, display_name, dob, gender, bio, primary_community } = p;
    if (!avatar_uuid || !avatar_name) return res.status(400).json({ error: 'avatar_uuid and avatar_name required' });
    const sl_photo = 'https://profile.secondlife.com/img/' + avatar_uuid + '.jpg';
    const r = await pool.query(
      `INSERT INTO civilians (avatar_uuid, avatar_name, display_name, dob, gender, bio, primary_community, photo_url, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW()) ON CONFLICT (avatar_uuid) DO UPDATE SET avatar_name=EXCLUDED.avatar_name, display_name=COALESCE(EXCLUDED.display_name,civilians.display_name), dob=COALESCE(EXCLUDED.dob,civilians.dob), gender=COALESCE(EXCLUDED.gender,civilians.gender), bio=COALESCE(EXCLUDED.bio,civilians.bio), primary_community=COALESCE(EXCLUDED.primary_community,civilians.primary_community), photo_url=COALESCE(civilians.photo_url,$8), updated_at=NOW() RETURNING *`,
      [avatar_uuid, avatar_name, display_name||null, dob||null, gender||null, bio||null, primary_community||null, sl_photo]
    );
    res.json({ success: true, civilian: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/civcore/profile/:uuid', async (req, res) => {
  try {
    const uuid = req.params.uuid;
    const [cRes, rRes, vRes] = await Promise.all([
      pool.query('SELECT * FROM civilians WHERE avatar_uuid = $1', [uuid]),
      pool.query('SELECT * FROM civilian_residencies WHERE avatar_uuid = $1 ORDER BY moved_in DESC', [uuid]),
      pool.query('SELECT * FROM vehicles WHERE owner_uuid = $1 ORDER BY registered_at DESC', [uuid]),
    ]);
    if (!cRes.rows.length) return res.status(404).json({ error: 'Civilian not found' });
    res.json({ civilian: cRes.rows[0], residencies: rRes.rows, vehicles: vRes.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/civcore/profile/:uuid', async (req, res) => {
  try {
    var p = req.body;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch(e) {} }
    const { display_name, dob, gender, bio, primary_community, photo_url, photo_key } = p;
    const r = await pool.query(
      `UPDATE civilians SET display_name=COALESCE($1,display_name), dob=COALESCE($2,dob), gender=COALESCE($3,gender), bio=COALESCE($4,bio), primary_community=COALESCE($5,primary_community), photo_url=COALESCE($6,photo_url), photo_key=COALESCE($7,photo_key), updated_at=NOW() WHERE avatar_uuid=$8 RETURNING *`,
      [display_name||null, dob||null, gender||null, bio||null, primary_community||null, photo_url||null, photo_key||null, req.params.uuid]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Civilian not found' });
    res.json({ success: true, civilian: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/civcore/search', async (req, res) => {
  try {
    const q = req.query.q;
    const community = req.query.community;
    if (!q) return res.status(400).json({ error: 'Query required' });
    let query = "SELECT c.*, cr.community_org, cr.status as residency_status FROM civilians c LEFT JOIN civilian_residencies cr ON c.avatar_uuid = cr.avatar_uuid WHERE (c.avatar_name ILIKE $1 OR c.display_name ILIKE $1)";
    let params = ['%' + q + '%'];
    if (community) { query += ' AND cr.community_org = $2'; params.push(community); }
    query += ' ORDER BY c.avatar_name LIMIT 20';
    const r = await pool.query(query, params);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/civcore/residency', async (req, res) => {
  try {
    var p = req.body;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch(e) {} }
    const { avatar_uuid, community_org, status } = p;
    if (!avatar_uuid || !community_org) return res.status(400).json({ error: 'avatar_uuid and community_org required' });
    const r = await pool.query(
      "INSERT INTO civilian_residencies (avatar_uuid, community_org, status, moved_in) VALUES ($1,$2,$3,NOW()) ON CONFLICT (avatar_uuid, community_org) DO UPDATE SET status=EXCLUDED.status RETURNING *",
      [avatar_uuid, community_org, status||'active']
    );
    res.json({ success: true, residency: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/civcore/residency/transfer', async (req, res) => {
  try {
    var p = req.body;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch(e) {} }
    const { avatar_uuid, from_org, to_org, keep_dual } = p;
    if (!avatar_uuid || !from_org || !to_org) return res.status(400).json({ error: 'avatar_uuid, from_org, to_org required' });
    if (!keep_dual) {
      await pool.query("UPDATE civilian_residencies SET status='former', moved_out=NOW() WHERE avatar_uuid=$1 AND community_org=$2", [avatar_uuid, from_org]);
    }
    await pool.query("INSERT INTO civilian_residencies (avatar_uuid, community_org, status, moved_in) VALUES ($1,$2,'active',NOW()) ON CONFLICT (avatar_uuid, community_org) DO UPDATE SET status='active', moved_out=NULL", [avatar_uuid, to_org]);
    await pool.query('UPDATE civilians SET primary_community=$1, updated_at=NOW() WHERE avatar_uuid=$2', [to_org, avatar_uuid]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/civcore/vehicle', async (req, res) => {
  try {
    var p = req.body;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch(e) {} }
    const { owner_uuid, make, model, color, plate, year, community_org, photo_url, photo_key } = p;
    if (!owner_uuid) return res.status(400).json({ error: 'owner_uuid required' });
    const r = await pool.query(
      "INSERT INTO vehicles (owner_uuid, make, model, color, plate, year, community_org, photo_url, photo_key, registered_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) RETURNING *",
      [owner_uuid, make||'', model||'', color||'', plate||'', year||'', community_org||'', photo_url||'', photo_key||'']
    );
    res.json({ success: true, vehicle: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/civcore/vehicles/:uuid', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM vehicles WHERE owner_uuid = $1 ORDER BY registered_at DESC', [req.params.uuid]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/civcore/vehicle/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM vehicles WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/civcore/community/:org', async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT c.*, cr.status as residency_status, cr.moved_in FROM civilians c JOIN civilian_residencies cr ON c.avatar_uuid = cr.avatar_uuid WHERE cr.community_org = $1 AND cr.status = 'active' ORDER BY c.avatar_name",
      [req.params.org]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});


app.get('/org/:org/hydrants', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM detectors WHERE org_code = $1 ORDER BY id', [req.params.org]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/org/:org/detector/commands/pending', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM detector_commands WHERE executed = false AND org_code = $1 ORDER BY id ASC',
      [req.params.org]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/org/:org/detector/commands/clear', async (req, res) => {
  try {
    await pool.query('UPDATE detector_commands SET executed = true WHERE org_code = $1', [req.params.org]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/org/:org/incidents', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM incidents WHERE org_code = $1 ORDER BY id DESC', [req.params.org]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
