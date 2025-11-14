// server.js — Render Web Service

import express from "express";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Radiosondy upstream
const UPSTREAM =
  "https://radiosondy.info/export/export_search.php?csv=1&search_limit=200";

// Cache 30s
let cacheTime = 0;
let cacheData = null;
const CACHE_TTL = 30000;

// Express
const app = express();

// Serve frontend
app.use(express.static(__dirname));

// Proxy: /api/radiosondy
app.get("/api/radiosondy", async (req, res) => {
  const now = Date.now();

  // Cache HIT
  if (cacheData && now - cacheTime < CACHE_TTL) {
    res.setHeader("X-Proxy-Cache", "HIT");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.send(cacheData);
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 12000);

  try {
    const upstream = await fetch(UPSTREAM, { signal: controller.signal });
    clearTimeout(t);

    if (!upstream.ok) {
      if (cacheData) {
        res.setHeader("X-Proxy-Warn", "stale-cache");
        res.setHeader("Access-Control-Allow-Origin", "*");
        return res.send(cacheData);
      }
      return res.status(upstream.status).send("Upstream error");
    }

    const text = await upstream.text();

    cacheData = text;
    cacheTime = now;

    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.send(text);
  } catch (err) {
    clearTimeout(t);

    if (cacheData) {
      res.setHeader("X-Proxy-Warn", "stale-cache");
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.send(cacheData);
    }

    return res.status(504).send("Upstream timeout");
  }
});

// Fallback → index.html
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
