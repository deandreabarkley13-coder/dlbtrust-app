"use strict";
const V2 = "/var/www/vhosts/dlbtrust.cloud/dlbtrust-v2";
const HD = "/var/www/vhosts/dlbtrust.cloud/httpdocs";
const express = require(V2 + "/node_modules/express");
const path = require("path");
const fs = require("fs");
const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Auth routes from v2
try { require(V2 + "/auth-routes.cjs")(app); console.log("[auth] loaded"); } catch(e) { console.warn("[auth]", e.message); }

// API routes from v2  
try { require(V2 + "/api-routes.cjs")(app); console.log("[api] loaded"); } catch(e) { console.warn("[api]", e.message); }

// OpenACH integration
try { require(HD + "/server/openach-patch")(app, null); console.log("[openach] loaded"); } catch(e) { console.warn("[openach]", e.message); }

// Analytics routes
try { app.use("/api/analytics", require(HD + "/server/routes/analytics")); console.log("[analytics] loaded"); } catch(e) { console.warn("[analytics]", e.message); }

// Fineract core banking routes
try { app.use("/api/fineract", require(HD + "/server/routes/fineract")); console.log("[fineract] loaded"); } catch(e) { console.warn("[fineract]", e.message); }

// Fixed Income / Bond routes
try { app.use("/api/bonds", require(HD + "/server/routes/bonds")); console.log("[bonds] loaded"); } catch(e) { console.warn("[bonds]", e.message); }

// Cash Management routes
try { app.use("/api/cash", require(HD + "/server/routes/cash")); console.log("[cash] loaded"); } catch(e) { console.warn("[cash]", e.message); }

// CRM Engine routes
try { app.use("/api/crm", require(HD + "/server/routes/crm")); console.log("[crm] loaded"); } catch(e) { console.warn("[crm]", e.message); }

// Admin Control routes
try { app.use("/api/admin", require(HD + "/server/routes/admin")); console.log("[admin] loaded"); } catch(e) { console.warn("[admin]", e.message); }

// Document Management routes
try { app.use("/api/documents", require(HD + "/server/routes/documents")); console.log("[documents] loaded"); } catch(e) { console.warn("[documents]", e.message); }

// Trust Accounting routes
try { app.use("/api/accounting", require(HD + "/server/routes/accounting")); console.log("[accounting] loaded"); } catch(e) { console.warn("[accounting]", e.message); }

// Treasury dashboard (served from httpdocs/public)
app.use("/treasury", express.static(path.join(HD, "public")));
app.get("/treasury", (req, res) => res.sendFile(path.join(HD, "public", "dashboard.html")));

// Start live bond accrual scheduler
try {
  const { LiveBondEngine } = require(HD + "/server/integrations/bonds/liveEngine");
  LiveBondEngine.scheduleAccrualJob();
  console.log("[liveEngine] daily accrual scheduler started");
} catch(e) { console.warn("[liveEngine]", e.message); }

// Static files from v2
app.use(express.static(path.join(V2, "dist", "public")));
app.use("/assets", express.static(path.join(V2, "dist", "public", "assets")));

app.get("/", (req, res) => {
  const l = path.join(V2, "dist", "public", "landing.html");
  fs.existsSync(l) ? res.sendFile(l) : res.redirect("/#/dashboard");
});
app.get("/login", (req, res) => {
  const l = path.join(V2, "dist", "public", "login.html");
  fs.existsSync(l) ? res.sendFile(l) : res.status(404).send("Not found");
});
app.get("/login.html", (req, res) => res.redirect("/login"));
app.get("*", (req, res) => {
  const idx = path.join(V2, "dist", "public", "index.html");
  fs.existsSync(idx) ? res.sendFile(idx) : res.status(404).send("Not found");
});

app.listen(PORT, () => console.log("[dlbtrust-full] running on port " + PORT));
