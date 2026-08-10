// ce_admin.js — CE Admin Management endpoints
// 3430 Labs — cleanup + failsafe tools for registers, structures, and player status.
//
// INSTALL:
//   1. Put this file at /var/www/hydrant-api/ce_admin.js
//   2. In server.js, AFTER `const pool = ...` and after `app` is created, add ONE line:
//         require("./ce_admin")(app, pool);
//      (put it near the other route definitions, before app.listen)
//   3. node --check server.js && pm2 restart hydrant-api
//
// All endpoints require the admin key: ?key=3430-ADMIN-2024  (or admin_key in the POST body)

module.exports = function (app, pool) {
  const CE_ADMIN_KEY = "3430-ADMIN-2024";

  function ok(req) {
    return (req.query && req.query.key === CE_ADMIN_KEY) ||
           (req.body && req.body.admin_key === CE_ADMIN_KEY);
  }

  // ---- LIST registers (see everything an owner has, or the whole org) ----
  app.get("/ce/admin/registers", async (req, res) => {
    if (!ok(req)) return res.status(403).json({ error: "Bad admin key" });
    const { owner_uuid, community_org } = req.query;
    const org = community_org || "rfr";
    try {
      let q;
      if (owner_uuid) {
        q = await pool.query(
          "SELECT register_code, business_name, owner_name, structure_code FROM ce_registers WHERE owner_uuid=$1 AND community_org=$2 ORDER BY business_name",
          [owner_uuid, org]);
      } else {
        q = await pool.query(
          "SELECT register_code, business_name, owner_name, structure_code FROM ce_registers WHERE community_org=$1 ORDER BY owner_name, business_name",
          [org]);
      }
      res.json({ count: q.rows.length, registers: q.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- DELETE one register (+ its structure + any siege on it) ----
  app.post("/ce/admin/register/delete", async (req, res) => {
    if (!ok(req)) return res.status(403).json({ error: "Bad admin key" });
    const { register_code } = req.body;
    if (!register_code) return res.status(400).json({ error: "Missing register_code" });
    try {
      await pool.query("DELETE FROM ce_sieges WHERE register_code=$1", [register_code]);
      await pool.query("DELETE FROM ce_structures WHERE structure_code=$1", [register_code]);
      const d = await pool.query("DELETE FROM ce_registers WHERE register_code=$1 RETURNING business_name", [register_code]);
      res.json({ deleted: d.rows.length > 0, business_name: d.rows.length ? d.rows[0].business_name : null });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- KEEP-ONLY: delete all of an owner's registers except the one to keep ----
  app.post("/ce/admin/register/keep-only", async (req, res) => {
    if (!ok(req)) return res.status(403).json({ error: "Bad admin key" });
    const { owner_uuid, keep_code, community_org } = req.body;
    if (!owner_uuid || !keep_code) return res.status(400).json({ error: "Missing owner_uuid or keep_code" });
    const org = community_org || "rfr";
    try {
      const doomed = await pool.query(
        "SELECT register_code FROM ce_registers WHERE owner_uuid=$1 AND community_org=$2 AND register_code<>$3",
        [owner_uuid, org, keep_code]);
      for (const row of doomed.rows) {
        await pool.query("DELETE FROM ce_sieges WHERE register_code=$1", [row.register_code]);
        await pool.query("DELETE FROM ce_structures WHERE structure_code=$1", [row.register_code]);
        await pool.query("DELETE FROM ce_registers WHERE register_code=$1", [row.register_code]);
      }
      res.json({ deleted_count: doomed.rows.length, kept: keep_code });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- SET player status (criminal/civilian) + fix path_chosen ----
  app.post("/ce/admin/player/status", async (req, res) => {
    if (!ok(req)) return res.status(403).json({ error: "Bad admin key" });
    const { avatar_uuid, player_type, community_org } = req.body;
    if (!avatar_uuid || !player_type) return res.status(400).json({ error: "Missing avatar_uuid or player_type" });
    const org = community_org || "rfr";
    const chosen = (player_type === "civilian") ? false : true;
    try {
      await pool.query(
        "UPDATE ce_criminals SET player_type=$1, path_chosen=$4 WHERE avatar_uuid=$2 AND community_org=$3",
        [player_type, avatar_uuid, org, chosen]);
      res.json({ success: true, avatar_uuid, player_type, path_chosen: chosen });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  console.log("[CE ADMIN] management endpoints loaded");
};
