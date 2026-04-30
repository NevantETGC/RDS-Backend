const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());
app.use((req, res, next) => { console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} - Body: ${JSON.stringify(req.body)}`); next(); });
const pool = new Pool({ user: 'hydrant_user', host: 'localhost', database: 'hydrant_db', password: '1127331Nas', port: 5432 });

app.post('/incident', async (req, res) => {
  const { sim_name, hydrant_name, avatar_name, vehicle_name, incident_date, incident_time, world_x, world_y } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const priority = avatar_name === 'UNKNOWN' ? 'investigate' : 'normal';
    const inc = await client.query('INSERT INTO incidents (sim_name, hydrant_name, avatar_name, vehicle_name, incident_date, incident_time, priority, world_x, world_y) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [sim_name, hydrant_name, avatar_name, vehicle_name, incident_date, incident_time, priority, world_x || 128, world_y || 128]);
    const id = inc.rows[0].id;
    await client.query('INSERT INTO notifications (incident_id, department, message) VALUES ($1,$2,$3)', [id, 'dpw', 'New hydrant down: ' + hydrant_name + ' in ' + sim_name]);
    await client.query('INSERT INTO notifications (incident_id, department, message) VALUES ($1,$2,$3)', [id, 'fd', 'Hydrant down: ' + hydrant_name + ' in ' + sim_name]);
    if (avatar_name !== 'UNKNOWN') {
      await client.query('INSERT INTO notifications (incident_id, department, message) VALUES ($1,$2,$3)', [id, 'pd', 'Citation candidate: ' + avatar_name + ' in ' + sim_name]);
    } else {
      await client.query('INSERT INTO notifications (incident_id, department, message) VALUES ($1,$2,$3)', [id, 'pd', 'Unknown driver investigation needed: ' + sim_name]);
    }
    await client.query('COMMIT');
    res.json(inc.rows[0]);
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

app.get('/incidents', async (req, res) => {
  try { const r = await pool.query('SELECT * FROM incidents ORDER BY created_at DESC'); res.json(r.rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
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
    const r = await client.query("UPDATE incidents SET assigned_to = $1, assigned_at = NOW() WHERE id = $2 RETURNING *", [department, req.params.id]);
    await client.query('INSERT INTO assignments (incident_id, assigned_to, assigned_by, notes) VALUES ($1,$2,$3,$4)', [req.params.id, department, assigned_by || department, notes || '']);
    await client.query('UPDATE notifications SET seen = true WHERE incident_id = $1 AND department = $2', [req.params.id, department]);
    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

app.patch('/incident/:id/acknowledge', async (req, res) => {
  const { department } = req.body;
  try {
    const r = await pool.query("UPDATE incidents SET acknowledged_at = NOW(), assigned_to = $1, hydrant_status = 'responding' WHERE id = $2 RETURNING *", [department, req.params.id]);
    await pool.query('UPDATE notifications SET seen = true WHERE incident_id = $1 AND department = $2', [req.params.id, department]);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/incident/:id/resolve', async (req, res) => {
  const { notes } = req.body;
  try {
    const r = await pool.query("UPDATE incidents SET resolved = true, hydrant_status = 'repaired', notes = COALESCE($1, notes) WHERE id = $2 RETURNING *", [notes || null, req.params.id]);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/incident/:id/ticket', async (req, res) => {
  const { notes } = req.body;
  const ticket = 'TKT-' + Date.now().toString().slice(-6);
  try {
    const r = await pool.query("UPDATE incidents SET ticket_number = $1, notes = $2, assigned_to = 'pd' WHERE id = $3 RETURNING *", [ticket, notes || '', req.params.id]);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/incident/:id/investigate', async (req, res) => {
  const { notes } = req.body;
  try {
    const r = await pool.query("UPDATE incidents SET priority = 'investigate', notes = $1, assigned_to = 'pd' WHERE id = $2 RETURNING *", [notes || '', req.params.id]);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/incident/:id/notes', async (req, res) => {
  const { notes } = req.body;
  try {
    const r = await pool.query("UPDATE incidents SET notes = $1 WHERE id = $2 RETURNING *", [notes || '', req.params.id]);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/notifications/:dept', async (req, res) => {
  try {
    const r = await pool.query('SELECT n.*, i.sim_name, i.hydrant_name, i.avatar_name, i.vehicle_name, i.incident_date, i.incident_time, i.assigned_to, i.priority FROM notifications n JOIN incidents i ON n.incident_id = i.id WHERE n.department = $1 AND n.seen = false ORDER BY n.created_at DESC', [req.params.dept]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/notifications/:dept/seen', async (req, res) => {
  try {
    await pool.query('UPDATE notifications SET seen = true WHERE department = $1', [req.params.dept]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/violation', async (req, res) => {
  const { sim_name, avatar_name, vehicle_name, speed_recorded, speed_limit, zone_name, violation_date, violation_time } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const v = await client.query('INSERT INTO violations (sim_name, avatar_name, vehicle_name, speed_recorded, speed_limit, zone_name, violation_date, violation_time) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [sim_name, avatar_name, vehicle_name, speed_recorded, speed_limit, zone_name || 'Main Road', violation_date, violation_time]);
    const vid = v.rows[0].id;
    await client.query('INSERT INTO notifications (incident_id, department, message) VALUES ($1,$2,$3)', [vid, 'pd', 'Speed violation: ' + avatar_name + ' doing ' + speed_recorded + ' mph in ' + (zone_name || 'Main Road') + ' (' + speed_limit + ' mph zone)']);
    await client.query('COMMIT');
    res.json(v.rows[0]);
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

app.get('/violations', async (req, res) => {
  try { const r = await pool.query('SELECT * FROM violations ORDER BY created_at DESC'); res.json(r.rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/violations/pd', async (req, res) => {
  try { const r = await pool.query('SELECT * FROM violations WHERE resolved = false ORDER BY created_at DESC'); res.json(r.rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/violation/:id/ticket', async (req, res) => {
  const { notes } = req.body;
  const ticket = 'SPD-' + Date.now().toString().slice(-6);
  try {
    const r = await pool.query("UPDATE violations SET ticket_number = $1, notes = $2, resolved = true WHERE id = $3 RETURNING *", [ticket, notes || '', req.params.id]);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});


app.post('/dispatch/fire', async (req, res) => {
  const client = await pool.connect();
  try {
    var payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch(e) {} }
    const { caller_name, region, address, issue, timestamp } = payload;
    const detector_code = 'DISPATCH';
    const sim_code = 'DISP';
    const parcel_code = address || 'UNKNOWN';
    const location = sim_code + '-' + parcel_code;

    const alarmResult = await client.query(
      `INSERT INTO fire_alarms (detector_code, sim_code, parcel_code, detector_num, region, alarm_type, fire_count, smoke_count, ladder_triggered, status, first_detected)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW()) RETURNING id`,
      [detector_code, sim_code, parcel_code, 'D1', region || 'UNKNOWN', 'FIRE', 1, 0, false, 'active']
    );
    const alarmId = alarmResult.rows[0].id;

    await client.query(
      `INSERT INTO alarm_notifications (alarm_id, department, message) VALUES ($1,$2,$3)`,
      [alarmId, 'fd', 'Fire reported at ' + location + ' by ' + caller_name + ' | ' + issue]
    );

    res.json({ success: true, alarm_id: alarmId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});
app.patch('/incidents/dismiss-fd', async (req, res) => {
  try {
    await pool.query('UPDATE incidents SET dismissed_fd = true WHERE dismissed_fd = false AND resolved = false');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/violation/:id/dismiss', async (req, res) => {
  const { notes } = req.body;
  try {
    const r = await pool.query("UPDATE violations SET resolved = true, notes = $1 WHERE id = $2 RETURNING *", [notes || 'Dismissed', req.params.id]);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/camera/config/:sim_name', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM camera_configs WHERE sim_name = $1', [req.params.sim_name]);
    if (r.rows.length === 0) {
      res.json({ sim_name: req.params.sim_name, speed_limit: 20.0, scan_radius: 25.0, alert_driver: true, zone_name: 'Main Road' });
    } else { res.json(r.rows[0]); }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/camera/config', async (req, res) => {
  const { sim_name, speed_limit, scan_radius, alert_driver, zone_name } = req.body;
  try {
    const r = await pool.query("INSERT INTO camera_configs (sim_name, speed_limit, scan_radius, alert_driver, zone_name, updated_at) VALUES ($1,$2,$3,$4,$5,NOW()) ON CONFLICT (sim_name) DO UPDATE SET speed_limit=$2, scan_radius=$3, alert_driver=$4, zone_name=$5, updated_at=NOW() RETURNING *", [sim_name, speed_limit || 20.0, scan_radius || 25.0, alert_driver !== false, zone_name || 'Main Road']);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/camera/configs', async (req, res) => {
  try { const r = await pool.query('SELECT * FROM camera_configs ORDER BY sim_name'); res.json(r.rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/alarm', async (req, res) => {
  const { detector_code, sim_code, parcel_code, detector_num, region, alarm_type, fire_count, smoke_count, ladder_triggered, first_detected, world_x, world_y } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query("SELECT id, status, ladder_triggered FROM fire_alarms WHERE detector_code = $1 AND status != 'cleared' AND alarm_type != 'CLEAR'", [detector_code]);
    let alarm;
    if (alarm_type === 'CLEAR') {
      if (existing.rows.length > 0) {
        alarm = await client.query("UPDATE fire_alarms SET alarm_type = 'CLEAR', status = 'cleared', fire_count = 0, smoke_count = 0, last_updated = NOW() WHERE detector_code = $1 AND status != 'cleared' RETURNING *", [detector_code]);
      } else {
        await client.query('COMMIT');
        return res.json({ ok: true, message: 'No active alarm to clear' });
      }
    } else if (existing.rows.length > 0) {
      const wasLadder = existing.rows[0].ladder_triggered;
      alarm = await client.query("UPDATE fire_alarms SET alarm_type = $1, fire_count = $2, smoke_count = $3, ladder_triggered = $4, last_updated = NOW() WHERE detector_code = $5 AND status != 'cleared' RETURNING *", [alarm_type, fire_count || 0, smoke_count || 0, ladder_triggered || false, detector_code]);
      if (ladder_triggered && !wasLadder) {
        const alarmId = existing.rows[0].id;
        const location = sim_code + '-' + parcel_code;
        await client.query('INSERT INTO alarm_notifications (alarm_id, department, message) VALUES ($1,$2,$3)', [alarmId, 'fd', 'LADDER ESCALATION: ' + detector_code + ' at ' + location + ' | Fire objects: ' + fire_count]);
      }
    } else {
      alarm = await client.query("INSERT INTO fire_alarms (detector_code, sim_code, parcel_code, detector_num, region, alarm_type, fire_count, smoke_count, ladder_triggered, first_detected, last_updated, status, world_x, world_y) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),'active',$11,$12) RETURNING *", [detector_code, sim_code, parcel_code, detector_num, region, alarm_type, fire_count || 0, smoke_count || 0, ladder_triggered || false, first_detected || new Date().toISOString(), world_x || 128, world_y || 128]);
      const alarmId = alarm.rows[0].id;
      const location = sim_code + '-' + parcel_code;
      await client.query('INSERT INTO alarm_notifications (alarm_id, department, message) VALUES ($1,$2,$3)', [alarmId, 'fd', 'Fire alarm: ' + detector_code + ' at ' + location + ' | ' + alarm_type]);
      await client.query('INSERT INTO alarm_notifications (alarm_id, department, message) VALUES ($1,$2,$3)', [alarmId, 'pd', 'Fire alarm reported at ' + location + ' (' + region + ')']);
    }
    await client.query('COMMIT');
    res.json(alarm.rows[0]);
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

app.get('/alarms/fd', async (req, res) => {
  try { const r = await pool.query("SELECT * FROM fire_alarms WHERE status != 'cleared' ORDER BY last_updated DESC"); res.json(r.rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/alarms/pd', async (req, res) => {
  try { const r = await pool.query("SELECT id, sim_code, parcel_code, region, alarm_type, first_detected, last_updated, status FROM fire_alarms WHERE status != 'cleared' ORDER BY last_updated DESC"); res.json(r.rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/alarms', async (req, res) => {
  try { const r = await pool.query('SELECT * FROM fire_alarms ORDER BY last_updated DESC'); res.json(r.rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/alarm/:id/claim', async (req, res) => {
  try { const r = await pool.query("UPDATE fire_alarms SET status = 'responding', claimed_at = NOW() WHERE id = $1 RETURNING *", [req.params.id]); res.json(r.rows[0]); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/alarm/:id/silence', async (req, res) => {
  try { const r = await pool.query("UPDATE fire_alarms SET status = 'silenced', last_updated = NOW() WHERE id = $1 RETURNING *", [req.params.id]); res.json(r.rows[0]); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/alarm/:id/reset', async (req, res) => {
  try { const r = await pool.query("UPDATE fire_alarms SET status = 'cleared', last_updated = NOW() WHERE id = $1 RETURNING *", [req.params.id]); res.json(r.rows[0]); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/alarm/:id/notes', async (req, res) => {
  const { notes } = req.body;
  try { const r = await pool.query("UPDATE fire_alarms SET notes = $1, last_updated = NOW() WHERE id = $2 RETURNING *", [notes || '', req.params.id]); res.json(r.rows[0]); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/alarm-notifications/:dept', async (req, res) => {
  try {
    const r = await pool.query("SELECT fa.detector_code, fa.sim_code, fa.parcel_code, fa.detector_num, fa.region, fa.alarm_type, fa.fire_count, fa.smoke_count, fa.ladder_triggered, fa.first_detected, 'secondlife://' || replace(fa.region, ' ', '%20') || '/' || fa.world_x || '/' || fa.world_y || '/0' AS slurl FROM alarm_notifications an JOIN fire_alarms fa ON an.alarm_id = fa.id WHERE an.department = $1 AND an.seen = false ORDER BY an.created_at ASC LIMIT 1", [req.params.dept]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/alarm-notifications/:dept/seen', async (req, res) => {
  try { await pool.query('UPDATE alarm_notifications SET seen = true WHERE department = $1', [req.params.dept]); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/alarm-notifications/:dept/reset', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE alarm_notifications SET seen = true WHERE department = $1', [req.params.dept]);
    await client.query("UPDATE fire_alarms SET status = 'cleared', last_updated = NOW() WHERE id IN (SELECT alarm_id FROM alarm_notifications WHERE department = $1)", [req.params.dept]);
    // Delete notifications so cooldown resets and next alarm triggers fresh
    await client.query('DELETE FROM alarm_notifications WHERE department = $1', [req.params.dept]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

// POST /detector/register
app.post('/detector/register', async (req, res) => {
  const { detector_code, sim_code, parcel_code, detector_num, region, world_pos, state, battery_pct } = req.body;
  try {
    const r = await pool.query(
      `INSERT INTO detectors (detector_code, sim_code, parcel_code, detector_num, region, world_pos, state, battery_pct, last_seen, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
       ON CONFLICT (detector_code) DO UPDATE SET
         region      = EXCLUDED.region,
         world_pos   = EXCLUDED.world_pos,
         state       = EXCLUDED.state,
         battery_pct = EXCLUDED.battery_pct,
         last_seen   = NOW()
       RETURNING *`,
      [detector_code, sim_code, parcel_code, detector_num, region, world_pos || null, state || 0, battery_pct || 100]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// ============================================================

// ── DB Migration — run once in psql ──────────────────────────
//
// CREATE TABLE IF NOT EXISTS detector_commands (
//   id             SERIAL PRIMARY KEY,
//   detector_code  VARCHAR(32) NOT NULL,
//   command        VARCHAR(32) NOT NULL,
//   created_at     TIMESTAMPTZ DEFAULT NOW(),
//   relayed        BOOLEAN     DEFAULT FALSE
// );
//
// ─────────────────────────────────────────────────────────────

// POST /detector/register (already exists — no change needed)

// GET /detectors
app.get('/detectors', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM detectors ORDER BY state DESC, detector_code ASC');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /detector/:code/hard_reset
// Queues a HARD_RESET command for the panel to relay in-world
app.post('/detector/:code/hard_reset', async (req, res) => {
  const code = req.params.code;
  try {
    // Clear DB state
    await pool.query(
      'UPDATE detectors SET state = 0, last_seen = NOW() WHERE detector_code = $1',
      [code]
    );
    await pool.query(
      "UPDATE fire_alarms SET status = 'cleared', last_updated = NOW() WHERE detector_code = $1 AND status != 'cleared'",
      [code]
    );
    // Queue command for panel to relay in-world
    await pool.query(
      'INSERT INTO detector_commands (detector_code, command) VALUES ($1, $2)',
      [code, 'HARD_RESET']
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /detector/commands/pending
// Panel polls this to get unrelayed commands, then sends them in-world
app.get('/detector/commands/pending', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM detector_commands WHERE relayed = FALSE ORDER BY created_at ASC'
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /detector/commands/clear
// Panel calls this after relaying all pending commands
app.patch('/detector/commands/clear', async (req, res) => {
  try {
    await pool.query('UPDATE detector_commands SET relayed = TRUE WHERE relayed = FALSE');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});



// ── MAP ENDPOINTS ─────────────────────────────────────────────

// GET /hydrants — deduplicated hydrant status per hydrant name
app.get('/hydrants', async (req, res) => {
  const SIM_CODES = {
    'Cherokee Rose Lake': 'A', 'Oakley Springs': 'B', 'Crescent Creek': 'C',
    'Hidden Hollow': 'E', 'Meadowview Heights': 'F', 'MeadowView Heights': 'F',
    'Cloverdale Ridge': 'I'
  };
  try {
    const r = await pool.query(`
      SELECT DISTINCT ON (hydrant_name)
        id, hydrant_name AS name, sim_name, world_x, world_y,
        CASE WHEN resolved = true THEN 'ok' ELSE 'knocked' END AS status,
        avatar_name, incident_date, incident_time, created_at, resolved
      FROM incidents
      ORDER BY hydrant_name, created_at DESC
    `);
    const rows = r.rows.map(row => ({
      ...row,
      sim_code: SIM_CODES[row.sim_name] || row.sim_name.charAt(0).toUpperCase()
    }));
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /map/active — single endpoint for live map (alarms + hydrants)
app.get('/map/active', async (req, res) => {
  try {
    const alarms = await pool.query(`
      SELECT
        id,
        detector_code AS code,
        sim_code,
        parcel_code,
        region,
        alarm_type,
        fire_count,
        smoke_count,
        ladder_triggered,
        world_x,
        world_y,
        status,
        first_detected,
        last_updated
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

    const SIM_CODES = {
      'Cherokee Rose Lake': 'A', 'Oakley Springs': 'B', 'Crescent Creek': 'C',
      'Hidden Hollow': 'E', 'Meadowview Heights': 'F', 'MeadowView Heights': 'F',
      'Cloverdale Ridge': 'I'
    };
    const hydratedHydrants = hydrants.rows.map(h => ({
      ...h,
      sim_code: SIM_CODES[h.sim_name] || h.sim_name.charAt(0).toUpperCase()
    }));

    res.json({
      alarms: alarms.rows,
      hydrants: hydratedHydrants,
      generated_at: new Date().toISOString()
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Medical alerts
app.post('/medical', async (req, res) => {
  try {
    const { avatar_name, avatar_key, region, world_x, world_y, emergency_type, timestamp, slurl } = req.body;
    await pool.query(
      `INSERT INTO medical_alerts (avatar_name, avatar_key, region, world_x, world_y, emergency_type, timestamp, slurl)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [avatar_name, avatar_key, region, world_x, world_y, emergency_type, timestamp, slurl || '']
    );
    res.status(201).json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/medical/pending', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM medical_alerts WHERE seen_panel = FALSE ORDER BY created_at ASC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.patch('/medical/seen-panel', async (req, res) => {
  try {
    await pool.query('UPDATE medical_alerts SET seen_panel = TRUE WHERE seen_panel = FALSE');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.patch('/medical/seen', async (req, res) => {
  try {
    await pool.query(`UPDATE medical_alerts SET seen_panel = TRUE WHERE seen_panel = FALSE`);
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/medical/clear', async (req, res) => {
  try {
    await pool.query(`DELETE FROM medical_alerts WHERE seen = TRUE`);
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/medical/all', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM medical_alerts ORDER BY created_at DESC LIMIT 50`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => console.log('Hydrant API v4 running on port 3000'));
