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
    await pool.query('BEGIN');
    const priority = avatar_name === 'UNKNOWN' ? 'investigate' : 'normal';
    const inc = await pool.query(
      `INSERT INTO incidents
         (sim_name, hydrant_name, avatar_name, vehicle_name,
          incident_date, incident_time, priority, world_x, world_y)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [sim_name, hydrant_name, avatar_name, vehicle_name,
       incident_date, incident_time, priority,
       world_x || 128, world_y || 128]
    );
    const id = inc.rows[0].id;
    await pool.query(
      `INSERT INTO notifications (incident_id, department, message) VALUES ($1,$2,$3)`,
      [id, 'dpw', 'New hydrant down: ' + hydrant_name + ' in ' + sim_name]
    );
    await pool.query(
      `INSERT INTO notifications (incident_id, department, message) VALUES ($1,$2,$3)`,
      [id, 'fd', 'Hydrant down: ' + hydrant_name + ' in ' + sim_name]
    );
    if (avatar_name !== 'UNKNOWN') {
      await pool.query(
        `INSERT INTO notifications (incident_id, department, message) VALUES ($1,$2,$3)`,
        [id, 'pd', 'Citation candidate: ' + avatar_name + ' in ' + sim_name]
      );
    } else {
      await pool.query(
        `INSERT INTO notifications (incident_id, department, message) VALUES ($1,$2,$3)`,
        [id, 'pd', 'Unknown driver investigation needed: ' + sim_name]
      );
    }
    await pool.query('COMMIT');
    res.json(inc.rows[0]);
  } catch (err) {
    await pool.query('ROLLBACK');
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
    await pool.query('BEGIN');
    const r = await pool.query(
      "UPDATE incidents SET assigned_to = $1, assigned_at = NOW() WHERE id = $2 RETURNING *",
      [department, req.params.id]
    );
    await pool.query(
      'INSERT INTO assignments (incident_id, assigned_to, assigned_by, notes) VALUES ($1,$2,$3,$4)',
      [req.params.id, department, assigned_by || department, notes || '']
    );
    await pool.query(
      'UPDATE notifications SET seen = true WHERE incident_id = $1 AND department = $2',
      [req.params.id, department]
    );
    await pool.query('COMMIT');
    res.json(r.rows[0]);
  } catch (err) {
    await pool.query('ROLLBACK');
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
    await pool.query('BEGIN');
    const v = await pool.query(
      `INSERT INTO violations
         (sim_name, avatar_name, vehicle_name, speed_recorded,
          speed_limit, zone_name, violation_date, violation_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [sim_name, avatar_name, vehicle_name, speed_recorded,
       speed_limit, zone_name || 'Main Road', violation_date, violation_time]
    );
    const vid = v.rows[0].id;
    await pool.query(
      `INSERT INTO notifications (incident_id, department, message) VALUES ($1,$2,$3)`,
      [vid, 'pd',
       'Speed violation: ' + avatar_name + ' doing ' + speed_recorded +
       ' mph in ' + (zone_name || 'Main Road') + ' (' + speed_limit + ' mph zone)']
    );
    await pool.query('COMMIT');
    res.json(v.rows[0]);
  } catch (err) {
    await pool.query('ROLLBACK');
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
    await pool.query('BEGIN');
    const existing = await pool.query(
      "SELECT id, status, ladder_triggered FROM fire_alarms WHERE detector_code = $1 AND status != 'cleared' AND alarm_type != 'CLEAR'",
      [detector_code]
    );
    let alarm;
    if (alarm_type === 'CLEAR') {
      if (existing.rows.length > 0) {
        alarm = await pool.query(
          "UPDATE fire_alarms SET alarm_type = 'CLEAR', status = 'cleared', fire_count = 0, smoke_count = 0, last_updated = NOW() WHERE detector_code = $1 AND status != 'cleared' RETURNING *",
          [detector_code]
        );
      } else {
        await pool.query('COMMIT');
        return res.json({ ok: true, message: 'No active alarm to clear' });
      }
    } else if (existing.rows.length > 0) {
      const wasLadder = existing.rows[0].ladder_triggered;
      alarm = await pool.query(
        "UPDATE fire_alarms SET alarm_type = $1, fire_count = $2, smoke_count = $3, ladder_triggered = $4, last_updated = NOW() WHERE detector_code = $5 AND status != 'cleared' RETURNING *",
        [alarm_type, fire_count || 0, smoke_count || 0, ladder_triggered || false, detector_code]
      );
      if (ladder_triggered && !wasLadder) {
        const alarmId = existing.rows[0].id;
        const location = sim_code + '-' + parcel_code;
        await pool.query(
          'INSERT INTO alarm_notifications (alarm_id, department, message, org_code) VALUES ($1,$2,$3,$4)',
          [alarmId, 'fd', 'LADDER ESCALATION: ' + detector_code + ' at ' + location + ' | Fire objects: ' + fire_count, org]
        );
      }
    } else {
      alarm = await pool.query(
        "INSERT INTO fire_alarms (detector_code, sim_code, parcel_code, detector_num, region, alarm_type, fire_count, smoke_count, ladder_triggered, first_detected, last_updated, status, world_x, world_y, org_code, incident_type, units_dispatched) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),'active',$11,$12,$13,$14,$15) RETURNING *",
        [detector_code, sim_code, parcel_code, detector_num, region,
         alarm_type, fire_count || 0, smoke_count || 0, ladder_triggered || false,
         first_detected || new Date().toISOString(), world_x || 128, world_y || 128, org, incidentType, units]
      );
      const alarmId = alarm.rows[0].id;
      const location = sim_code + '-' + parcel_code;
      await pool.query(
        'INSERT INTO alarm_notifications (alarm_id, department, message, org_code) VALUES ($1,$2,$3,$4)',
        [alarmId, 'fd', 'Fire alarm: ' + detector_code + ' at ' + location + ' | ' + alarm_type, org]
      );
      await pool.query(
        'INSERT INTO alarm_notifications (alarm_id, department, message, org_code) VALUES ($1,$2,$3,$4)',
        [alarmId, 'pd', 'Fire alarm reported at ' + location + ' (' + region + ')', org]
      );
      // Auto-create a dispatch_call so the alarm persists in the dispatcher
      // queue until a dispatcher manually clears it (FD side still auto-clears).
      const dispSlurl = slurl || ('secondlife://' + (region||'').replace(/ /g,'%20') + '/' + (world_x||128) + '/' + (world_y||128) + '/0');
      await pool.query(
        `INSERT INTO dispatch_calls
           (org_code, caller_name, location, call_type, incident_type, units, notes, status, dispatcher, dispatched, alarm_id, dispatched_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,true,$9,NOW())`,
        [org, 'Smoke Detector (' + detector_code + ')', dispSlurl, 'fire',
         incidentType || 'Structure Fire', units || 'Engine,Ladder,Battalion',
         'Auto-dispatched by detector ' + detector_code + ' at ' + (region||'') + '. Alarm type: ' + alarm_type + '.',
         'AUTO (Detector)', alarmId]
      );
    }
    await pool.query('COMMIT');
    res.json(alarm.rows[0]);
  } catch (err) {
    await pool.query('ROLLBACK');
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


app.get('/alarm/active', async (req, res) => {
  try {
    const org = req.query.org;
    if (!org) return res.status(400).json({ error: 'org required' });
    const r = await pool.query(
      `SELECT id, region, incident_type, units_dispatched,
              sim_code, parcel_code, world_x, world_y, created_at, org_code
       FROM fire_alarms
       WHERE org_code = $1
         AND status NOT IN ('cleared','silenced')
         AND alarm_type != 'CLEAR'
         AND created_at > NOW() - INTERVAL '4 hours'
       ORDER BY created_at DESC`,
      [org]
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
    await pool.query('BEGIN');
    await pool.query(
      'UPDATE alarm_notifications SET seen = true, seen_panel = true WHERE department = $1 AND org_code = $2',
      [req.params.dept, org]
    );
    await pool.query(
      "UPDATE fire_alarms SET status = 'cleared' WHERE id IN (SELECT alarm_id FROM alarm_notifications WHERE department = $1 AND org_code = $2) AND org_code = $2",
      [req.params.dept, org]
    );
    await pool.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await pool.query('ROLLBACK');
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
  rfr:     "https://discord.com/api/webhooks/1519124261619367966/bk1nmsAgA33x8NCKsTbRgLKX5ATFJjzrsqx-kLX3caLFyctnNm-NZR2Jzebx7O6dJBel",
  harmony: "https://discord.com/api/webhooks/1519126242899525632/-q17o38_4dQNQHeQWk05xHr5a4TTTAhaKEPtc_PLADFtD41Tj5z21o6J_83h0Elc_F98",
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
    const alarmResult = await pool.query(
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
    await pool.query(
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
    const org = req.query.org || 'rfr';
    const alarms = await pool.query(`
      SELECT id, detector_code AS code, sim_code, parcel_code, region,
             alarm_type, fire_count, smoke_count, ladder_triggered,
             world_x, world_y, status, first_detected, last_updated
      FROM fire_alarms
      WHERE status != 'cleared' AND (org_code = $1 OR org_code IS NULL)
      ORDER BY last_updated DESC
    `, [org]);
    const hydrants = await pool.query(`
      SELECT DISTINCT ON (hydrant_name)
        id, hydrant_name AS name, sim_name, world_x, world_y,
        CASE WHEN resolved = true THEN 'ok' ELSE 'knocked' END AS status,
        created_at
      FROM incidents
      ORDER BY hydrant_name, created_at DESC
    `);
    const detectors = await pool.query(`
      SELECT detector_code, region, parcel_name, slurl,
             world_x, world_y, world_z, status, org_code
      FROM detectors
      WHERE org_code = $1
        AND status = 'active'
        AND world_x IS NOT NULL
        AND world_y IS NOT NULL
      ORDER BY detector_code
    `, [org]);
    res.json({
      alarms:       alarms.rows,
      hydrants:     hydrants.rows.map(h => ({
        ...h,
        sim_code: SIM_CODES[h.sim_name] || h.sim_name.charAt(0).toUpperCase()
      })),
      detectors:    detectors.rows,
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
  'HH-TC-2024-3430LABS':  'harmony',
  'HK-TC-2024-3430LABS':  'hemlock',
  'WF-TC-2024-3430LABS':  'willow'
};

const CE_ARREST_KEYS = {
  harmony: 'HH-CE-ARREST-2024-3430LABS',
  hemlock: 'HK-CE-ARREST-2024-3430LABS',
  willow:  'WF-CE-ARREST-2024-3430LABS'
};

function validateTimeclockKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.headers['authorization'];
  if (!key || !TIMECLOCK_KEYS[key]) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  req.timeclockOrg = TIMECLOCK_KEYS[key];
  next();
}



// ── POST /dispatch/police ─────────────────────────────────────
app.post('/dispatch/police', async (req, res) => {
  const { caller_name, region, address, issue, org_code, timestamp } = req.body;
  const org = org_code || 'hemlock';
  const ts  = timestamp || new Date().toISOString();

  try {
    const result = await pool.query(
      `INSERT INTO dispatch_calls
         (caller_name, location, incident_type, units, notes, status, org_code, department, created_at)
       VALUES ($1, $2, $3, $4, $5, 'active', $6, 'PD', NOW())
       RETURNING id`,
      [caller_name, address || region, issue, '', '', org]
    );
    const callId = result.rows[0].id;

    await postDiscord(org, {
      embeds: [{
        title: '🚔 Police Dispatch — ' + region,
        description: '**Caller:** ' + caller_name + '\n**Location:** ' + (address || region) + '\n**Details:** ' + issue,
        color: 0x1F6FEB,
        timestamp: ts
      }]
    });

    res.json({ success: true, call_id: callId });
  } catch (err) {
    console.error('Police dispatch error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ── GET /dispatch/fire/trigger (SmartBot GET-based dispatch) ──
app.get('/dispatch/fire/trigger', async (req, res) => {
  const { caller, region, address, issue, org, units, incident } = req.query;
  const org_code = org || 'rfr';
  try {
    const result = await pool.query(
      `INSERT INTO fire_alarms
         (detector_code, sim_code, region, alarm_type, fire_count, incident_type, units_dispatched, org_code, notes, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', NOW())
       RETURNING id`,
      ['DISP', 'DISP', region, 'FIRE', 1, incident || 'Fire', units || '', org_code, (caller || '') + ' | ' + (issue || '')]
    );
    const alarmId = result.rows[0].id;

    await pool.query(
      `INSERT INTO alarm_notifications
         (alarm_id, org_code, department, message, seen, seen_panel, created_at)
       VALUES ($1, $2, 'fd', 'SmartBot Dispatch', false, false, NOW())`,
      [alarmId, org_code]
    );

    await postDiscord(org_code, {
      embeds: [{
        title: '🚒 Fire Dispatch — ' + region,
        description: '**Caller:** ' + caller + '\n**Incident:** ' + (incident || 'Fire') + '\n**Units:** ' + (units || 'N/A') + '\n**Location:** ' + (address || region) + '\n**Details:** ' + issue,
        color: 0xFF4500
      }]
    });

    res.json({ success: true, alarm_id: alarmId });
  } catch (err) {
    console.error('Fire trigger error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /dispatch/medical/trigger (SmartBot GET-based dispatch) ──
app.get('/dispatch/medical/trigger', async (req, res) => {
  const { caller, region, address, issue, org, units, incident } = req.query;
  const org_code = org || 'rfr';
  try {
    const result = await pool.query(
      `INSERT INTO fire_alarms
         (detector_code, sim_code, region, alarm_type, fire_count, incident_type, units_dispatched, org_code, notes, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', NOW())
       RETURNING id`,
      ['DISP', 'DISP', region, 'MEDICAL', 1, incident || 'Medical', units || '', org_code, (caller || '') + ' | ' + (issue || '')]
    );
    const alarmId = result.rows[0].id;

    await pool.query(
      `INSERT INTO alarm_notifications
         (alarm_id, org_code, department, message, seen, seen_panel, created_at)
       VALUES ($1, $2, 'fd', 'SmartBot Medical Dispatch', false, false, NOW())`,
      [alarmId, org_code]
    );

    await postDiscord(org_code, {
      embeds: [{
        title: '🚑 Medical Dispatch — ' + region,
        description: '**Caller:** ' + caller + '\n**Incident:** ' + (incident || 'Medical') + '\n**Units:** ' + (units || 'N/A') + '\n**Location:** ' + (address || region) + '\n**Details:** ' + issue,
        color: 0x9B59B6
      }]
    });

    res.json({ success: true, alarm_id: alarmId });
  } catch (err) {
    console.error('Medical trigger error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /dispatch/police/trigger (SmartBot GET-based dispatch) ──
app.get('/dispatch/police/trigger', async (req, res) => {
  const { caller, region, address, issue, org, hostile } = req.query;
  const org_code = org || 'hemlock';
  try {
    const result = await pool.query(
      `INSERT INTO dispatch_calls
         (caller_name, location, incident_type, units, notes, status, org_code, department, created_at)
       VALUES ($1, $2, $3, $4, $5, 'active', $6, 'PD', NOW())
       RETURNING id`,
      [caller, address || region, issue, '', hostile === 'true' ? 'HOSTILE' : '', org_code]
    );
    const callId = result.rows[0].id;

    await postDiscord(org_code, {
      embeds: [{
        title: (hostile === 'true' ? '🚨 ACTIVE THREAT' : '🚔 Police Dispatch') + ' — ' + region,
        description: '**Caller:** ' + caller + '\n**Location:** ' + (address || region) + '\n**Details:** ' + issue,
        color: 0x1F6FEB
      }]
    });

    res.json({ success: true, call_id: callId });
  } catch (err) {
    console.error('Police trigger error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ── PATCH /dispatch/police/close ─────────────────────────────
app.patch('/dispatch/police/close', async (req, res) => {
  const org = req.query.org || 'hemlock';
  try {
    await pool.query(
      `UPDATE dispatch_calls
       SET status = 'closed', closed_at = NOW()
       WHERE org_code = $1
         AND department = 'PD'
         AND status = 'active'`,
      [org]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Police close error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /dispatch/police/active ───────────────────────────────
app.get('/dispatch/police/active', async (req, res) => {
  const org = req.query.org || 'hemlock';
  try {
    const result = await pool.query(
      `SELECT id, caller_name, location, incident_type, created_at
       FROM dispatch_calls
       WHERE org_code = $1
         AND department = 'PD'
         AND status = 'active'
       ORDER BY created_at DESC
       LIMIT 5`,
      [org]
    );
    if (result.rows.length === 0) return res.json([]);
    res.json(result.rows);
  } catch (err) {
    console.error('Police active error:', err);
    res.status(500).json({ error: err.message });
  }
});




// ── POST /dispatch/police ─────────────────────────────────────
app.post('/dispatch/police', async (req, res) => {
  const { caller_name, region, address, issue, org_code, timestamp } = req.body;
  const org = org_code || 'hemlock';
  const ts  = timestamp || new Date().toISOString();

  try {
    // Insert into dispatch_calls with department = 'PD'
    const result = await pool.query(
      `INSERT INTO dispatch_calls
         (caller_name, location, incident_type, units, notes, status, org_code, department, created_at)
       VALUES ($1, $2, $3, $4, $5, 'active', $6, 'PD', NOW())
       RETURNING id`,
      [caller_name, address || region, issue, '', '', org]
    );
    const callId = result.rows[0].id;

    // Discord webhook (blue)
    await postDiscord(org, {
      embeds: [{
        title: '🚔 Police Dispatch — ' + region,
        description: '**Caller:** ' + caller_name + '\n**Location:** ' + (address || region) + '\n**Details:** ' + issue,
        color: 0x1F6FEB,
        timestamp: ts
      }]
    });

    res.json({ success: true, call_id: callId });
  } catch (err) {
    console.error('Police dispatch error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

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
    const callRes = await pool.query('SELECT * FROM dispatch_calls WHERE id = $1', [req.params.id]);
    if (callRes.rows.length === 0) return res.status(404).json({ error: 'Call not found' });
    const call = callRes.rows[0];
    const org = call.org_code;
    const unitsStr = Array.isArray(units) ? units.join(',') : (units || '');
    const alarmType = (call_type === 'medical') ? 'MEDICAL' : 'FIRE';
    const alarmResult = await pool.query(
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
    await pool.query(
      'INSERT INTO alarm_notifications (alarm_id, department, message, org_code) VALUES ($1,$2,$3,$4)',
      [alarmId, 'fd',
       (alarmType==='MEDICAL'?'Medical':'Fire') + ' dispatch by ' + (call.dispatcher||'Dispatcher') + ' | ' + (incident_type||'') + ' | ' + (call.caller_name||''), org]
    );
    await pool.query(
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




// CE level system: level N requires N*N*25 total XP. 10 ranks of 10 levels.
function ceCalcLevel(xp) {
  let lvl = Math.floor(Math.sqrt(xp / 25));
  if (lvl < 1) lvl = 1;
  if (lvl > 100) lvl = 100;
  return lvl;
}
const CE_RANKS = ["Street Rat","Petty Thief","Hustler","Runner","Enforcer","Racketeer","Capo","Underboss","Boss","Kingpin"];
function ceRankName(level) {
  let idx = Math.floor((level - 1) / 10);
  if (idx < 0) idx = 0;
  if (idx > 9) idx = 9;
  return CE_RANKS[idx];
}
async function ceAddXp(uuid, org, amount) {
  const r = await pool.query(
    `UPDATE ce_criminals SET xp=GREATEST(0, xp+$1) WHERE avatar_uuid=$2 AND community_org=$3 RETURNING xp, level`,
    [amount, uuid, org]
  );
  if (r.rows.length === 0) return null;
  const newLevel = ceCalcLevel(r.rows[0].xp);
  if (newLevel !== r.rows[0].level) {
    await pool.query(`UPDATE ce_criminals SET level=$1, skill_level=$1 WHERE avatar_uuid=$2 AND community_org=$3`, [newLevel, uuid, org]);
  }
  return { xp: r.rows[0].xp, level: newLevel, leveled_up: newLevel > r.rows[0].level, rank: ceRankName(newLevel) };
}

// ============================================================
// CRIMINAL EMPIRES — Phase 1 Economy Routes
// ============================================================

// Register/upsert a criminal into ce_criminals and CivCore civilians
app.post('/ce/criminal/register', async (req, res) => {
  const { avatar_uuid, avatar_name, community_org } = req.body;
  if (!avatar_uuid || !avatar_name || !community_org) return res.status(400).json({ error: 'Missing fields' });
  const sanitizedName = avatar_name.replace(/'/g, "''");
  try {
    // Upsert ce_criminals
    await pool.query(
      `INSERT INTO ce_criminals (avatar_uuid, avatar_name, community_org)
       VALUES ($1, $2, $3)
       ON CONFLICT (avatar_uuid, community_org) DO UPDATE SET avatar_name=$2, last_active=NOW()`,
      [avatar_uuid, avatar_name, community_org]
    );
    const result = await pool.query(
      `SELECT * FROM ce_criminals WHERE avatar_uuid=$1 AND community_org=$2`,
      [avatar_uuid, community_org]
    );
    res.json({ success: true, criminal: result.rows[0] });
  } catch (err) {
    console.error('CE register error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Register a robbable item (called by item script on_rez or owner touch)
app.post('/ce/item/register', async (req, res) => {
  const { item_code, item_name, item_type, owner_uuid, owner_name, community_org, region, sim_x, sim_y, sim_z, base_value } = req.body;
  if (!item_code || !item_name || !community_org) return res.status(400).json({ error: 'Missing fields' });
  try {
    await pool.query(
      `INSERT INTO ce_items (item_code, item_name, item_type, owner_uuid, owner_name, community_org, region, sim_x, sim_y, sim_z, base_value, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'available')
       ON CONFLICT (item_code) DO UPDATE SET
         item_name=$2, item_type=$3, owner_uuid=$4, owner_name=$5,
         community_org=$6, region=$7, sim_x=$8, sim_y=$9, sim_z=$10,
         base_value=$11, status='available', stolen_by_uuid=NULL,
         stolen_by_name=NULL, stolen_at=NULL`,
      [item_code, item_name, item_type, owner_uuid, owner_name, community_org, region, sim_x||0, sim_y||0, sim_z||0, base_value||100]
    );
    res.json({ success: true, item_code });
  } catch (err) {
    console.error('CE item register error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Steal an item
app.post('/ce/item/steal', async (req, res) => {
  const { item_code, criminal_uuid, criminal_name, community_org } = req.body;
  if (!item_code || !criminal_uuid || !community_org) return res.status(400).json({ error: 'Missing fields' });
  try {
    const check = await pool.query(`SELECT * FROM ce_items WHERE item_code=$1`, [item_code]);
    if (check.rows.length === 0) return res.status(404).json({ error: 'Item not found' });
    if (check.rows[0].status !== 'available') return res.status(409).json({ error: 'Item already stolen' });
    // Level gate
    const gate = await pool.query(`SELECT level FROM ce_criminals WHERE avatar_uuid=$1 AND community_org=$2`, [criminal_uuid, community_org]);
    const thiefLevel = gate.rows.length > 0 ? gate.rows[0].level : 1;
    const minLvl = check.rows[0].min_level || 1;
    if (thiefLevel < minLvl) {
      return res.status(403).json({ error: "Level " + minLvl + " required. You are level " + thiefLevel + "." });
    }
    // Auto-register criminal if not already registered
    await pool.query(
      `INSERT INTO ce_criminals (avatar_uuid, avatar_name, community_org)
       VALUES ($1, $2, $3)
       ON CONFLICT (avatar_uuid, community_org) DO UPDATE SET avatar_name=$2, last_active=NOW()`,
      [criminal_uuid, criminal_name, community_org]
    );
    // Auto-detect and consume accessories
    const acc = await pool.query(
      `SELECT gloves_uses, mask_uses FROM ce_criminals WHERE avatar_uuid=$1 AND community_org=$2`,
      [criminal_uuid, community_org]
    );
    let usedGloves = false;
    let usedMask = false;
    if (acc.rows.length > 0) {
      if (acc.rows[0].gloves_uses > 0) usedGloves = true;
      if (acc.rows[0].mask_uses > 0) usedMask = true;
    }
    const thiefName = usedMask ? "Unknown" : criminal_name;
    if (usedGloves) {
      await pool.query(`UPDATE ce_criminals SET gloves_uses=gloves_uses-1 WHERE avatar_uuid=$1 AND community_org=$2`, [criminal_uuid, community_org]);
    }
    if (usedMask) {
      await pool.query(`UPDATE ce_criminals SET mask_uses=mask_uses-1 WHERE avatar_uuid=$1 AND community_org=$2`, [criminal_uuid, community_org]);
    }
    await pool.query(
      `UPDATE ce_items SET status='stolen', stolen_by_uuid=$1, stolen_by_name=$2, stolen_at=NOW(), fingerprints_present=$4 WHERE item_code=$3`,
      [criminal_uuid, thiefName, item_code, !usedGloves]
    );
    // Increment criminal stats
    await pool.query(
      `UPDATE ce_criminals SET total_steals=total_steals+1, heat_level=LEAST(10, heat_level+2), last_active=NOW()
       WHERE avatar_uuid=$1 AND community_org=$2`,
      [criminal_uuid, community_org]
    );
    const xpInfo = await ceAddXp(criminal_uuid, community_org, 10);
    res.json({ success: true, item: check.rows[0].item_name, value: check.rows[0].base_value, used_gloves: usedGloves, used_mask: usedMask, level: xpInfo ? xpInfo.level : thiefLevel, leveled_up: xpInfo ? xpInfo.leveled_up : false, rank: xpInfo ? xpInfo.rank : "" });
  } catch (err) {
    console.error('CE steal error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get criminal's stolen inventory
app.get('/ce/inventory', async (req, res) => {
  const { uuid, org } = req.query;
  if (!uuid || !org) return res.status(400).json({ error: 'Missing uuid or org' });
  try {
    const items = await pool.query(
      `SELECT id, item_code, item_name, item_type, base_value, stolen_at
       FROM ce_items WHERE stolen_by_uuid=$1 AND community_org=$2 AND status='stolen'
       ORDER BY stolen_at DESC`,
      [uuid, org]
    );
    const criminal = await pool.query(
      `SELECT heat_level, total_steals, total_fenced, total_earnings, skill_level, bank_balance, cash_on_hand, role, xp, level, player_type FROM ce_criminals WHERE avatar_uuid=$1 AND community_org=$2`,
      [uuid, org]
    );
    const st = criminal.rows[0] || null;
    if (st) st.rank = ceRankName(st.level || 1);
    res.json({ items: items.rows, stats: st });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fence an item at pawn shop
app.post('/ce/item/fence', async (req, res) => {
  const { item_code, criminal_uuid, criminal_name, community_org, payout_pct } = req.body;
  if (!item_code || !criminal_uuid || !community_org) return res.status(400).json({ error: 'Missing fields' });
  const pct = parseInt(payout_pct) || 40;
  try {
    const check = await pool.query(`SELECT * FROM ce_items WHERE item_code=$1`, [item_code]);
    if (check.rows.length === 0) return res.status(404).json({ error: 'Item not found' });
    if (check.rows[0].status !== 'stolen') return res.status(409).json({ error: 'Item not in stolen state' });
    if (check.rows[0].stolen_by_uuid !== criminal_uuid) return res.status(403).json({ error: 'Not your item' });
    const payout = Math.floor(check.rows[0].base_value * (pct / 100));
    // Mark fenced
    await pool.query(`UPDATE ce_items SET status='fenced' WHERE item_code=$1`, [item_code]);
    // Log transaction
    await pool.query(
      `INSERT INTO ce_transactions (item_code, item_name, criminal_uuid, criminal_name, community_org, base_value, payout, payout_pct)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [item_code, check.rows[0].item_name, criminal_uuid, criminal_name, community_org, check.rows[0].base_value, payout, pct]
    );
    // Update criminal stats
    await pool.query(
      `UPDATE ce_criminals SET total_fenced=total_fenced+1, total_earnings=total_earnings+$1, cash_on_hand=cash_on_hand+$1, heat_level=GREATEST(0, heat_level-5), last_active=NOW()
       WHERE avatar_uuid=$2 AND community_org=$3`,
      [payout, criminal_uuid, community_org]
    );
    const fenceXp = await ceAddXp(criminal_uuid, community_org, payout);
    const fenceCut = await ceCrewCut(criminal_uuid, community_org, payout);
    res.json({ success: true, item_name: check.rows[0].item_name, base_value: check.rows[0].base_value, payout, payout_pct: pct, level: fenceXp ? fenceXp.level : 1, leveled_up: fenceXp ? fenceXp.leveled_up : false, rank: fenceXp ? fenceXp.rank : "" });
  } catch (err) {
    console.error('CE fence error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Log an arrest and reset the suspect's heat
app.post('/ce/arrest', async (req, res) => {
  const {
    avatar_uuid, avatar_name, community_org,
    officer_uuid, officer_name, charge, notes,
    mugshot_texture, api_key
  } = req.body;

  if (!avatar_uuid || !avatar_name || !community_org || !officer_uuid || !officer_name) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  if (api_key !== CE_ARREST_KEYS[community_org]) {
    return res.status(403).json({ error: 'Invalid or missing API key for this community' });
  }

  try {
    const criminal = await pool.query(
      `SELECT heat_level FROM ce_criminals WHERE avatar_uuid=$1 AND community_org=$2`,
      [avatar_uuid, community_org]
    );
    const heatAtArrest = criminal.rows.length > 0 ? criminal.rows[0].heat_level : 0;

    await pool.query(
      `INSERT INTO ce_arrests
         (avatar_uuid, avatar_name, community_org, officer_uuid, officer_name, charge, notes, mugshot_texture, heat_at_arrest)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [avatar_uuid, avatar_name, community_org, officer_uuid, officer_name, charge || null, notes || null, mugshot_texture || null, heatAtArrest]
    );

    await pool.query(
      `UPDATE ce_criminals
       SET total_arrests = total_arrests + 1,
           mugshot_texture = COALESCE($1, mugshot_texture),
           heat_level = 0,
           last_active = NOW()
       WHERE avatar_uuid=$2 AND community_org=$3`,
      [mugshot_texture || null, avatar_uuid, community_org]
    );

    res.json({ success: true, avatar_name, charge, heat_at_arrest: heatAtArrest });
  } catch (err) {
    console.error('CE arrest error:', err);
    res.status(500).json({ error: err.message });
  }
});
// Pull a criminal's full profile — current stats + arrest history
app.get('/ce/criminal/:uuid', async (req, res) => {
  const { org } = req.query;
  const { uuid } = req.params;
  if (!org) return res.status(400).json({ error: 'Missing org' });

  try {
    const criminal = await pool.query(
      `SELECT avatar_uuid, avatar_name, heat_level, total_steals, total_fenced,
              total_earnings, total_arrests, skill_level, bank_balance, cash_on_hand,
              role, mugshot_texture, registered_at, last_active
       FROM ce_criminals WHERE avatar_uuid=$1 AND community_org=$2`,
      [uuid, org]
    );
    if (criminal.rows.length === 0) return res.status(404).json({ error: 'Criminal not found' });

    const arrests = await pool.query(
      `SELECT officer_name, charge, notes, mugshot_texture, heat_at_arrest, created_at
       FROM ce_arrests WHERE avatar_uuid=$1 AND community_org=$2
       ORDER BY created_at DESC`,
      [uuid, org]
    );

    res.json({ profile: criminal.rows[0], arrest_history: arrests.rows });
  } catch (err) {
    console.error('CE criminal profile error:', err);
    res.status(500).json({ error: err.message });
  }
});

// CE Accessory Add (called by vendor on purchase)
app.post('/ce/accessory/add', async (req, res) => {
  const { avatar_uuid, community_org, accessory, uses } = req.body;
  if (!avatar_uuid || !community_org || !accessory) return res.status(400).json({ error: 'Missing fields' });
  const valid = ['gloves', 'mask', 'lockpick', 'hacker', 'jammer'];
  if (!valid.includes(accessory)) return res.status(400).json({ error: 'Invalid accessory' });
  const col = accessory + '_uses';
  const amt = parseInt(uses) || 5;
  try {
    await pool.query(
      `UPDATE ce_criminals SET ${col}=${col}+$1, last_active=NOW() WHERE avatar_uuid=$2 AND community_org=$3`,
      [amt, avatar_uuid, community_org]
    );
    const result = await pool.query(
      `SELECT gloves_uses, mask_uses, lockpick_uses, hacker_uses, jammer_uses FROM ce_criminals WHERE avatar_uuid=$1 AND community_org=$2`,
      [avatar_uuid, community_org]
    );
    res.json({ success: true, accessory, uses_added: amt, current: result.rows[0] });
  } catch (err) {
    console.error('CE accessory add error:', err);
    res.status(500).json({ error: err.message });
  }
});

// CE Accessory Use (called by HUD when consuming a use)
app.post('/ce/accessory/use', async (req, res) => {
  const { avatar_uuid, community_org, accessory } = req.body;
  if (!avatar_uuid || !community_org || !accessory) return res.status(400).json({ error: 'Missing fields' });
  const valid = ['gloves', 'mask', 'lockpick', 'hacker', 'jammer'];
  if (!valid.includes(accessory)) return res.status(400).json({ error: 'Invalid accessory' });
  const col = accessory + '_uses';
  try {
    const check = await pool.query(
      `SELECT ${col} as uses FROM ce_criminals WHERE avatar_uuid=$1 AND community_org=$2`,
      [avatar_uuid, community_org]
    );
    if (check.rows.length === 0) return res.status(404).json({ error: 'Criminal not found' });
    if (check.rows[0].uses <= 0) return res.status(409).json({ error: 'No uses remaining' });
    await pool.query(
      `UPDATE ce_criminals SET ${col}=GREATEST(0, ${col}-1), last_active=NOW() WHERE avatar_uuid=$1 AND community_org=$2`,
      [avatar_uuid, community_org]
    );
    const result = await pool.query(
      `SELECT gloves_uses, mask_uses, lockpick_uses, hacker_uses, jammer_uses FROM ce_criminals WHERE avatar_uuid=$1 AND community_org=$2`,
      [avatar_uuid, community_org]
    );
    res.json({ success: true, accessory, current: result.rows[0] });
  } catch (err) {
    console.error('CE accessory use error:', err);
    res.status(500).json({ error: err.message });
  }
});

// CE Get Accessories (called by HUD on attach/refresh)
app.get('/ce/accessories', async (req, res) => {
  const { uuid, org } = req.query;
  if (!uuid || !org) return res.status(400).json({ error: 'Missing uuid or org' });
  try {
    const result = await pool.query(
      `SELECT gloves_uses, mask_uses, lockpick_uses, hacker_uses, jammer_uses FROM ce_criminals WHERE avatar_uuid=$1 AND community_org=$2`,
      [uuid, org]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Criminal not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ============================================================
// CRIMINAL EMPIRES — Bank System
// ============================================================

// Deposit street cash into bank
app.post("/ce/bank/deposit", async (req, res) => {
  const { avatar_uuid, community_org, amount } = req.body;
  const amt = parseInt(amount);
  if (!avatar_uuid || !community_org || !amt || amt <= 0) return res.status(400).json({ error: "Missing or invalid fields" });
  try {
    const r = await pool.query(
      `UPDATE ce_criminals SET cash_on_hand=cash_on_hand-$1, bank_balance=bank_balance+$1, last_active=NOW()
       WHERE avatar_uuid=$2 AND community_org=$3 AND cash_on_hand >= $1
       RETURNING cash_on_hand, bank_balance`,
      [amt, avatar_uuid, community_org]
    );
    if (r.rows.length === 0) return res.status(409).json({ error: "Insufficient cash" });
    res.json({ success: true, deposited: amt, cash_on_hand: r.rows[0].cash_on_hand, bank_balance: r.rows[0].bank_balance });
  } catch (err) {
    console.error("CE deposit error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Withdraw bank money to street cash
app.post("/ce/bank/withdraw", async (req, res) => {
  const { avatar_uuid, community_org, amount } = req.body;
  const amt = parseInt(amount);
  if (!avatar_uuid || !community_org || !amt || amt <= 0) return res.status(400).json({ error: "Missing or invalid fields" });
  try {
    const r = await pool.query(
      `UPDATE ce_criminals SET bank_balance=bank_balance-$1, cash_on_hand=cash_on_hand+$1, last_active=NOW()
       WHERE avatar_uuid=$2 AND community_org=$3 AND bank_balance >= $1
       RETURNING cash_on_hand, bank_balance`,
      [amt, avatar_uuid, community_org]
    );
    if (r.rows.length === 0) return res.status(409).json({ error: "Insufficient bank balance" });
    res.json({ success: true, withdrawn: amt, cash_on_hand: r.rows[0].cash_on_hand, bank_balance: r.rows[0].bank_balance });
  } catch (err) {
    console.error("CE withdraw error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Check balance
app.get("/ce/bank/balance", async (req, res) => {
  const { uuid, org } = req.query;
  if (!uuid || !org) return res.status(400).json({ error: "Missing uuid or org" });
  try {
    const r = await pool.query(
      `SELECT cash_on_hand, bank_balance, level FROM ce_criminals WHERE avatar_uuid=$1 AND community_org=$2`,
      [uuid, org]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: "Not registered" });
    res.json({ cash_on_hand: r.rows[0].cash_on_hand, bank_balance: r.rows[0].bank_balance, level: r.rows[0].level });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rob the bank — level gated, 60 min cooldown, +5 heat
app.post("/ce/bank/rob", async (req, res) => {
  const { avatar_uuid, avatar_name, community_org, min_level } = req.body;
  if (!avatar_uuid || !community_org) return res.status(400).json({ error: "Missing fields" });
  const gateLevel = parseInt(min_level) || 21;
  try {
    const c = await pool.query(
      `SELECT level, last_bank_rob FROM ce_criminals WHERE avatar_uuid=$1 AND community_org=$2`,
      [avatar_uuid, community_org]
    );
    if (c.rows.length === 0) return res.status(404).json({ error: "Not registered" });
    if (c.rows[0].level < gateLevel) {
      return res.status(403).json({ error: "Level " + gateLevel + " required. You are level " + c.rows[0].level + "." });
    }
    if (c.rows[0].last_bank_rob) {
      const mins = (Date.now() - new Date(c.rows[0].last_bank_rob).getTime()) / 60000;
      if (mins < 60) {
        return res.status(429).json({ error: "Bank security too high. Wait " + Math.ceil(60 - mins) + " more minutes." });
      }
    }
    const payout = 1000 + Math.floor(Math.random() * 1500);
    await pool.query(
      `UPDATE ce_criminals SET cash_on_hand=cash_on_hand+$1, heat_level=LEAST(10, heat_level+5),
       last_bank_rob=NOW(), last_active=NOW() WHERE avatar_uuid=$2 AND community_org=$3`,
      [payout, avatar_uuid, community_org]
    );
    await pool.query(
      `INSERT INTO ce_transactions (item_code, item_name, criminal_uuid, criminal_name, community_org, base_value, payout, payout_pct)
       VALUES ($1,$2,$3,$4,$5,$6,$7,100)`,
      ["BANK-" + Date.now(), "BANK ROBBERY", avatar_uuid, avatar_name || "Unknown", community_org, payout, payout]
    );
    const xpInfo = await ceAddXp(avatar_uuid, community_org, 250);
    await ceCrewCut(avatar_uuid, community_org, payout);
    res.json({ success: true, payout: payout, heat_added: 5, level: xpInfo ? xpInfo.level : 0, leveled_up: xpInfo ? xpInfo.leveled_up : false, rank: xpInfo ? xpInfo.rank : "" });
  } catch (err) {
    console.error("CE bank rob error:", err);
    res.status(500).json({ error: err.message });
  }
});


// ============================================================
// CRIMINAL EMPIRES — City Economy: Cash Register Tills
// ============================================================

// Register a till (business cash register)
// Business capacity scales with owner level
function ceBusinessStats(level) {
  let lvl = parseInt(level) || 1;
  if (lvl < 1) lvl = 1;
  return {
    max_balance: 250 + (lvl * 50),
    fill_rate: 10 + (lvl * 2),
    min_rob_level: Math.max(1, Math.floor(lvl / 4)),
    license_fee: 1000 + (lvl * 200)
  };
}

app.post("/ce/till/register", async (req, res) => {
  const { register_code, business_name, owner_uuid, owner_name, community_org, region } = req.body;
  if (!register_code || !owner_uuid || !community_org) return res.status(400).json({ error: "Missing fields" });
  try {
    await pool.query(
      `INSERT INTO ce_criminals (avatar_uuid, avatar_name, community_org)
       VALUES ($1, $2, $3)
       ON CONFLICT (avatar_uuid, community_org) DO UPDATE SET avatar_name=$2, last_active=NOW()`,
      [owner_uuid, owner_name || "Business Owner", community_org]
    );
    const o = await pool.query(
      `SELECT level, bank_balance FROM ce_criminals WHERE avatar_uuid=$1 AND community_org=$2`,
      [owner_uuid, community_org]
    );
    const lvl = o.rows[0].level || 1;
    const bank = o.rows[0].bank_balance || 0;
    const stats = ceBusinessStats(lvl);

    const existing = await pool.query(`SELECT license_paid FROM ce_registers WHERE register_code=$1`, [register_code]);
    if (existing.rows.length > 0 && existing.rows[0].license_paid) {
      await pool.query(
        `UPDATE ce_registers SET business_name=$2, owner_name=$3, region=$4,
         fill_rate=$5, max_balance=$6, min_rob_level=$7 WHERE register_code=$1`,
        [register_code, business_name || "Business", owner_name || "", region || "",
         stats.fill_rate, stats.max_balance, stats.min_rob_level]
      );
      return res.json({ success: true, register_code, licensed: true, level: lvl,
        max_balance: stats.max_balance, fill_rate: stats.fill_rate, min_rob_level: stats.min_rob_level });
    }

    if (bank < stats.license_fee) {
      return res.status(403).json({ error: "Business license costs L$" + stats.license_fee + " from your bank. You have L$" + bank + "." });
    }
    await pool.query(`UPDATE ce_criminals SET bank_balance=bank_balance-$1 WHERE avatar_uuid=$2 AND community_org=$3`,
      [stats.license_fee, owner_uuid, community_org]);
    await pool.query(`UPDATE ce_city SET treasury=treasury+$1 WHERE community_org=$2`,
      [stats.license_fee, community_org]);

    await pool.query(
      `INSERT INTO ce_registers (register_code, business_name, owner_uuid, owner_name, community_org, region, fill_rate, max_balance, min_rob_level, license_paid, license_fee)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,$10)
       ON CONFLICT (register_code) DO UPDATE SET
         business_name=$2, owner_uuid=$3, owner_name=$4, community_org=$5, region=$6,
         fill_rate=$7, max_balance=$8, min_rob_level=$9, license_paid=TRUE, license_fee=$10`,
      [register_code, business_name || "Business", owner_uuid, owner_name || "", community_org, region || "",
       stats.fill_rate, stats.max_balance, stats.min_rob_level, stats.license_fee]
    );
    res.json({ success: true, register_code, licensed: true, level: lvl,
      fee_charged: stats.license_fee, remaining_bank: bank - stats.license_fee,
      max_balance: stats.max_balance, fill_rate: stats.fill_rate, min_rob_level: stats.min_rob_level });
  } catch (err) {
    console.error("CE till register error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/ce/till/status", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: "Missing code" });
  try {
    const r = await pool.query(
      `SELECT r.business_name, r.balance, r.owner_uuid, COALESCE(cr.level,1) AS owner_level
       FROM ce_registers r
       LEFT JOIN ce_criminals cr ON cr.avatar_uuid = r.owner_uuid AND cr.community_org = r.community_org
       WHERE r.register_code=$1`, [code]);
    if (r.rows.length === 0) return res.status(404).json({ error: "Till not registered" });
    const stats = ceBusinessStats(r.rows[0].owner_level);
    res.json({
      business_name: r.rows[0].business_name,
      balance: r.rows[0].balance,
      max_balance: stats.max_balance,
      fill_rate: stats.fill_rate,
      min_rob_level: stats.min_rob_level,
      owner_level: r.rows[0].owner_level,
      owner_uuid: r.rows[0].owner_uuid
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Owner collects till — clean income to bank_balance
app.post("/ce/till/collect", async (req, res) => {
  const { register_code, avatar_uuid, community_org } = req.body;
  if (!register_code || !avatar_uuid || !community_org) return res.status(400).json({ error: "Missing fields" });
  try {
    const t = await pool.query(`SELECT * FROM ce_registers WHERE register_code=$1`, [register_code]);
    if (t.rows.length === 0) return res.status(404).json({ error: "Till not registered" });
    if (t.rows[0].owner_uuid !== avatar_uuid) return res.status(403).json({ error: "Not your till" });
    const amount = t.rows[0].balance;
    if (amount <= 0) return res.status(409).json({ error: "Till is empty" });
    await pool.query(`UPDATE ce_registers SET balance=0, last_collected=NOW() WHERE register_code=$1`, [register_code]);
    await pool.query(
      `INSERT INTO ce_criminals (avatar_uuid, avatar_name, community_org)
       VALUES ($1, $2, $3)
       ON CONFLICT (avatar_uuid, community_org) DO NOTHING`,
      [avatar_uuid, t.rows[0].owner_name || "Business Owner", community_org]
    );
    const u = await pool.query(
      `UPDATE ce_criminals SET bank_balance=bank_balance+$1, last_active=NOW()
       WHERE avatar_uuid=$2 AND community_org=$3 RETURNING bank_balance`,
      [amount, avatar_uuid, community_org]
    );
    res.json({ success: true, collected: amount, bank_balance: u.rows.length ? u.rows[0].bank_balance : 0 });
  } catch (err) {
    console.error("CE till collect error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Criminal robs till — dirty cash, +heat, cooldown
// Crack time based on level + lockpick
function ceCrackTime(level, hasLockpick) {
  let t = 20 - Math.floor(level / 5);
  if (hasLockpick) t = t - 5;
  if (t < 8) t = 8;
  return t;
}

// Pre-rob check — returns crack time and tool loadout
app.post("/ce/till/attempt", async (req, res) => {
  const { register_code, criminal_uuid, criminal_name, community_org } = req.body;
  if (!register_code || !criminal_uuid || !community_org) return res.status(400).json({ error: "Missing fields" });
  try {
    const t = await pool.query(`SELECT * FROM ce_registers WHERE register_code=$1`, [register_code]);
    if (t.rows.length === 0) return res.status(404).json({ error: "Till not registered" });
    if (t.rows[0].owner_uuid === criminal_uuid) return res.status(403).json({ error: "You cannot rob your own till" });
    if (t.rows[0].balance <= 0) return res.status(409).json({ error: "The register is empty" });
    if (t.rows[0].last_robbed) {
      const rmins = (Date.now() - new Date(t.rows[0].last_robbed).getTime()) / 60000;
      if (rmins < 30) return res.status(429).json({ error: "This register was just hit. Try again in " + Math.ceil(30 - rmins) + " min." });
    }
    if (t.rows[0].last_robbed) {
      const mins = (Date.now() - new Date(t.rows[0].last_robbed).getTime()) / 60000;
      if (mins < 30) return res.status(429).json({ error: "This register was just hit. Wait " + Math.ceil(30 - mins) + " min." });
    }
    await pool.query(
      `INSERT INTO ce_criminals (avatar_uuid, avatar_name, community_org)
       VALUES ($1, $2, $3)
       ON CONFLICT (avatar_uuid, community_org) DO UPDATE SET avatar_name=$2, last_active=NOW()`,
      [criminal_uuid, criminal_name || "Unknown", community_org]
    );
    const c = await pool.query(
      `SELECT level, gloves_uses, mask_uses, lockpick_uses, jammer_uses FROM ce_criminals
       WHERE avatar_uuid=$1 AND community_org=$2`, [criminal_uuid, community_org]
    );
    const lvl = c.rows[0].level || 1;
    if (lvl < t.rows[0].min_rob_level) {
      return res.status(403).json({ error: "Level " + t.rows[0].min_rob_level + " required. You are level " + lvl + "." });
    }
    const hasPick = c.rows[0].lockpick_uses > 0;
    res.json({
      success: true,
      crack_seconds: ceCrackTime(lvl, hasPick),
      level: lvl,
      has_lockpick: hasPick,
      has_mask: c.rows[0].mask_uses > 0,
      has_gloves: c.rows[0].gloves_uses > 0,
      has_jammer: c.rows[0].jammer_uses > 0
    });
  } catch (err) {
    console.error("CE till attempt error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Criminal robs till — consumes tools, applies effects
app.post("/ce/till/rob", async (req, res) => {
  const { register_code, criminal_uuid, criminal_name, community_org } = req.body;
  if (!register_code || !criminal_uuid || !community_org) return res.status(400).json({ error: "Missing fields" });
  try {
    const t = await pool.query(`SELECT * FROM ce_registers WHERE register_code=$1`, [register_code]);
    if (t.rows.length === 0) return res.status(404).json({ error: "Till not registered" });
    if (t.rows[0].owner_uuid === criminal_uuid) return res.status(403).json({ error: "You cannot rob your own till" });
    if (t.rows[0].balance <= 0) return res.status(409).json({ error: "The register is empty" });
    if (t.rows[0].last_robbed) {
      const rmins = (Date.now() - new Date(t.rows[0].last_robbed).getTime()) / 60000;
      if (rmins < 30) return res.status(429).json({ error: "This register was just hit. Try again in " + Math.ceil(30 - rmins) + " min." });
    }
    if (t.rows[0].last_robbed) {
      const mins = (Date.now() - new Date(t.rows[0].last_robbed).getTime()) / 60000;
      if (mins < 30) return res.status(429).json({ error: "This register was just hit. Wait " + Math.ceil(30 - mins) + " min." });
    }
    await pool.query(
      `INSERT INTO ce_criminals (avatar_uuid, avatar_name, community_org)
       VALUES ($1, $2, $3)
       ON CONFLICT (avatar_uuid, community_org) DO UPDATE SET avatar_name=$2, last_active=NOW()`,
      [criminal_uuid, criminal_name || "Unknown", community_org]
    );
    const c = await pool.query(
      `SELECT level, gloves_uses, mask_uses, lockpick_uses, jammer_uses FROM ce_criminals
       WHERE avatar_uuid=$1 AND community_org=$2`, [criminal_uuid, community_org]
    );
    const lvl = c.rows[0].level || 1;
    if (lvl < t.rows[0].min_rob_level) {
      return res.status(403).json({ error: "Level " + t.rows[0].min_rob_level + " required. You are level " + lvl + "." });
    }

    const usedGloves = c.rows[0].gloves_uses > 0;
    const usedMask = c.rows[0].mask_uses > 0;
    const usedPick = c.rows[0].lockpick_uses > 0;
    const usedJammer = c.rows[0].jammer_uses > 0;

    let payout = t.rows[0].balance;
    let heat = 3;
    if (!usedPick) {
      payout = Math.floor(payout * 0.75);
      heat = heat + 1;
    }
    let thiefName = criminal_name || "Unknown";
    if (usedMask) thiefName = "Unknown";

    if (usedGloves) await pool.query(`UPDATE ce_criminals SET gloves_uses=gloves_uses-1 WHERE avatar_uuid=$1 AND community_org=$2`, [criminal_uuid, community_org]);
    if (usedMask) await pool.query(`UPDATE ce_criminals SET mask_uses=mask_uses-1 WHERE avatar_uuid=$1 AND community_org=$2`, [criminal_uuid, community_org]);
    if (usedPick) await pool.query(`UPDATE ce_criminals SET lockpick_uses=lockpick_uses-1 WHERE avatar_uuid=$1 AND community_org=$2`, [criminal_uuid, community_org]);
    if (usedJammer) await pool.query(`UPDATE ce_criminals SET jammer_uses=jammer_uses-1 WHERE avatar_uuid=$1 AND community_org=$2`, [criminal_uuid, community_org]);

    await pool.query(`UPDATE ce_registers SET balance=0, last_robbed=NOW() WHERE register_code=$1`, [register_code]);
    await pool.query(
      `UPDATE ce_criminals SET cash_on_hand=cash_on_hand+$1, heat_level=LEAST(10, heat_level+$2), last_active=NOW()
       WHERE avatar_uuid=$3 AND community_org=$4`,
      [payout, heat, criminal_uuid, community_org]
    );
    await pool.query(
      `INSERT INTO ce_transactions (item_code, item_name, criminal_uuid, criminal_name, community_org, base_value, payout, payout_pct, fingerprints_present)
       VALUES ($1,$2,$3,$4,$5,$6,$7,100,$8)`,
      [register_code, "REGISTER ROBBERY: " + t.rows[0].business_name, criminal_uuid, thiefName, community_org, t.rows[0].balance, payout, !usedGloves]
    );
    const xpInfo = await ceAddXp(criminal_uuid, community_org, 50);
    await pool.query(
      `INSERT INTO ce_crime_scenes (register_code, business_name, community_org, region, suspect_uuid, suspect_name, amount_taken, prints_left, name_known, alarm_sounded, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'open')`,
      [register_code, t.rows[0].business_name, community_org, t.rows[0].region || "",
       criminal_uuid, criminal_name || "Unknown", payout,
       !usedGloves, !usedMask, !usedJammer]
    );
    await ceCrewCut(criminal_uuid, community_org, payout);
    res.json({
      success: true, payout: payout, heat_added: heat,
      used_gloves: usedGloves, used_mask: usedMask, used_lockpick: usedPick, used_jammer: usedJammer,
      alarm_suppressed: usedJammer,
      level: xpInfo ? xpInfo.level : 0, leveled_up: xpInfo ? xpInfo.leveled_up : false, rank: xpInfo ? xpInfo.rank : ""
    });
  } catch (err) {
    console.error("CE till rob error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// CRIMINAL EMPIRES — Structure Damage System
// ============================================================

app.post("/ce/structure/register", async (req, res) => {
  const { structure_code, structure_name, structure_type, owner_uuid, owner_name, community_org, region, max_hp, register_code } = req.body;
  if (!structure_code || !owner_uuid || !community_org) return res.status(400).json({ error: "Missing fields" });
  const hp = parseInt(max_hp) || 100;
  try {
    await pool.query(
      `INSERT INTO ce_structures (structure_code, structure_name, structure_type, owner_uuid, owner_name, community_org, region, hp, max_hp)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
       ON CONFLICT (structure_code) DO UPDATE SET
         structure_name=$2, structure_type=$3, owner_name=$5, region=$7, max_hp=$8`,
      [structure_code, structure_name || "Building", structure_type || "business", owner_uuid, owner_name || "", community_org, region || "", hp]
    );
    if (register_code) {
      await pool.query(`UPDATE ce_registers SET structure_code=$1 WHERE register_code=$2`, [structure_code, register_code]);
    }
    const r = await pool.query(`SELECT hp, max_hp, status FROM ce_structures WHERE structure_code=$1`, [structure_code]);
    res.json({ success: true, hp: r.rows[0].hp, max_hp: r.rows[0].max_hp, status: r.rows[0].status });
  } catch (err) {
    console.error("CE structure register error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/ce/structure/damage", async (req, res) => {
  const { structure_code, amount, source, attacker_uuid, attacker_name } = req.body;
  if (!structure_code) return res.status(400).json({ error: "Missing structure_code" });
  const dmg = parseInt(amount) || 1;
  try {
    const t = await pool.query(`SELECT * FROM ce_structures WHERE structure_code=$1`, [structure_code]);
    if (t.rows.length === 0) return res.status(404).json({ error: "Structure not registered" });
    const newHp = Math.max(0, t.rows[0].hp - dmg);
    let status = "operational";
    if (newHp === 0) { status = "destroyed"; }
    else if (newHp < t.rows[0].max_hp * 0.5) { status = "damaged"; }
    await pool.query(
      `UPDATE ce_structures SET hp=$1, status=$2, last_damaged=NOW(),
       damaged_by_uuid=COALESCE($3, damaged_by_uuid), damaged_by_name=COALESCE($4, damaged_by_name)
       WHERE structure_code=$5`,
      [newHp, status, attacker_uuid || null, attacker_name || null, structure_code]
    );
    res.json({ success: true, hp: newHp, max_hp: t.rows[0].max_hp, status, source: source || "unknown" });
  } catch (err) {
    console.error("CE structure damage error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/ce/structure/repair", async (req, res) => {
  const { structure_code, avatar_uuid, community_org } = req.body;
  if (!structure_code || !avatar_uuid || !community_org) return res.status(400).json({ error: "Missing fields" });
  try {
    const t = await pool.query(`SELECT * FROM ce_structures WHERE structure_code=$1`, [structure_code]);
    if (t.rows.length === 0) return res.status(404).json({ error: "Structure not registered" });
    if (t.rows[0].owner_uuid !== avatar_uuid) return res.status(403).json({ error: "Not your building" });
    const missing = t.rows[0].max_hp - t.rows[0].hp;
    if (missing <= 0) return res.status(409).json({ error: "Building is not damaged" });
    const cost = missing * 20;
    const o = await pool.query(`SELECT bank_balance FROM ce_criminals WHERE avatar_uuid=$1 AND community_org=$2`, [avatar_uuid, community_org]);
    if (o.rows.length === 0) return res.status(404).json({ error: "Owner not registered" });
    if (o.rows[0].bank_balance < cost) return res.status(403).json({ error: "Repairs cost L$" + cost + ". You have L$" + o.rows[0].bank_balance + "." });
    await pool.query(`UPDATE ce_criminals SET bank_balance=bank_balance-$1 WHERE avatar_uuid=$2 AND community_org=$3`, [cost, avatar_uuid, community_org]);
    await pool.query(`UPDATE ce_city SET treasury=treasury+$1 WHERE community_org=$2`, [cost, community_org]);
    await pool.query(`UPDATE ce_structures SET hp=max_hp, status='operational', last_repaired=NOW() WHERE structure_code=$1`, [structure_code]);
    res.json({ success: true, repaired: missing, cost: cost, remaining_bank: o.rows[0].bank_balance - cost });
  } catch (err) {
    console.error("CE structure repair error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/ce/structure/status", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: "Missing code" });
  try {
    const r = await pool.query(`SELECT structure_name, hp, max_hp, status, damaged_by_name FROM ce_structures WHERE structure_code=$1`, [code]);
    if (r.rows.length === 0) return res.status(404).json({ error: "Not registered" });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ============================================================
// CRIMINAL EMPIRES — Crew System
// ============================================================

// Skim a cut of a payout into the members crew vault. Returns cut taken.
async function ceCrewCut(uuid, org, payout) {
  const m = await pool.query(
    `SELECT c.id, c.cut_pct FROM ce_crews c
     JOIN ce_crew_members cm ON cm.crew_id = c.id
     WHERE cm.avatar_uuid=$1 AND c.community_org=$2`, [uuid, org]);
  if (m.rows.length === 0) return 0;
  const cut = Math.floor(payout * (m.rows[0].cut_pct / 100));
  if (cut > 0) {
    await pool.query(`UPDATE ce_crews SET vault_balance=vault_balance+$1, total_earned=total_earned+$1 WHERE id=$2`, [cut, m.rows[0].id]);
  }
  return cut;
}

// Create a crew (safe prim registers it)
app.post("/ce/crew/create", async (req, res) => {
  const { safe_code, crew_name, leader_uuid, leader_name, community_org } = req.body;
  if (!safe_code || !leader_uuid || !community_org) return res.status(400).json({ error: "Missing fields" });
  try {
    const exists = await pool.query(`SELECT id, crew_name, leader_uuid FROM ce_crews WHERE safe_code=$1`, [safe_code]);
    if (exists.rows.length > 0) {
      return res.json({ success: true, crew_id: exists.rows[0].id, crew_name: exists.rows[0].crew_name, existing: true });
    }
    const already = await pool.query(
      `SELECT c.id FROM ce_crews c WHERE c.leader_uuid=$1 AND c.community_org=$2`, [leader_uuid, community_org]);
    if (already.rows.length > 0) return res.status(409).json({ error: "You already lead a crew." });

    const c = await pool.query(
      `INSERT INTO ce_crews (crew_name, community_org, leader_uuid, leader_name, safe_code)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [crew_name || "Unnamed Crew", community_org, leader_uuid, leader_name || "", safe_code]);
    const crewId = c.rows[0].id;
    await pool.query(
      `INSERT INTO ce_crew_members (crew_id, avatar_uuid, avatar_name, crew_rank)
       VALUES ($1,$2,$3,'Boss') ON CONFLICT DO NOTHING`,
      [crewId, leader_uuid, leader_name || ""]);
    await pool.query(`UPDATE ce_criminals SET crew_id=$1 WHERE avatar_uuid=$2 AND community_org=$3`, [crewId, leader_uuid, community_org]);
    res.json({ success: true, crew_id: crewId, crew_name: crew_name || "Unnamed Crew", created: true });
  } catch (err) {
    console.error("CE crew create error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Join a crew by touching its safe
app.post("/ce/crew/join", async (req, res) => {
  const { safe_code, avatar_uuid, avatar_name, community_org } = req.body;
  if (!safe_code || !avatar_uuid || !community_org) return res.status(400).json({ error: "Missing fields" });
  try {
    const c = await pool.query(`SELECT id, crew_name FROM ce_crews WHERE safe_code=$1`, [safe_code]);
    if (c.rows.length === 0) return res.status(404).json({ error: "No crew registered to this safe" });
    const crewId = c.rows[0].id;
    const dupe = await pool.query(`SELECT id FROM ce_crew_members WHERE avatar_uuid=$1`, [avatar_uuid]);
    if (dupe.rows.length > 0) return res.status(409).json({ error: "You are already in a crew. Leave it first." });
    await pool.query(
      `INSERT INTO ce_criminals (avatar_uuid, avatar_name, community_org)
       VALUES ($1,$2,$3) ON CONFLICT (avatar_uuid, community_org) DO UPDATE SET avatar_name=$2`,
      [avatar_uuid, avatar_name || "Recruit", community_org]);
    await pool.query(
      `INSERT INTO ce_crew_members (crew_id, avatar_uuid, avatar_name, crew_rank)
       VALUES ($1,$2,$3,'Soldier')`, [crewId, avatar_uuid, avatar_name || "Recruit"]);
    await pool.query(`UPDATE ce_criminals SET crew_id=$1 WHERE avatar_uuid=$2 AND community_org=$3`, [crewId, avatar_uuid, community_org]);
    res.json({ success: true, crew_name: c.rows[0].crew_name });
  } catch (err) {
    console.error("CE crew join error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Leave crew
app.post("/ce/crew/leave", async (req, res) => {
  const { avatar_uuid, community_org } = req.body;
  if (!avatar_uuid || !community_org) return res.status(400).json({ error: "Missing fields" });
  try {
    const m = await pool.query(
      `SELECT cm.crew_id, cm.crew_rank FROM ce_crew_members cm WHERE cm.avatar_uuid=$1`, [avatar_uuid]);
    if (m.rows.length === 0) return res.status(404).json({ error: "You are not in a crew" });
    if (m.rows[0].crew_rank === "Boss") return res.status(403).json({ error: "The boss cannot leave. Disband instead." });
    await pool.query(`DELETE FROM ce_crew_members WHERE avatar_uuid=$1`, [avatar_uuid]);
    await pool.query(`UPDATE ce_criminals SET crew_id=NULL WHERE avatar_uuid=$1 AND community_org=$2`, [avatar_uuid, community_org]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Crew status — vault, roster, tool stock
app.get("/ce/crew/status", async (req, res) => {
  const { safe_code, uuid } = req.query;
  try {
    let crew;
    if (safe_code) {
      crew = await pool.query(`SELECT * FROM ce_crews WHERE safe_code=$1`, [safe_code]);
    } else if (uuid) {
      crew = await pool.query(
        `SELECT c.* FROM ce_crews c JOIN ce_crew_members cm ON cm.crew_id=c.id WHERE cm.avatar_uuid=$1`, [uuid]);
    } else {
      return res.status(400).json({ error: "Need safe_code or uuid" });
    }
    if (crew.rows.length === 0) return res.status(404).json({ error: "No crew found" });
    const cr = crew.rows[0];
    const members = await pool.query(
      `SELECT avatar_name, crew_rank FROM ce_crew_members WHERE crew_id=$1 ORDER BY joined_at ASC`, [cr.id]);
    res.json({
      crew_name: cr.crew_name, crew_id: cr.id, leader_name: cr.leader_name,
      vault_balance: cr.vault_balance, cut_pct: cr.cut_pct, total_earned: cr.total_earned,
      member_count: members.rows.length,
      members: members.rows,
      tools: { gloves: cr.gloves_stock, mask: cr.mask_stock, lockpick: cr.lockpick_stock, hacker: cr.hacker_stock, jammer: cr.jammer_stock }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Deposit money into vault (from personal cash_on_hand)
app.post("/ce/crew/deposit", async (req, res) => {
  const { avatar_uuid, community_org, amount } = req.body;
  const amt = parseInt(amount);
  if (!avatar_uuid || !community_org || !amt || amt <= 0) return res.status(400).json({ error: "Invalid amount" });
  try {
    const m = await pool.query(`SELECT crew_id FROM ce_crew_members WHERE avatar_uuid=$1`, [avatar_uuid]);
    if (m.rows.length === 0) return res.status(404).json({ error: "You are not in a crew" });
    const r = await pool.query(
      `UPDATE ce_criminals SET cash_on_hand=cash_on_hand-$1 WHERE avatar_uuid=$2 AND community_org=$3 AND cash_on_hand>=$1 RETURNING cash_on_hand`,
      [amt, avatar_uuid, community_org]);
    if (r.rows.length === 0) return res.status(409).json({ error: "Not enough cash on hand" });
    await pool.query(`UPDATE ce_crews SET vault_balance=vault_balance+$1 WHERE id=$2`, [amt, m.rows[0].crew_id]);
    res.json({ success: true, deposited: amt, cash_on_hand: r.rows[0].cash_on_hand });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Withdraw money from vault (boss only)
app.post("/ce/crew/withdraw", async (req, res) => {
  const { avatar_uuid, community_org, amount } = req.body;
  const amt = parseInt(amount);
  if (!avatar_uuid || !community_org || !amt || amt <= 0) return res.status(400).json({ error: "Invalid amount" });
  try {
    const m = await pool.query(`SELECT crew_id, crew_rank FROM ce_crew_members WHERE avatar_uuid=$1`, [avatar_uuid]);
    if (m.rows.length === 0) return res.status(404).json({ error: "You are not in a crew" });
    if (m.rows[0].crew_rank !== "Boss") return res.status(403).json({ error: "Only the boss can withdraw from the vault" });
    const r = await pool.query(
      `UPDATE ce_crews SET vault_balance=vault_balance-$1 WHERE id=$2 AND vault_balance>=$1 RETURNING vault_balance`,
      [amt, m.rows[0].crew_id]);
    if (r.rows.length === 0) return res.status(409).json({ error: "Vault does not have that much" });
    await pool.query(`UPDATE ce_criminals SET cash_on_hand=cash_on_hand+$1 WHERE avatar_uuid=$2 AND community_org=$3`, [amt, avatar_uuid, community_org]);
    res.json({ success: true, withdrawn: amt, vault_balance: r.rows[0].vault_balance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Deposit tools into crew locker (from personal uses)
app.post("/ce/crew/tool/deposit", async (req, res) => {
  const { avatar_uuid, community_org, tool, qty } = req.body;
  const n = parseInt(qty) || 1;
  const valid = ["gloves","mask","lockpick","hacker","jammer"];
  if (!avatar_uuid || !community_org || valid.indexOf(tool) === -1) return res.status(400).json({ error: "Invalid request" });
  try {
    const m = await pool.query(`SELECT crew_id FROM ce_crew_members WHERE avatar_uuid=$1`, [avatar_uuid]);
    if (m.rows.length === 0) return res.status(404).json({ error: "You are not in a crew" });
    const col = tool + "_uses";
    const r = await pool.query(
      `UPDATE ce_criminals SET ${col}=${col}-$1 WHERE avatar_uuid=$2 AND community_org=$3 AND ${col}>=$1 RETURNING ${col}`,
      [n, avatar_uuid, community_org]);
    if (r.rows.length === 0) return res.status(409).json({ error: "You do not have that many " + tool });
    const scol = tool + "_stock";
    await pool.query(`UPDATE ce_crews SET ${scol}=${scol}+$1 WHERE id=$2`, [n, m.rows[0].crew_id]);
    res.json({ success: true, tool: tool, deposited: n });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Take tools from crew locker (any member)
app.post("/ce/crew/tool/take", async (req, res) => {
  const { avatar_uuid, community_org, tool, qty } = req.body;
  const n = parseInt(qty) || 1;
  const valid = ["gloves","mask","lockpick","hacker","jammer"];
  if (!avatar_uuid || !community_org || valid.indexOf(tool) === -1) return res.status(400).json({ error: "Invalid request" });
  try {
    const m = await pool.query(`SELECT crew_id FROM ce_crew_members WHERE avatar_uuid=$1`, [avatar_uuid]);
    if (m.rows.length === 0) return res.status(404).json({ error: "You are not in a crew" });
    const scol = tool + "_stock";
    const r = await pool.query(
      `UPDATE ce_crews SET ${scol}=${scol}-$1 WHERE id=$2 AND ${scol}>=$1 RETURNING ${scol}`,
      [n, m.rows[0].crew_id]);
    if (r.rows.length === 0) return res.status(409).json({ error: "The locker does not have that many " + tool });
    const col = tool + "_uses";
    await pool.query(`UPDATE ce_criminals SET ${col}=${col}+$1 WHERE avatar_uuid=$2 AND community_org=$3`, [n, avatar_uuid, community_org]);
    res.json({ success: true, tool: tool, taken: n });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set crew cut % (boss only)
app.post("/ce/crew/setcut", async (req, res) => {
  const { avatar_uuid, cut_pct } = req.body;
  const pct = parseInt(cut_pct);
  if (!avatar_uuid || isNaN(pct) || pct < 0 || pct > 50) return res.status(400).json({ error: "Cut must be 0-50%" });
  try {
    const m = await pool.query(`SELECT crew_id, crew_rank FROM ce_crew_members WHERE avatar_uuid=$1`, [avatar_uuid]);
    if (m.rows.length === 0 || m.rows[0].crew_rank !== "Boss") return res.status(403).json({ error: "Only the boss sets the cut" });
    await pool.query(`UPDATE ce_crews SET cut_pct=$1 WHERE id=$2`, [pct, m.rows[0].crew_id]);
    res.json({ success: true, cut_pct: pct });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ============================================================
// CRIMINAL EMPIRES — Crime Scene Investigation (PD)
// ============================================================

// List open scenes for the community (PD HUD board)
app.get("/ce/scene/open", async (req, res) => {
  const { org } = req.query;
  if (!org) return res.status(400).json({ error: "Missing org" });
  try {
    const r = await pool.query(
      `SELECT id, business_name, region, amount_taken, occurred_at FROM ce_crime_scenes
       WHERE community_org=$1 AND status='open' ORDER BY occurred_at DESC LIMIT 20`, [org]);
    res.json({ scenes: r.rows, count: r.rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Investigate — PD role only. Returns leads based on what the thief left.
app.post("/ce/scene/investigate", async (req, res) => {
  const { register_code, scene_id, officer_uuid, officer_name, community_org } = req.body;
  if ((!register_code && !scene_id) || !officer_uuid || !community_org) return res.status(400).json({ error: "Missing fields" });
  try {
    const off = await pool.query(`SELECT role FROM ce_criminals WHERE avatar_uuid=$1 AND community_org=$2`, [officer_uuid, community_org]);
    if (off.rows.length === 0 || off.rows[0].role !== "Cop") {
      return res.status(403).json({ error: "Only PD officers can investigate crime scenes." });
    }
    let scene;
    if (scene_id) {
      scene = await pool.query(`SELECT * FROM ce_crime_scenes WHERE id=$1 AND status='open'`, [parseInt(scene_id)]);
    } else {
      scene = await pool.query(`SELECT * FROM ce_crime_scenes WHERE register_code=$1 AND status='open' ORDER BY occurred_at DESC LIMIT 1`, [register_code]);
    }
    if (scene.rows.length === 0) return res.status(404).json({ error: "No open crime scene here." });
    const sc = scene.rows[0];
    await pool.query(`UPDATE ce_crime_scenes SET investigated_by=$1 WHERE id=$2`, [officer_name || "Officer", sc.id]);

    let lead = "";
    let suspect = "";
    if (sc.prints_left) {
      suspect = sc.suspect_name;
      lead = "Fingerprints recovered. Suspect identified: " + sc.suspect_name;
    } else if (sc.name_known) {
      suspect = sc.suspect_name;
      lead = "Witnesses ID the suspect: " + sc.suspect_name;
    } else {
      lead = "No prints, no witnesses. This was a professional job — no solid leads.";
    }
    res.json({
      success: true, scene_id: sc.id, business_name: sc.business_name,
      amount_taken: sc.amount_taken, prints_left: sc.prints_left, name_known: sc.name_known,
      alarm_sounded: sc.alarm_sounded, lead: lead, suspect: suspect, occurred_at: sc.occurred_at
    });
  } catch (err) {
    console.error("CE investigate error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Clear a scene — PD role only. Closes the case.
app.post("/ce/scene/clear", async (req, res) => {
  const { scene_id, register_code, officer_uuid, officer_name, community_org } = req.body;
  if ((!scene_id && !register_code) || !officer_uuid || !community_org) return res.status(400).json({ error: "Missing fields" });
  try {
    const off = await pool.query(`SELECT role FROM ce_criminals WHERE avatar_uuid=$1 AND community_org=$2`, [officer_uuid, community_org]);
    if (off.rows.length === 0 || off.rows[0].role !== "Cop") {
      return res.status(403).json({ error: "Only PD officers can clear scenes." });
    }
    let q;
    if (scene_id) {
      q = await pool.query(`UPDATE ce_crime_scenes SET status='cleared', cleared_by=$1, cleared_at=NOW() WHERE id=$2 AND status='open' RETURNING business_name`, [officer_name || "Officer", parseInt(scene_id)]);
    } else {
      q = await pool.query(`UPDATE ce_crime_scenes SET status='cleared', cleared_by=$1, cleared_at=NOW() WHERE register_code=$2 AND status='open' RETURNING business_name`, [officer_name || "Officer", register_code]);
    }
    if (q.rows.length === 0) return res.status(404).json({ error: "No open scene to clear." });
    res.json({ success: true, cleared: q.rows[0].business_name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ============================================================
// CRIMINAL EMPIRES — Player Transfers
// ============================================================
app.post("/ce/pay", async (req, res) => {
  const { from_uuid, to_uuid, to_name, community_org, amount } = req.body;
  const amt = parseInt(amount);
  if (!from_uuid || !to_uuid || !community_org || !amt || amt <= 0) return res.status(400).json({ error: "Invalid transfer" });
  if (from_uuid === to_uuid) return res.status(400).json({ error: "You cannot pay yourself" });
  try {
    // Make sure recipient exists in this org
    await pool.query(
      `INSERT INTO ce_criminals (avatar_uuid, avatar_name, community_org)
       VALUES ($1,$2,$3) ON CONFLICT (avatar_uuid, community_org) DO UPDATE SET avatar_name=COALESCE(EXCLUDED.avatar_name, ce_criminals.avatar_name)`,
      [to_uuid, to_name || "Recipient", community_org]
    );
    // Deduct from sender cash_on_hand only if they have it
    const d = await pool.query(
      `UPDATE ce_criminals SET cash_on_hand=cash_on_hand-$1 WHERE avatar_uuid=$2 AND community_org=$3 AND cash_on_hand>=$1 RETURNING cash_on_hand`,
      [amt, from_uuid, community_org]
    );
    if (d.rows.length === 0) return res.status(409).json({ error: "Not enough cash on hand" });
    const r = await pool.query(
      `UPDATE ce_criminals SET cash_on_hand=cash_on_hand+$1 WHERE avatar_uuid=$2 AND community_org=$3 RETURNING cash_on_hand`,
      [amt, to_uuid, community_org]
    );
    res.json({ success: true, sent: amt, from_balance: d.rows[0].cash_on_hand, to_balance: r.rows[0].cash_on_hand });
  } catch (err) {
    console.error("CE pay error:", err);
    res.status(500).json({ error: err.message });
  }
});


// ============================================================
// CRIMINAL EMPIRES — Player Path (Criminal / Civilian)
// ============================================================
app.post("/ce/path/set", async (req, res) => {
  const { avatar_uuid, avatar_name, community_org, path } = req.body;
  const valid = ["criminal", "civilian"];
  if (!avatar_uuid || !community_org || valid.indexOf(path) === -1) return res.status(400).json({ error: "Invalid path" });
  try {
    await pool.query(
      `INSERT INTO ce_criminals (avatar_uuid, avatar_name, community_org, player_type, path_chosen)
       VALUES ($1,$2,$3,$4,TRUE)
       ON CONFLICT (avatar_uuid, community_org) DO UPDATE SET player_type=$4, path_chosen=TRUE, avatar_name=COALESCE(EXCLUDED.avatar_name, ce_criminals.avatar_name), last_active=NOW()`,
      [avatar_uuid, avatar_name || "Player", community_org, path]
    );
    res.json({ success: true, path: path });
  } catch (err) {
    console.error("CE path set error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/ce/path/get", async (req, res) => {
  const { uuid, org } = req.query;
  if (!uuid || !org) return res.status(400).json({ error: "Missing uuid or org" });
  try {
    const r = await pool.query(`SELECT player_type, path_chosen FROM ce_criminals WHERE avatar_uuid=$1 AND community_org=$2`, [uuid, org]);
    if (r.rows.length === 0) return res.json({ path: "", chosen: false });
    res.json({ path: r.rows[0].player_type || "", chosen: r.rows[0].path_chosen === true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ============================================================
// CRIMINAL EMPIRES — HUD Screen Renderer (thin-client)
// Returns ready-to-paint ASCII for each app screen.
// ============================================================
function ceComma(n) {
  n = parseInt(n) || 0;
  let str = String(n);
  let out = "";
  let count = 0;
  for (let i = str.length - 1; i >= 0; i--) {
    out = str[i] + out;
    count++;
    if (count % 3 === 0 && i !== 0) out = "," + out;
  }
  return out;
}
function ceRankName(level) {
  const ranks = ["Street Rat","Petty Thief","Hustler","Runner","Enforcer","Racketeer","Capo","Underboss","Boss","Kingpin"];
  let idx = Math.floor(((parseInt(level)||1) - 1) / 10);
  if (idx < 0) idx = 0; if (idx > 9) idx = 9;
  return ranks[idx];
}

app.get("/ce/hud/screen", async (req, res) => {
  const { app: appName, uuid, org } = req.query;
  if (!appName || !uuid || !org) return res.status(400).json({ error: "Missing app, uuid, or org" });
  try {
    const cr = await pool.query(
      `SELECT avatar_name, heat_level, total_steals, total_fenced, total_earnings, bank_balance, cash_on_hand, xp, level, role, player_type, gloves_uses, mask_uses, lockpick_uses, hacker_uses, jammer_uses FROM ce_criminals WHERE avatar_uuid=$1 AND community_org=$2`,
      [uuid, org]
    );
    const c = cr.rows[0] || {};
    const CUR = "\u20a1";
    const TOP = "\u259b\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u259c";
    const BOT = "\u2599\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u259f";
    const D = TOP;
    let text = "";

    if (appName === "bank") {
      text = D + "\n\n"
           + "   " + CUR + " " + ceComma(c.bank_balance) + "\n"
           + "   TOTAL BALANCE\n\n"
           + "   CASH   " + CUR + ceComma(c.cash_on_hand) + "\n"
           + "   EARN   " + CUR + ceComma(c.total_earnings) + "\n\n"
           + BOT;
    }
    else if (appName === "profile") {
      const lvl = parseInt(c.level) || 1;
      const nextXp = (lvl + 1) * (lvl + 1) * 25;
      text = D + "\n\n"
           + "   " + (c.avatar_name || "Unknown") + "\n"
           + "   [ " + ceRankName(lvl) + " ]\n\n"
           + "   LVL   " + lvl + " / 100\n"
           + "   XP    " + ceComma(c.xp) + " / " + ceComma(nextXp) + "\n\n"
           + "   STEALS " + (c.total_steals||0) + "   FENCED " + (c.total_fenced||0) + "\n"
           + "   HEAT   " + (c.heat_level||0) + " / 10\n\n"
           + BOT;
    }
    else if (appName === "stash") {
      const items = await pool.query(
        `SELECT item_name, base_value FROM ce_items WHERE stolen_by_uuid=$1 AND community_org=$2 AND status='stolen' ORDER BY stolen_at DESC LIMIT 8`,
        [uuid, org]
      );
      text = D + "\n\n";
      if (items.rows.length === 0) {
        text += "   Empty.\n   Go steal something.\n\n";
      } else {
        for (let i = 0; i < items.rows.length; i++) {
          let nm = items.rows[i].item_name || "Item";
          if (nm.length > 14) nm = nm.substring(0, 14);
          text += "   " + nm + "   " + CUR + ceComma(items.rows[i].base_value) + "\n";
        }
        text += "\n";
      }
      text += D;
    }
    else if (appName === "accessories") {
      text = D + "\n\n"
           + "   GLOVES     " + (c.gloves_uses||0) + "\n"
           + "   MASK       " + (c.mask_uses||0) + "\n"
           + "   LOCKPICK   " + (c.lockpick_uses||0) + "\n"
           + "   HACKER     " + (c.hacker_uses||0) + "\n"
           + "   JAMMER     " + (c.jammer_uses||0) + "\n\n"
           + "   Auto-used on crimes\n\n"
           + BOT;
    }
    else if (appName === "crew") {
      const crew = await pool.query(
        `SELECT cw.crew_name, cw.vault_balance, cw.cut_pct,
                (SELECT COUNT(*) FROM ce_crew_members WHERE crew_id=cw.id) AS members
         FROM ce_crews cw JOIN ce_crew_members cm ON cm.crew_id=cw.id
         WHERE cm.avatar_uuid=$1`, [uuid]
      );
      if (crew.rows.length === 0) {
        text = D + "\n\n   You are not in a crew.\n   Touch a Crew Safe\n   to join.\n\n" + BOT;
      } else {
        const cw = crew.rows[0];
        text = D + "\n\n"
             + "   " + cw.crew_name + "\n\n"
             + "   VAULT   " + CUR + ceComma(cw.vault_balance) + "\n"
             + "   CUT     " + cw.cut_pct + "%\n"
             + "   CREW    " + cw.members + " members\n\n"
             + BOT;
      }
    }
    else if (appName === "business") {
      text = D + "\n\n   EMPIRE CONTROLS\n   Coming soon.\n\n   Fronts, pillars,\n   and rackets.\n\n" + BOT;
    }
    else if (appName === "territory") {
      text = D + "\n\n   TURF CONTROL\n   Coming soon.\n\n   Claim and defend\n   your zones.\n\n" + BOT;
    }
    else if (appName === "wallet") {
      text = D + "\n\n"
           + "   " + CUR + " " + ceComma(c.bank_balance) + "\n"
           + "   BALANCE\n\n"
           + "   CASH   " + CUR + ceComma(c.cash_on_hand) + "\n\n"
           + D;
    }
    else if (appName === "jobs") {
      let jt = D + "\n\n   YOUR CAREERS\n\n";
      let any = false;
      if (c.is_business_owner) { jt += "   Business Owner  ON\n"; any = true; }
      if (c.is_homeowner)      { jt += "   Homeowner       ON\n"; any = true; }
      if (c.is_police)         { jt += "   Police          ON\n"; any = true; }
      if (c.is_doctor)         { jt += "   Doctor          ON\n"; any = true; }
      if (c.is_mechanic)       { jt += "   Mechanic         ON\n"; any = true; }
      if (!any) jt += "   No professions yet.\n";
      jt += "\n   Own a shop, house,\n   or get certified\n   to unlock apps.\n\n" + D;
      text = jt;
    }
    else if (appName === "police") {
      const scenes = await pool.query(
        `SELECT COUNT(*) AS open FROM ce_crime_scenes WHERE community_org=$1 AND status='open'`, [org]);
      const openCount = scenes.rows[0] ? scenes.rows[0].open : 0;
      text = D + "\n\n   POLICE\n\n   Open cases: " + openCount + "\n\n   Touch a robbed\n   register to\n   investigate.\n\n" + D;
    }
    else if (appName === "doctor") {
      text = D + "\n\n   DOCTOR\n\n   Med XP: " + ceComma(c.doctor_xp) + "\n\n   Scan nearby to\n   heal the injured.\n\n" + D;
    }
    else if (appName === "mechanic") {
      text = D + "\n\n   MECHANIC\n\n   Repair XP: " + ceComma(c.mechanic_xp) + "\n\n   Scan nearby for\n   damaged buildings\n   to repair.\n\n" + D;
    }
    else if (appName === "civbusiness") {
      text = D + "\n\n   BUSINESS\n\n   Manage your shops,\n   collect earnings.\n\n   Use your register\n   in-world.\n\n" + D;
    }
    else if (appName === "pay") {
      text = D + "\n\n   CASH   " + CUR + ceComma(c.cash_on_hand) + "\n\n   Scan nearby, pick\n   a person, pick\n   an amount.\n\n" + BOT;
    }
    else {
      text = "Unknown screen.";
    }

    res.json({ success: true, app: appName, text: text, heat: c.heat_level || 0, player_type: c.player_type || "" });
  } catch (err) {
    console.error("CE hud screen error:", err);
    res.status(500).json({ error: err.message });
  }
});


// ============================================================
// CRIMINAL EMPIRES — Professions (civilian)
// ============================================================
app.get("/ce/professions/get", async (req, res) => {
  const { uuid, org } = req.query;
  if (!uuid || !org) return res.status(400).json({ error: "Missing uuid or org" });
  try {
    const r = await pool.query(
      `SELECT is_business_owner, is_homeowner, is_police, is_doctor, is_mechanic, player_type, path_locked FROM ce_criminals WHERE avatar_uuid=$1 AND community_org=$2`,
      [uuid, org]);
    if (r.rows.length === 0) return res.json({ professions: [], player_type: "", locked: false });
    const c = r.rows[0];
    let profs = [];
    if (c.is_business_owner) profs.push("business");
    if (c.is_homeowner) profs.push("homeowner");
    if (c.is_police) profs.push("police");
    if (c.is_doctor) profs.push("doctor");
    if (c.is_mechanic) profs.push("mechanic");
    res.json({ professions: profs, player_type: c.player_type || "", locked: c.path_locked === true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Grant a profession (called when a player qualifies)
app.post("/ce/professions/grant", async (req, res) => {
  const { avatar_uuid, community_org, profession } = req.body;
  const cols = { business: "is_business_owner", homeowner: "is_homeowner", police: "is_police", doctor: "is_doctor", mechanic: "is_mechanic" };
  if (!avatar_uuid || !community_org || !cols[profession]) return res.status(400).json({ error: "Invalid profession" });
  try {
    await pool.query(`UPDATE ce_criminals SET ${cols[profession]}=TRUE WHERE avatar_uuid=$1 AND community_org=$2`, [avatar_uuid, community_org]);
    res.json({ success: true, profession: profession });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// CRIMINAL EMPIRES — JOBS SYSTEM (station-gated, HUD-driven)
// ============================================================
app.post("/ce/job/station/register", async (req, res) => {
  const { station_code, job_type, mode, community_org, owner_uuid, owner_name, region, pos_x, pos_y, pos_z } = req.body;
  const types = ["police", "doctor", "mechanic"];
  if (!station_code || !community_org || types.indexOf(job_type) === -1) return res.status(400).json({ error: "Invalid station params" });
  const m = (mode === "stationed") ? "stationed" : "patrol";
  try {
    await pool.query(
      `INSERT INTO ce_job_stations (station_code, job_type, mode, community_org, owner_uuid, owner_name, region, pos_x, pos_y, pos_z, last_seen)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
       ON CONFLICT (station_code) DO UPDATE SET job_type=$2, mode=$3, community_org=$4, owner_uuid=$5, owner_name=$6, region=$7, pos_x=$8, pos_y=$9, pos_z=$10, last_seen=NOW()`,
      [station_code, job_type, m, community_org, owner_uuid || null, owner_name || null, region || null, pos_x || null, pos_y || null, pos_z || null]
    );
    res.json({ success: true, station_code: station_code, job_type: job_type, mode: m });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/ce/job/onduty", async (req, res) => {
  const { avatar_uuid, avatar_name, community_org, job_type, station_code } = req.body;
  const flagCol = { police: "is_police", doctor: "is_doctor", mechanic: "is_mechanic" };
  if (!avatar_uuid || !community_org || !flagCol[job_type]) return res.status(400).json({ error: "Invalid job params" });
  try {
    const pr = await pool.query(
      `SELECT ${flagCol[job_type]} AS ok FROM ce_criminals WHERE avatar_uuid=$1 AND community_org=$2`,
      [avatar_uuid, community_org]);
    if (pr.rows.length === 0 || pr.rows[0].ok !== true) return res.status(403).json({ error: "You are not certified for this job." });
    const ex = await pool.query(
      `SELECT id, xp_earned FROM ce_job_shifts WHERE avatar_uuid=$1 AND community_org=$2 AND status=$3`,
      [avatar_uuid, community_org, "active"]);
    if (ex.rows.length > 0) return res.json({ success: true, already: true, shift_id: ex.rows[0].id, job_type: job_type });
    const ins = await pool.query(
      `INSERT INTO ce_job_shifts (avatar_uuid, avatar_name, community_org, job_type, station_code, status, last_tick)
       VALUES ($1,$2,$3,$4,$5,$6,NOW()) RETURNING id`,
      [avatar_uuid, avatar_name || null, community_org, job_type, station_code || null, "active"]);
    res.json({ success: true, shift_id: ins.rows[0].id, job_type: job_type });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/ce/job/offduty", async (req, res) => {
  const { avatar_uuid, community_org } = req.body;
  if (!avatar_uuid || !community_org) return res.status(400).json({ error: "Missing uuid or org" });
  try {
    const r = await pool.query(
      `UPDATE ce_job_shifts SET status=$3, ended_at=NOW() WHERE avatar_uuid=$1 AND community_org=$2 AND status=$4 RETURNING job_type, xp_earned`,
      [avatar_uuid, community_org, "ended", "active"]);
    if (r.rows.length === 0) return res.json({ success: true, on_duty: false, xp_earned: 0 });
    res.json({ success: true, off: true, job_type: r.rows[0].job_type, xp_earned: r.rows[0].xp_earned });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/ce/job/earn", async (req, res) => {
  const { avatar_uuid, community_org } = req.body;
  const xpCol = { police: "police_xp", doctor: "doctor_xp", mechanic: "mechanic_xp" };
  const JOB_XP = 10;
  const MIN_SECS = 590;
  if (!avatar_uuid || !community_org) return res.status(400).json({ error: "Missing uuid or org" });
  try {
    const sh = await pool.query(
      `SELECT id, job_type, EXTRACT(EPOCH FROM (NOW() - last_tick)) AS since FROM ce_job_shifts WHERE avatar_uuid=$1 AND community_org=$2 AND status=$3`,
      [avatar_uuid, community_org, "active"]);
    if (sh.rows.length === 0) return res.json({ success: true, on_duty: false, awarded: 0 });
    const shift = sh.rows[0];
    if (parseFloat(shift.since) < MIN_SECS) return res.json({ success: true, on_duty: true, awarded: 0, throttled: true, since: Math.floor(shift.since), job_type: shift.job_type });
    const col = xpCol[shift.job_type];
    if (!col) return res.status(400).json({ error: "Bad job type on shift" });
    await pool.query(`UPDATE ce_job_shifts SET xp_earned = xp_earned + $2, last_tick = NOW() WHERE id=$1`, [shift.id, JOB_XP]);
    const up = await pool.query(
      `UPDATE ce_criminals SET ${col} = COALESCE(${col},0) + $3 WHERE avatar_uuid=$1 AND community_org=$2 RETURNING ${col} AS total`,
      [avatar_uuid, community_org, JOB_XP]);
    const total = up.rows.length ? up.rows[0].total : 0;
    res.json({ success: true, on_duty: true, awarded: JOB_XP, total_xp: total, job_type: shift.job_type });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/ce/job/status", async (req, res) => {
  const { uuid, org } = req.query;
  if (!uuid || !org) return res.status(400).json({ error: "Missing uuid or org" });
  try {
    const r = await pool.query(
      `SELECT job_type, station_code, xp_earned, started_at FROM ce_job_shifts WHERE avatar_uuid=$1 AND community_org=$2 AND status=$3`,
      [uuid, org, "active"]);
    if (r.rows.length === 0) return res.json({ on_duty: false });
    res.json({ on_duty: true, job_type: r.rows[0].job_type, station_code: r.rows[0].station_code, xp_earned: r.rows[0].xp_earned, started_at: r.rows[0].started_at });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ============================================================
// CRIMINAL EMPIRES — Job certification (touch a station to join)
// ============================================================
app.post("/ce/job/certify", async (req, res) => {
  const { avatar_uuid, avatar_name, community_org, job_type } = req.body;
  const flagCol = { police: "is_police", doctor: "is_doctor", mechanic: "is_mechanic" };
  if (!avatar_uuid || !community_org || !flagCol[job_type]) return res.status(400).json({ error: "Invalid certify params" });
  try {
    const r = await pool.query(
      `SELECT player_type, ${flagCol[job_type]} AS has FROM ce_criminals WHERE avatar_uuid=$1 AND community_org=$2`,
      [avatar_uuid, community_org]);
    if (r.rows.length === 0 || !r.rows[0].player_type || r.rows[0].player_type === "") {
      return res.json({ status: "no_path" });
    }
    if (r.rows[0].player_type === "criminal") {
      return res.json({ status: "criminal_blocked" });
    }
    if (r.rows[0].has === true) {
      return res.json({ status: "already", profession: job_type });
    }
    await pool.query(`UPDATE ce_criminals SET ${flagCol[job_type]}=TRUE WHERE avatar_uuid=$1 AND community_org=$2`, [avatar_uuid, community_org]);
    res.json({ status: "granted", profession: job_type });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ============================================================
// CRIMINAL EMPIRES — BUILDING TIERS + AUTO-UPGRADE
// ============================================================
var CE_TIERS = {
  1: { name: "Shop",      max_hp: 100, max_balance: 500,   fill_rate: 25 },
  2: { name: "Warehouse", max_hp: 250, max_balance: 2500,  fill_rate: 60 },
  3: { name: "Hideout",   max_hp: 400, max_balance: 7500,  fill_rate: 130 },
  4: { name: "HQ",        max_hp: 600, max_balance: 20000, fill_rate: 250 }
};
var CE_GATES = {
  2: { level: 21, bank: 25000 },
  3: { level: 51, bank: 100000 },
  4: { level: 81, bank: 500000 }
};

app.get("/ce/building/status", async (req, res) => {
  const { code, org } = req.query;
  if (!code || !org) return res.status(400).json({ error: "Missing code or org" });
  try {
    const q = await pool.query(
      `SELECT r.tier, r.balance, r.max_balance, r.fill_rate, r.owner_uuid, r.business_name, r.structure_code,
              s.hp, s.max_hp, s.status
       FROM ce_registers r
       LEFT JOIN ce_structures s ON r.structure_code = s.structure_code
       WHERE r.register_code=$1 AND r.community_org=$2`,
      [code, org]);
    if (q.rows.length === 0) return res.status(404).json({ error: "Register not found" });
    const r = q.rows[0];
    let curTier = r.tier || 1;
    if (!CE_TIERS[curTier]) curTier = 1;
    let next = null;
    if (curTier < 4) {
      const g = CE_GATES[curTier + 1];
      next = { tier: curTier + 1, name: CE_TIERS[curTier + 1].name, need_level: g.level, need_bank: g.bank };
    }
    res.json({
      business_name: r.business_name, tier: curTier, tier_name: CE_TIERS[curTier].name,
      hp: r.hp, max_hp: r.max_hp, status: r.status,
      balance: r.balance, max_balance: r.max_balance, fill_rate: r.fill_rate, next: next
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/ce/building/upgrade", async (req, res) => {
  const { register_code, community_org } = req.body;
  if (!register_code || !community_org) return res.status(400).json({ error: "Missing register_code or org" });
  try {
    const reg = await pool.query(
      `SELECT tier, owner_uuid, structure_code, business_name FROM ce_registers WHERE register_code=$1 AND community_org=$2`,
      [register_code, community_org]);
    if (reg.rows.length === 0) return res.status(404).json({ error: "Register not found" });
    const r = reg.rows[0];
    let curTier = r.tier || 1;
    if (!CE_TIERS[curTier]) curTier = 1;
    if (curTier >= 4) return res.json({ upgraded: false, maxed: true, tier: 4, tier_name: "HQ" });
    const nextTier = curTier + 1;
    const gate = CE_GATES[nextTier];
    const own = await pool.query(
      `SELECT level, bank_balance FROM ce_criminals WHERE avatar_uuid=$1 AND community_org=$2`,
      [r.owner_uuid, community_org]);
    if (own.rows.length === 0) return res.status(404).json({ error: "Owner not found" });
    const lvl = own.rows[0].level || 1;
    const bank = own.rows[0].bank_balance || 0;
    if (lvl < gate.level || bank < gate.bank) {
      return res.json({
        upgraded: false, tier: curTier, tier_name: CE_TIERS[curTier].name,
        next_tier: nextTier, next_name: CE_TIERS[nextTier].name,
        need_level: gate.level, have_level: lvl, need_bank: gate.bank, have_bank: bank
      });
    }
    const t = CE_TIERS[nextTier];
    await pool.query(
      `UPDATE ce_registers SET tier=$2, max_balance=$3, fill_rate=$4 WHERE register_code=$1`,
      [register_code, nextTier, t.max_balance, t.fill_rate]);
    if (r.structure_code) {
      await pool.query(
        `UPDATE ce_structures SET tier=$2, hp=LEAST(hp + ($3 - max_hp), $3), max_hp=$3 WHERE structure_code=$1`,
        [r.structure_code, nextTier, t.max_hp]);
    }
    res.json({ upgraded: true, tier: nextTier, tier_name: t.name, max_hp: t.max_hp, max_balance: t.max_balance, fill_rate: t.fill_rate });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ============================================================
// CRIMINAL EMPIRES — DAMAGE LAYER
// ============================================================
// Eligibility: owner must have >= CE_DAMAGE_MIN_BANK to be targetable (anti-grief)
var CE_DAMAGE_MIN_BANK = 20000;

app.post("/ce/building/damage", async (req, res) => {
  const { register_code, community_org, attacker_uuid, attacker_name, amount } = req.body;
  if (!register_code || !community_org) return res.status(400).json({ error: "Missing register_code or org" });
  let hit = parseInt(amount, 10);
  if (isNaN(hit) || hit <= 0) hit = 5 + Math.floor(Math.random() * 11); // 5-15
  try {
    const reg = await pool.query(
      `SELECT tier, owner_uuid, owner_name, business_name, structure_code, region, balance FROM ce_registers WHERE register_code=$1 AND community_org=$2`,
      [register_code, community_org]);
    if (reg.rows.length === 0) return res.status(404).json({ error: "Register not found" });
    const r = reg.rows[0];
    let curTier = r.tier || 1;
    if (!CE_TIERS[curTier]) curTier = 1;

    // Owner eligibility (anti-grief): must have capital to lose
    const own = await pool.query(
      `SELECT bank_balance FROM ce_criminals WHERE avatar_uuid=$1 AND community_org=$2`,
      [r.owner_uuid, community_org]);
    const ownerBank = (own.rows.length > 0 && own.rows[0].bank_balance) ? own.rows[0].bank_balance : 0;
    if (ownerBank < CE_DAMAGE_MIN_BANK) {
      return res.json({ damaged: false, protected: true, reason: "Owner has too little to lose. Not targetable yet." });
    }

    // Lazy-init structure if the register never had one
    let scode = r.structure_code;
    const maxhp = CE_TIERS[curTier].max_hp;
    if (!scode || scode === "") {
      scode = register_code; // reuse the register code as the structure key
      await pool.query(
        `INSERT INTO ce_structures (structure_code, structure_name, structure_type, owner_uuid, owner_name, community_org, region, hp, max_hp, tier, status)
         VALUES ($1,$2,'business',$3,$4,$5,$6,$7,$7,$8,'operational')
         ON CONFLICT (structure_code) DO NOTHING`,
        [scode, r.business_name, r.owner_uuid, r.owner_name, community_org, r.region, maxhp, curTier]);
      await pool.query(`UPDATE ce_registers SET structure_code=$1 WHERE register_code=$2`, [scode, register_code]);
    }

    // Apply damage
    const upd = await pool.query(
      `UPDATE ce_structures
       SET hp = GREATEST(hp - $2, 0),
           damaged_by_uuid = $3, damaged_by_name = $4, last_damaged = NOW(),
           status = CASE WHEN GREATEST(hp - $2, 0) = 0 THEN 'destroyed' ELSE 'operational' END
       WHERE structure_code = $1
       RETURNING hp, max_hp`,
      [scode, hit, attacker_uuid || null, attacker_name || null]);
    if (upd.rows.length === 0) return res.status(500).json({ error: "Structure update failed" });
    const hp = upd.rows[0].hp;

    // Tier effects: burn money based on HP band
    let tillBurn = 0;
    let bankBurn = 0;
    let band = "healthy";
    const pct = (hp / maxhp) * 100;
    if (hp === 0) {
      band = "destroyed";
      tillBurn = Math.floor(r.balance * 0.20);
      bankBurn = Math.floor(ownerBank * 0.05);
    } else if (pct < 30) {
      band = "critical";
      tillBurn = Math.floor(r.balance * 0.15);
      bankBurn = Math.floor(ownerBank * 0.03);
    } else if (pct < 70) {
      band = "damaged";
      tillBurn = Math.floor(r.balance * 0.10);
      bankBurn = Math.floor(ownerBank * 0.01);
    } else {
      band = "healthy";
      bankBurn = Math.floor(ownerBank * 0.005);
    }
    if (tillBurn > 0) {
      await pool.query(`UPDATE ce_registers SET balance = GREATEST(balance - $2, 0) WHERE register_code=$1`, [register_code, tillBurn]);
    }
    if (bankBurn > 0) {
      await pool.query(`UPDATE ce_criminals SET bank_balance = GREATEST(bank_balance - $3, 0) WHERE avatar_uuid=$1 AND community_org=$2`, [r.owner_uuid, community_org, bankBurn]);
    }

    // --- SIEGE ATTRIBUTION ---
    let attackerCrew = null;
    if (attacker_uuid && attacker_uuid !== "fire" && attacker_uuid !== "smoke") {
      try {
        let ac = await pool.query("SELECT crew_id FROM ce_crew_members WHERE avatar_uuid=$1 LIMIT 1", [attacker_uuid]);
        if (ac.rows.length === 0 || !ac.rows[0].crew_id) { ac = await pool.query("SELECT id AS crew_id FROM ce_crews WHERE leader_uuid=$1 AND community_org=$2 LIMIT 1", [attacker_uuid, community_org]); }
        if (ac.rows.length > 0) attackerCrew = ac.rows[0].crew_id;
        if (!attackerCrew) { const al = await pool.query("SELECT id FROM ce_crews WHERE leader_uuid=$1 AND community_org=$2 LIMIT 1", [attacker_uuid, community_org]); if (al.rows.length > 0) attackerCrew = al.rows[0].id; }
      } catch (e) {}
    }
    try {
      await pool.query("INSERT INTO ce_building_damage_log (structure_code, register_code, community_org, attacker_uuid, attacker_crew_id, damage) VALUES ($1,$2,$3,$4,$5,$6)", [scode, register_code, community_org, attacker_uuid || null, attackerCrew, hit]);
      await pool.query("UPDATE ce_sieges SET last_attacker_seen=NOW(), hit_zero_at = CASE WHEN $2 = 0 AND hit_zero_at IS NULL THEN NOW() ELSE hit_zero_at END, forfeiture_deadline = CASE WHEN $2 = 0 AND forfeiture_deadline IS NULL THEN NOW() + INTERVAL $3 ELSE forfeiture_deadline END WHERE register_code=$1 AND status=$4", [register_code, hp, "3 days", "active"]);
    } catch (e) {}
    res.json({
      damaged: true, hp: hp, max_hp: maxhp, band: band,
      dealt: hit, till_lost: tillBurn, bank_lost: bankBurn,
      business_name: r.business_name
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ============================================================
// CRIMINAL EMPIRES — RECOVERY + MECHANIC REPAIR
// ============================================================
// ============================================================
// CE REPAIR v2 — mechanic sets it off, cron heals over time
// ============================================================
function ceRepairRate(mxp) {
  if (mxp >= 5000) return 25;   // master — ~destroyed to full in ~20 min (5min ticks)
  if (mxp >= 2000) return 15;
  if (mxp >= 500)  return 8;
  if (mxp >= 100)  return 5;
  return 3;                      // novice — slow
}

app.post("/ce/building/repair", async (req, res) => {
  const { register_code, community_org, mechanic_uuid, mechanic_name } = req.body;
  if (!register_code || !community_org || !mechanic_uuid) return res.status(400).json({ error: "Missing register_code, org, or mechanic_uuid" });
  try {
    const mech = await pool.query(
      `SELECT is_mechanic, mechanic_xp FROM ce_criminals WHERE avatar_uuid=$1 AND community_org=$2`,
      [mechanic_uuid, community_org]);
    if (mech.rows.length === 0 || mech.rows[0].is_mechanic !== true) {
      return res.status(403).json({ error: "You are not a certified Mechanic." });
    }
    const mxp = mech.rows[0].mechanic_xp || 0;
    const rate = ceRepairRate(mxp);

    const reg = await pool.query(
      `SELECT owner_uuid, business_name, structure_code FROM ce_registers WHERE register_code=$1 AND community_org=$2`,
      [register_code, community_org]);
    if (reg.rows.length === 0) return res.status(404).json({ error: "Register not found" });
    const r = reg.rows[0];
    if (!r.structure_code) return res.json({ repaired: false, reason: "This building has no damage on record." });

    const st = await pool.query(`SELECT hp, max_hp, repairing_by FROM ce_structures WHERE structure_code=$1`, [r.structure_code]);
    if (st.rows.length === 0) return res.json({ repaired: false, reason: "No structure to repair." });
    const hp = st.rows[0].hp;
    const maxhp = st.rows[0].max_hp;
    if (hp >= maxhp) return res.json({ repaired: false, reason: "Building is already at full HP." });
    if (st.rows[0].repairing_by && st.rows[0].repairing_by !== mechanic_uuid) {
      return res.json({ repaired: false, reason: "Another mechanic is already repairing this building." });
    }

    // set the repair job — cron will climb HP over time and pay on completion
    await pool.query(
      `UPDATE ce_structures SET repair_rate=$2, repairing_by=$3, repairing_name=$4, repair_started=NOW(), status='repairing' WHERE structure_code=$1`,
      [r.structure_code, rate, mechanic_uuid, mechanic_name || "Mechanic"]);

    const missing = maxhp - hp;
    const ticks = Math.ceil(missing / rate);
    const etaMin = ticks * 5;   // 5 min per tick
    res.json({
      repaired: true, started: true, business_name: r.business_name,
      current_hp: hp, max_hp: maxhp, rate: rate, eta_minutes: etaMin,
      message: "Repair underway — the building will restore over ~" + etaMin + " min."
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


app.post("/ce/launder", async (req, res) => {
  const { avatar_uuid, community_org, front_code, amount } = req.body;
  let amt = parseInt(amount, 10);
  if (!avatar_uuid || !community_org || !front_code) return res.status(400).json({ error: "Missing avatar_uuid, org, or front_code" });
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: "Invalid amount" });
  try {
    // launderer must be a criminal with enough dirty cash
    const me = await pool.query(
      `SELECT player_type, cash_on_hand FROM ce_criminals WHERE avatar_uuid=$1 AND community_org=$2`,
      [avatar_uuid, community_org]);
    if (me.rows.length === 0) return res.status(404).json({ error: "Player not found" });
    if (me.rows[0].player_type !== "criminal") {
      return res.status(403).json({ error: "Only criminals can launder money. Find a criminal with a front." });
    }
    const dirty = me.rows[0].cash_on_hand || 0;
    if (dirty < amt) return res.json({ laundered: false, reason: "Not enough dirty cash.", have: dirty });

    // front must exist and be flagged
    const fr = await pool.query(
      `SELECT owner_uuid, owner_name, business_name, is_front, front_cut_pct, laundered_total FROM ce_registers WHERE register_code=$1 AND community_org=$2`,
      [front_code, community_org]);
    if (fr.rows.length === 0) return res.status(404).json({ error: "Front not found" });
    if (fr.rows[0].is_front !== true) return res.json({ laundered: false, reason: "That business is not set up as a front." });

    const cutPct = fr.rows[0].front_cut_pct || 20;
    const frontCut = Math.floor(amt * (cutPct / 100));
    const treasuryCut = Math.floor(amt * CE_LAUNDER_TREASURY_PCT);
    const clean = amt - frontCut - treasuryCut;

    // move dirty -> clean for launderer, pay front owner, skim treasury
    await pool.query(
      `UPDATE ce_criminals SET cash_on_hand = GREATEST(cash_on_hand - $3, 0), bank_balance = bank_balance + $4 WHERE avatar_uuid=$1 AND community_org=$2`,
      [avatar_uuid, community_org, amt, clean]);
    await pool.query(
      `UPDATE ce_criminals SET bank_balance = bank_balance + $3 WHERE avatar_uuid=$1 AND community_org=$2`,
      [fr.rows[0].owner_uuid, community_org, frontCut]);
    await pool.query(`UPDATE ce_city SET treasury = treasury + $1 WHERE community_org=$2`, [treasuryCut, community_org]);
    await pool.query(`UPDATE ce_registers SET laundered_total = COALESCE(laundered_total,0) + $2 WHERE register_code=$1`, [front_code, amt]);

    res.json({
      laundered: true, front: fr.rows[0].business_name,
      dirty_washed: amt, clean_received: clean,
      front_cut: frontCut, treasury_cut: treasuryCut, front_cut_pct: cutPct
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Flag/unflag a register as a laundering front (owner only, criminal only)
app.post("/ce/front/set", async (req, res) => {
  const { avatar_uuid, community_org, register_code, on } = req.body;
  if (!avatar_uuid || !community_org || !register_code) return res.status(400).json({ error: "Missing params" });
  try {
    const me = await pool.query(`SELECT player_type FROM ce_criminals WHERE avatar_uuid=$1 AND community_org=$2`, [avatar_uuid, community_org]);
    if (me.rows.length === 0 || me.rows[0].player_type !== "criminal") {
      return res.status(403).json({ error: "Only criminals can run fronts." });
    }
    const reg = await pool.query(`SELECT owner_uuid FROM ce_registers WHERE register_code=$1 AND community_org=$2`, [register_code, community_org]);
    if (reg.rows.length === 0) return res.status(404).json({ error: "Register not found" });
    if (reg.rows[0].owner_uuid !== avatar_uuid) return res.status(403).json({ error: "You do not own this business." });
    const flag = (on === true || on === "true");
    await pool.query(`UPDATE ce_registers SET is_front=$2 WHERE register_code=$1`, [register_code, flag]);
    res.json({ success: true, register_code: register_code, is_front: flag });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ============================================================
// CE SIEGE — declaration, presence, forfeiture
// ============================================================
var SIEGE_MIN_ATTACKERS = 2;        // 2-3 crew online + present to siege
var SIEGE_ONLINE_WINDOW_MIN = 10;   // "online" = active within last N min
var SIEGE_FORFEIT_DAYS = 3;
var SIEGE_BREAK_HP_PCT = 30;        // repair above this % breaks the siege

// heartbeat — HUD calls this so we know who's online (for presence checks)
app.post("/ce/presence", async (req, res) => {
  const { avatar_uuid, community_org } = req.body;
  if (!avatar_uuid || !community_org) return res.status(400).json({ error: "Missing params" });
  try {
    await pool.query("UPDATE ce_criminals SET last_online=NOW() WHERE avatar_uuid=$1 AND community_org=$2", [avatar_uuid, community_org]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// declare a siege on a building
app.post("/ce/siege/declare", async (req, res) => {
  const { register_code, community_org, declarer_uuid } = req.body;
  if (!register_code || !community_org || !declarer_uuid) return res.status(400).json({ error: "Missing params" });
  try {
    // declarer must be in a crew (member or leader)
    let dc = await pool.query("SELECT crew_id FROM ce_crew_members WHERE avatar_uuid=$1 LIMIT 1", [declarer_uuid]);
    let attCrew = null;
    if (dc.rows.length > 0 && dc.rows[0].crew_id) attCrew = dc.rows[0].crew_id;
    if (!attCrew) {
      const dl = await pool.query("SELECT id FROM ce_crews WHERE leader_uuid=$1 AND community_org=$2 LIMIT 1", [declarer_uuid, community_org]);
      if (dl.rows.length > 0) attCrew = dl.rows[0].id;
    }
    if (!attCrew) return res.status(403).json({ error: "You must be in a crew to declare a siege." });

    // declarer must be a CRIMINAL, level 20+, and the crew LEADER
    const decl = await pool.query("SELECT player_type, level FROM ce_criminals WHERE avatar_uuid=$1 AND community_org=$2", [declarer_uuid, community_org]);
    if (decl.rows.length === 0 || decl.rows[0].player_type !== "criminal") {
      return res.status(403).json({ error: "Only criminals can declare a siege." });
    }
    if ((decl.rows[0].level || 1) < 20) {
      return res.json({ declared: false, reason: "You must be level 20+ to declare a siege. (You are " + (decl.rows[0].level || 1) + ".)" });
    }
    const isLeader = await pool.query("SELECT id FROM ce_crews WHERE id=$1 AND leader_uuid=$2", [attCrew, declarer_uuid]);
    if (isLeader.rows.length === 0) {
      return res.json({ declared: false, reason: "Only the crew leader can declare a siege." });
    }

    const crewRow = await pool.query("SELECT crew_name FROM ce_crews WHERE id=$1", [attCrew]);
    const attCrewName = crewRow.rows.length > 0 ? crewRow.rows[0].crew_name : "Unknown Crew";

    // building must exist + not be self-owned by the attacking crew
    const reg = await pool.query("SELECT owner_uuid, crew_id, business_name, structure_code FROM ce_registers WHERE register_code=$1 AND community_org=$2", [register_code, community_org]);
    if (reg.rows.length === 0) return res.status(404).json({ error: "Building not found." });
    const b = reg.rows[0];
    if (b.crew_id && b.crew_id === attCrew) return res.json({ declared: false, reason: "You can't siege your own crew's building." });

    // already under siege?
    const existing = await pool.query("SELECT id FROM ce_sieges WHERE register_code=$1 AND status='active'", [register_code]);
    if (existing.rows.length > 0) return res.json({ declared: false, reason: "This building is already under siege." });

    // siege-immune window (post-takeover protection)?
    if (b.structure_code) {
      const imm = await pool.query("SELECT siege_immune_until FROM ce_structures WHERE structure_code=$1", [b.structure_code]);
      if (imm.rows.length > 0 && imm.rows[0].siege_immune_until && new Date(imm.rows[0].siege_immune_until) > new Date()) {
        return res.json({ declared: false, reason: "This building is under post-takeover protection and can't be sieged yet." });
      }
    }

    // require SIEGE_MIN_ATTACKERS crew online (last_online within window)
    const online = await pool.query(
      "SELECT COUNT(*) AS n FROM ce_crew_members m JOIN ce_criminals c ON m.avatar_uuid=c.avatar_uuid WHERE m.crew_id=$1 AND c.player_type='criminal' AND c.last_online > NOW() - ($2 || ' minutes')::interval",
      [attCrew, String(SIEGE_ONLINE_WINDOW_MIN)]);
    // include leader in the count
    const leaderOnline = await pool.query(
      "SELECT COUNT(*) AS n FROM ce_crews cr JOIN ce_criminals c ON cr.leader_uuid=c.avatar_uuid WHERE cr.id=$1 AND c.last_online > NOW() - ($2 || ' minutes')::interval",
      [attCrew, String(SIEGE_ONLINE_WINDOW_MIN)]);
    const onlineCount = parseInt(online.rows[0].n) + parseInt(leaderOnline.rows[0].n);
    if (onlineCount < SIEGE_MIN_ATTACKERS) {
      return res.json({ declared: false, reason: "Need at least " + SIEGE_MIN_ATTACKERS + " crew online to declare a siege. Only " + onlineCount + " online." });
    }

    // defending crew online check (for the "fair chance" flag)
    let defenderOnline = false;
    if (b.crew_id) {
      const defOn = await pool.query(
        "SELECT COUNT(*) AS n FROM ce_crew_members m JOIN ce_criminals c ON m.avatar_uuid=c.avatar_uuid WHERE m.crew_id=$1 AND c.player_type='criminal' AND c.last_online > NOW() - ($2 || ' minutes')::interval",
        [b.crew_id, String(SIEGE_ONLINE_WINDOW_MIN)]);
      if (parseInt(defOn.rows[0].n) > 0) defenderOnline = true;
    }
    // also check the owner directly
    const ownOn = await pool.query("SELECT last_online FROM ce_criminals WHERE avatar_uuid=$1", [b.owner_uuid]);
    if (ownOn.rows.length > 0 && ownOn.rows[0].last_online && new Date(ownOn.rows[0].last_online) > new Date(Date.now() - SIEGE_ONLINE_WINDOW_MIN*60000)) {
      defenderOnline = true;
    }

    // defender must have presence to activate — no sieging an empty house
    if (!defenderOnline) {
      return res.json({ declared: false, reason: "The defender is offline. You can damage the building (capped at 50%), but a siege only activates when they have someone online to defend." });
    }

    // create the siege
    await pool.query(
      "INSERT INTO ce_sieges (register_code, structure_code, community_org, attacking_crew_id, attacking_crew_name, defending_crew_id, defender_owner_uuid, status, defender_had_online, last_attacker_seen) VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,NOW())",
      [register_code, b.structure_code, community_org, attCrew, attCrewName, b.crew_id || null, b.owner_uuid, defenderOnline]);

    res.json({
      declared: true, business_name: b.business_name,
      attacking_crew: attCrewName, defender_online: defenderOnline,
      message: "SIEGE DECLARED on " + b.business_name + " by " + attCrewName + "! Beat it to 0 HP and hold for " + SIEGE_FORFEIT_DAYS + " days to take it."
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// siege status for a building
app.get("/ce/siege/status", async (req, res) => {
  const { code, org } = req.query;
  if (!code || !org) return res.status(400).json({ error: "Missing code or org" });
  try {
    const s = await pool.query("SELECT * FROM ce_sieges WHERE register_code=$1 AND status='active' ORDER BY declared_at DESC LIMIT 1", [code]);
    if (s.rows.length === 0) return res.json({ under_siege: false });
    const row = s.rows[0];
    res.json({
      under_siege: true, attacking_crew: row.attacking_crew_name,
      declared_at: row.declared_at, forfeiture_deadline: row.forfeiture_deadline,
      hit_zero_at: row.hit_zero_at, defender_had_online: row.defender_had_online
    });
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
    const alarmResult = await pool.query(
      `INSERT INTO fire_alarms
         (detector_code, sim_code, parcel_code, detector_num, region,
          alarm_type, fire_count, smoke_count, ladder_triggered, status, first_detected, org_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),$11) RETURNING id`,
      ['DISPATCH','DISP',parcel_code,'D1',region||'UNKNOWN','FIRE',1,0,false,'active',org_code]
    );
    const alarmId = alarmResult.rows[0].id;
    await pool.query(
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
    const alarmResult = await pool.query(
      `INSERT INTO fire_alarms
         (detector_code, sim_code, parcel_code, detector_num, region,
          alarm_type, fire_count, smoke_count, ladder_triggered, status, first_detected, org_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),$11) RETURNING id`,
      ['DISPATCH','DISP',region||'UNKNOWN','D1',region||'UNKNOWN','MEDICAL',0,0,false,'active',org_code]
    );
    const alarmId = alarmResult.rows[0].id;
    await pool.query(
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

app.post('/security/register', async (req, res) => {
  try {
    var p = req.body;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch(e) {} }
    const { panel_uuid, owner_uuid, owner_name, community_org, location, parcel_name, region, slurl, world_x, world_y, world_z } = p;
    if (!panel_uuid || !owner_uuid) return res.status(400).json({ error: 'panel_uuid and owner_uuid required' });
    await pool.query(
      `INSERT INTO security_panels (panel_uuid, owner_uuid, owner_name, community_org, location, parcel_name, region, slurl, world_x, world_y, world_z, registered_at, last_seen)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())
       ON CONFLICT (panel_uuid) DO UPDATE SET
         owner_name=$3, community_org=$4, location=$5, parcel_name=$6, region=$7, slurl=$8,
         world_x=$9, world_y=$10, world_z=$11, last_seen=NOW()`,
      [panel_uuid, owner_uuid, owner_name||'', community_org||'hemlock', location||'', parcel_name||'', region||'', slurl||'', world_x||0, world_y||0, world_z||0]
    );
    res.json({ success: true, panel_uuid });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /security/arm — arm or disarm panel
app.patch('/security/arm', async (req, res) => {
  try {
    var p = req.body;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch(e) {} }
    const { panel_uuid, armed, silent_mode } = p;
    await pool.query(
      'UPDATE security_panels SET armed=$1, silent_mode=COALESCE($2,silent_mode), last_seen=NOW() WHERE panel_uuid=$3',
      [armed, silent_mode !== undefined ? silent_mode : null, panel_uuid]
    );
    res.json({ success: true, armed });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /alarm/burglary — trigger burglary alarm, auto-create PD incident
app.post('/alarm/burglary', async (req, res) => {
  const client = await pool.connect();
  try {
    var p = req.body;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch(e) {} }
    const { panel_uuid, community_org, location, parcel_name, region, slurl, world_x, world_y, trigger_type, suspect_uuid, suspect_name } = p;
    const org = community_org || 'hemlock';

    await pool.query('BEGIN');

    // Create PD incident automatically
    const incResult = await pool.query(
      `INSERT INTO pd_incidents (community_org, incident_type, location, slurl, description, reporting_officer, status, created_at)
       VALUES ($1,'Burglary Alarm',$2,$3,$4,'RES Security System','active',NOW()) RETURNING id`,
      [org, location||parcel_name||region||'Unknown', slurl||'', 'Automatic alarm trigger at ' + (parcel_name||location||region||'Unknown')]
    );
    const pdIncidentId = incResult.rows[0].id;

    // Create burglary incident record
    const burgResult = await pool.query(
      `INSERT INTO burglary_incidents (community_org, panel_uuid, location, parcel_name, region, slurl, world_x, world_y, trigger_type, suspect_uuid, suspect_name, status, pd_incident_id, triggered_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'open',$12,NOW()) RETURNING id`,
      [org, panel_uuid||'', location||'', parcel_name||'', region||'', slurl||'', world_x||0, world_y||0, trigger_type||'motion', suspect_uuid||'', suspect_name||'', pdIncidentId]
    );
    const burgId = burgResult.rows[0].id;

    await pool.query('COMMIT');

    console.log('[burglary] Alarm triggered at ' + (parcel_name||location||'Unknown') + ' | PD incident #' + pdIncidentId);
    res.json({ success: true, burglary_id: burgId, pd_incident_id: pdIncidentId });
  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// GET /security/burglaries — get burglary incidents for a community
app.get('/security/burglaries', async (req, res) => {
  try {
    const org = req.query.org || 'hemlock';
    const r = await pool.query(
      "SELECT * FROM burglary_incidents WHERE community_org=$1 ORDER BY triggered_at DESC LIMIT 50",
      [org]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /security/burglary/:id/resolve — mark burglary resolved
app.patch('/security/burglary/:id/resolve', async (req, res) => {
  try {
    var p = req.body;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch(e) {} }
    await pool.query(
      "UPDATE burglary_incidents SET status='resolved', notes=COALESCE($1,notes), resolved_at=NOW() WHERE id=$2",
      [p.notes||null, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /security/stolen — log a stolen item
app.post('/security/stolen', async (req, res) => {
  try {
    var p = req.body;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch(e) {} }
    const { item_uuid, item_name, item_type, value_l, owner_uuid, owner_name, criminal_uuid, criminal_name, community_org, location, region, burglary_id } = p;
    if (!item_uuid || !item_name) return res.status(400).json({ error: 'item_uuid and item_name required' });
    const r = await pool.query(
      `INSERT INTO stolen_items (item_uuid, item_name, item_type, value_l, owner_uuid, owner_name, criminal_uuid, criminal_name, community_org, location, region, status, burglary_id, stolen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'stolen',$12,NOW()) RETURNING *`,
      [item_uuid, item_name, item_type||'unknown', value_l||0, owner_uuid||'', owner_name||'', criminal_uuid||'', criminal_name||'', community_org||'hemlock', location||'', region||'', burglary_id||null]
    );
    res.json({ success: true, item: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /security/stolen/inventory/:uuid — get criminal stolen inventory
app.get('/security/stolen/inventory/:uuid', async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT * FROM stolen_items WHERE criminal_uuid=$1 AND status='stolen' ORDER BY stolen_at DESC",
      [req.params.uuid]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /security/stolen/:id/fence — fence a stolen item at pawn shop
app.patch('/security/stolen/:id/fence', async (req, res) => {
  try {
    var p = req.body;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch(e) {} }
    await pool.query(
      "UPDATE stolen_items SET status='fenced', fenced_at=NOW() WHERE id=$1 AND status='stolen'",
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /security/stolen/:id/recover — PD recovers stolen item
app.patch('/security/stolen/:id/recover', async (req, res) => {
  try {
    await pool.query(
      "UPDATE stolen_items SET status='recovered', recovered_at=NOW() WHERE id=$1",
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /pd/evidence — log evidence collected at crime scene
app.post('/pd/evidence', async (req, res) => {
  try {
    var p = req.body;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch(e) {} }
    const { community_org, burglary_id, pd_incident_id, evidence_type, suspect_uuid, suspect_name, location, region, collected_by, photo_url, notes } = p;
    const r = await pool.query(
      `INSERT INTO evidence (community_org, burglary_id, pd_incident_id, evidence_type, suspect_uuid, suspect_name, location, region, collected_by, photo_url, notes, collected_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW()) RETURNING *`,
      [community_org||'hemlock', burglary_id||null, pd_incident_id||null, evidence_type||'fingerprint', suspect_uuid||'', suspect_name||'', location||'', region||'', collected_by||'', photo_url||'', notes||'']
    );
    res.json({ success: true, evidence: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /pd/evidence/:burglary_id — get evidence for a case
app.get('/pd/evidence/:burglary_id', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM evidence WHERE burglary_id=$1 ORDER BY collected_at DESC',
      [req.params.burglary_id]
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
