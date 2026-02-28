const express = require("express");
const http = require("http");
const multer = require("multer");
const sharp = require("sharp");
const axios = require("axios");
const cors = require("cors");
const path = require("path");

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ── ENV CONFIG ────────────────────────────────────────────────────
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO;        // "username/reponame"
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const CANVAS_SIZE   = parseInt(process.env.CANVAS_SIZE || "64");
const DRAWING_FILE  = "drawing.json";
const IMAGES_FOLDER = "images";

// ── CONFIG VALIDATION ────────────────────────────────────────────
function checkConfig() {
  const issues = [];
  if (!GITHUB_TOKEN) issues.push("GITHUB_TOKEN is not set in Render environment variables");
  if (!GITHUB_REPO)  issues.push("GITHUB_REPO is not set — should be 'yourusername/yourreponame'");
  return issues;
}

// ── VERIFY GITHUB REPO ACCESS ────────────────────────────────────
async function verifyGitHubAccess() {
  const res = await axios.get(
    `https://api.github.com/repos/${GITHUB_REPO}`,
    {
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
      },
    }
  );
  return res.data;
}

// ── GITHUB FILE HELPERS ───────────────────────────────────────────
async function getFileSha(filePath) {
  try {
    const res = await axios.get(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`,
      {
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
        },
        params: { ref: GITHUB_BRANCH },
      }
    );
    return res.data.sha;
  } catch { return null; }
}

async function writeFileToGitHub(filePath, base64Content, commitMessage) {
  const sha = await getFileSha(filePath);
  await axios.put(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`,
    {
      message: commitMessage,
      content: base64Content,
      branch: GITHUB_BRANCH,
      ...(sha ? { sha } : {}),
    },
    {
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
      },
    }
  );
}

// ── IMAGE → PIXELS ───────────────────────────────────────────────
async function imageToPixels(buffer) {
  const { data, info } = await sharp(buffer)
    .resize(CANVAS_SIZE, CANVAS_SIZE, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = [];
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a < 10) continue;
      pixels.push({ x: x + 1, y: y + 1, r, g, b });
    }
  }
  return pixels;
}

// ── SAVE drawing.json ─────────────────────────────────────────────
async function saveDrawingJson(pixels, meta = {}) {
  const payload = {
    meta: {
      canvasSize: CANVAS_SIZE,
      totalPixels: pixels.length,
      updatedAt: new Date().toISOString(),
      ...meta,
    },
    pixels,
  };
  await writeFileToGitHub(
    DRAWING_FILE,
    Buffer.from(JSON.stringify(payload, null, 2)).toString("base64"),
    `Update drawing — ${pixels.length} pixels from ${meta.filename || "unknown"}`
  );
}

// ── SAVE ORIGINAL IMAGE to images/ ───────────────────────────────
async function saveImageToRepo(buffer, filename) {
  const safe = filename.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9._-]/g, "");
  const filePath = `${IMAGES_FOLDER}/${safe}`;
  await writeFileToGitHub(filePath, buffer.toString("base64"), `Add image: ${safe}`);
  return {
    filename: safe,
    path: filePath,
    rawUrl: `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${filePath}`,
  };
}

// ── LIST IMAGES ───────────────────────────────────────────────────
async function listImages() {
  try {
    const res = await axios.get(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${IMAGES_FOLDER}`,
      {
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
        },
        params: { ref: GITHUB_BRANCH },
      }
    );
    return res.data.filter(f => f.type === "file").map(f => ({
      name: f.name,
      path: f.path,
      size: f.size,
      rawUrl: f.download_url,
      sha: f.sha,
    }));
  } catch { return []; }
}

// ── GITHUB ERROR HELPER ───────────────────────────────────────────
function githubErrMessage(err) {
  const status = err.response?.status;
  if (status === 404) return `Repo "${GITHUB_REPO}" not found. Check GITHUB_REPO is set to "username/reponame" in Render env vars.`;
  if (status === 401) return "GitHub token is invalid or expired. Regenerate it at github.com/settings/tokens";
  if (status === 403) return "GitHub token doesn't have write access. Make sure it has 'repo' scope selected.";
  return err.response?.data?.message || err.message;
}

// ════════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════════

// Config check — called by frontend on load
app.get("/config-check", async (req, res) => {
  const issues = checkConfig();
  if (issues.length > 0) {
    return res.json({ ok: false, issues });
  }
  try {
    const repo = await verifyGitHubAccess();
    res.json({
      ok: true,
      repo: GITHUB_REPO,
      branch: GITHUB_BRANCH,
      canvasSize: CANVAS_SIZE,
      repoPrivate: repo.private,
      drawingUrl: `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${DRAWING_FILE}`,
    });
  } catch (err) {
    res.json({ ok: false, issues: [githubErrMessage(err)] });
  }
});

// Upload new image → save to images/ AND convert to drawing.json
app.post("/upload", upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No image provided" });

  const configIssues = checkConfig();
  if (configIssues.length > 0) {
    return res.status(500).json({
      error: "Server not configured. " + configIssues.join(" | "),
      fix: "Render dashboard → your service → Environment → add the missing vars, then redeploy."
    });
  }

  // Verify GitHub access before doing expensive work
  try {
    await verifyGitHubAccess();
  } catch (err) {
    return res.status(500).json({ error: githubErrMessage(err) });
  }

  try {
    console.log(`📸 Uploading: ${req.file.originalname}`);
    const imageInfo = await saveImageToRepo(req.file.buffer, req.file.originalname);
    console.log(`🗂️  Saved to: ${imageInfo.path}`);

    const pixels = await imageToPixels(req.file.buffer);
    console.log(`🎨 Converted: ${pixels.length} pixels`);

    await saveDrawingJson(pixels, { filename: imageInfo.filename, imageUrl: imageInfo.rawUrl });
    console.log(`✅ drawing.json updated`);

    res.json({
      success: true,
      image: imageInfo,
      totalPixels: pixels.length,
      canvasSize: CANVAS_SIZE,
      drawingUrl: `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${DRAWING_FILE}`,
    });
  } catch (err) {
    console.error("❌", err.response?.data || err.message);
    res.status(500).json({ error: githubErrMessage(err) });
  }
});

// Use a saved image → re-convert to drawing.json
app.post("/use-image", async (req, res) => {
  const { rawUrl, filename } = req.body;
  if (!rawUrl) return res.status(400).json({ error: "rawUrl required" });
  try {
    const imgRes = await axios.get(rawUrl, { responseType: "arraybuffer" });
    const pixels = await imageToPixels(Buffer.from(imgRes.data));
    await saveDrawingJson(pixels, { filename, imageUrl: rawUrl });
    res.json({
      success: true,
      filename,
      totalPixels: pixels.length,
      canvasSize: CANVAS_SIZE,
      drawingUrl: `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${DRAWING_FILE}`,
    });
  } catch (err) {
    res.status(500).json({ error: githubErrMessage(err) });
  }
});

// List all saved images
app.get("/images", async (req, res) => {
  try {
    res.json({ images: await listImages() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a saved image
app.delete("/images/:filename", async (req, res) => {
  try {
    const filePath = `${IMAGES_FOLDER}/${req.params.filename}`;
    const sha = await getFileSha(filePath);
    if (!sha) return res.status(404).json({ error: "File not found" });
    await axios.delete(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`,
      {
        data: { message: `Delete: ${req.params.filename}`, sha, branch: GITHUB_BRANCH },
        headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" },
      }
    );
    res.json({ success: true, deleted: req.params.filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/status", (_, res) => res.json({
  status: "running",
  configured: checkConfig().length === 0,
  repo: GITHUB_REPO || "NOT SET",
  canvasSize: CANVAS_SIZE,
}));

app.get("/", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 Server on port ${PORT}`);
  const issues = checkConfig();
  if (issues.length > 0) {
    console.log("⚠️  CONFIG ISSUES:");
    issues.forEach(i => console.log("   ❌", i));
    console.log("   → Fix in Render dashboard → Environment\n");
  } else {
    console.log(`✅ Repo: ${GITHUB_REPO} | Branch: ${GITHUB_BRANCH} | Canvas: ${CANVAS_SIZE}×${CANVAS_SIZE}\n`);
  }
});
