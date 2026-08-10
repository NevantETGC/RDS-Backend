// ce_police.js — CE Police investigation endpoints
// 3430 Labs — lets an on-duty cop pull a till's crime-scene forensic report.
//
// INSTALL:
//   1. Put this file at /var/www/hydrant-api/ce_police.js
//   2. In server.js, before app.listen, add ONE line:
//         require("./ce_police")(app, pool);
//   3. node --check server.js && pm2 restart hydrant-api

module.exports = function (app, pool) {

  // is this avatar an on-duty police officer?
  async function isOnDutyCop(uuid, org) {
    try {
      const r = await pool.query(
        "SELECT 1 FROM ce_job_shifts WHERE avatar_uuid=$1 AND community_org=$2 AND status='active' AND job_type='police' LIMIT 1",
        [uuid, org]);
      return r.rows.length > 0;
    } catch (e) { return false; }
  }

  // COP touches a till -> pull the latest crime scene forensic report for that register.
  // GET /ce/till/scene?register_code=X&cop_uuid=Y&org=Z
  app.get("/ce/till/scene", async (req, res) => {
    const { register_code, cop_uuid, org } = req.query;
    const community_org = org || "rfr";
    if (!register_code || !cop_uuid) return res.status(400).json({ error: "Missing register_code or cop_uuid" });
    try {
      const cop = await isOnDutyCop(cop_uuid, community_org);
      if (!cop) return res.json({ is_cop: false, error: "You must be an on-duty officer to investigate." });

      // latest OPEN scene for this register
      const s = await pool.query(
        "SELECT id, business_name, suspect_uuid, suspect_name, amount_taken, prints_left, name_known, alarm_sounded, status, occurred_at, EXTRACT(EPOCH FROM (NOW() - occurred_at))::int AS secs_ago FROM ce_crime_scenes WHERE register_code=$1 AND community_org=$2 AND status='open' ORDER BY occurred_at DESC LIMIT 1",
        [register_code, community_org]);

      if (s.rows.length === 0) {
        return res.json({ is_cop: true, found: false, message: "No open crime scene here. This till hasn't been robbed recently, or the case is closed." });
      }

      const row = s.rows[0];
      // mark it investigated by this cop
      await pool.query("UPDATE ce_crime_scenes SET investigated_by=$1, status='investigated' WHERE id=$2", [cop_uuid, row.id]);

      // build the forensic report — mask hides the name, gloves hide prints
      const mins = Math.max(1, Math.round(row.secs_ago / 60));
      let suspect;
      if (row.name_known && row.suspect_name) suspect = row.suspect_name;
      else suspect = "UNKNOWN (suspect wore a mask)";

      res.json({
        is_cop: true,
        found: true,
        scene_id: row.id,
        business_name: row.business_name,
        minutes_ago: mins,
        amount_taken: row.amount_taken,
        suspect: suspect,
        suspect_uuid: row.name_known ? row.suspect_uuid : null,
        name_known: row.name_known,
        prints_left: row.prints_left,
        alarm_sounded: row.alarm_sounded,
        // a ready-to-print summary the till can just say
        report:
          "[CRIME SCENE - " + (row.business_name || "Business") + "]\n" +
          "Robbed " + mins + " min ago | " + row.amount_taken + " taken\n" +
          "Suspect: " + suspect + "\n" +
          "Prints: " + (row.prints_left ? "LEFT (no gloves)" : "none (wore gloves)") +
          "  |  Alarm: " + (row.alarm_sounded ? "sounded" : "silent")
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // COP clears/closes a scene once handled.  POST { register_code, cop_uuid, org }
  app.post("/ce/till/scene/clear", async (req, res) => {
    const { register_code, cop_uuid, community_org } = req.body;
    const org = community_org || "rfr";
    if (!register_code || !cop_uuid) return res.status(400).json({ error: "Missing register_code or cop_uuid" });
    try {
      const cop = await isOnDutyCop(cop_uuid, org);
      if (!cop) return res.json({ is_cop: false, error: "You must be an on-duty officer." });
      const c = await pool.query(
        "UPDATE ce_crime_scenes SET status='cleared', cleared_by=$1, cleared_at=NOW() WHERE register_code=$2 AND community_org=$3 AND status IN ('open','investigated') RETURNING id",
        [cop_uuid, register_code, org]);
      res.json({ is_cop: true, cleared: c.rows.length, message: "Scene cleared." });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  console.log("[CE POLICE] investigation endpoints loaded");
};
