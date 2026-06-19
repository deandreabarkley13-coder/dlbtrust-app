"use strict";
const HD = require("path").resolve(__dirname);
const express = require("express");
const path = require("path");
const fs = require("fs");
const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// V2 wealth management routes REMOVED — treasury system is the only platform now

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

// ACH Pipeline — NACHA generation + AS2 transmission
try { app.use("/api/ach-pipeline", require(HD + "/server/routes/achPipeline")); console.log("[ach-pipeline] loaded"); } catch(e) { console.warn("[ach-pipeline]", e.message); }

// AS2 Server — open source AS2 messaging
try { app.use("/api/as2", require(HD + "/server/routes/as2")); console.log("[as2] loaded"); } catch(e) { console.warn("[as2]", e.message); }

// Tax Engine — Form 1041 & K-1 generation
try { app.use("/api/tax", require(HD + "/server/routes/tax")); console.log("[tax] loaded"); } catch(e) { console.warn("[tax]", e.message); }

// Start live bond accrual scheduler
try {
  const { LiveBondEngine } = require(HD + "/server/integrations/bonds/liveEngine");
  LiveBondEngine.scheduleAccrualJob();
  console.log("[liveEngine] daily accrual scheduler started");
} catch(e) { console.warn("[liveEngine]", e.message); }

// Treasury Management System — serve dashboard at root, static files from public/
// Disable browser caching on HTML so deploys are picked up immediately
app.get("/", (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(HD, "public", "dashboard.html"));
});
app.get("/treasury", (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(HD, "public", "dashboard.html"));
});
app.use(express.static(path.join(HD, "public"), {
  etag: false,
  maxAge: 0,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));
app.get("*", (req, res) => {
  const idx = path.join(HD, "public", "index.html");
  fs.existsSync(idx) ? res.sendFile(idx) : res.status(404).send("Not found");
});

app.listen(PORT, () => console.log("[dlbtrust-full] running on port " + PORT));
