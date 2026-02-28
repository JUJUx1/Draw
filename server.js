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
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
});

// ── ENV CONFIG ──────────────────────────────────────────────────
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO  = process.env.GITHUB_REPO;   // "username/reponame"
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const GITHUB_FILE  = "drawing.json";
const CANVAS_SIZE  = parseInt(process.env.CANVAS_SIZE || "64"); // 64x64

// ── IMAGE → PIXEL ARRAY ─────────────────────────────────────────
// Roblox reads each pixel as { x, y, r, g, b }
// x and y are 1-based grid positions on the canvas
async function imageToPixels(buffer) {
  const { data, info } = await sharp(buffer)
    .resize(CANVAS_SIZE, CANVAS_SIZE, { fit: "fill" })
    .ensureAlpha()        // RGBA so we can check transparency
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = [];

  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 4; // 4 channels: RGBA
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];

      // Skip fully transparent pixels (saves space, Roblox leaves them blank)
      if (a < 10) continue;

      pixels.push({ x: x + 1, y: y + 1, r, g, b });
    }
  }

  return pixels;
}

// ── SAVE JSON TO GITHUB ─────────────────────────────────────────
async function saveToGitHub(pixels, meta = {}) {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`;

  const payload = {
    // meta lets Roblox know canvas size and pixel count upfront
    meta: {
      canvasSize: CANVAS_SIZE,
      totalPixels: pixels.length,
      updatedAt: new Date().toISOString(),
      ...meta,
    },
    pixels,
  };

  const content = Buffer.from(JSON.stringify(payload, null, 2)).toString("base64");

  // Need the file's current SHA to update it (GitHub API requirement)
  let sha;
  try {
    const existing = await axios.get(url, {
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
      },
      params: { ref: GITHUB_BRANCH },
    });
    sha = existing.data.sha;
  } catch {
    // File doesn't exist yet — first upload, no SHA needed
  }

  await axios.put(
    url,
    {
      message: `Update drawing — ${pixels.length} pixels`,
      content,
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

// ── UPLOAD ROUTE ────────────────────────────────────────────────
app.post("/upload", upload.single("image"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No image file provided" });
  }

  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    return res.status(500).json({ error: "Server not configured: missing GITHUB_TOKEN or GITHUB_REPO env vars" });
  }

  try {
    console.log(`📸 Processing image: ${req.file.originalname} (${req.file.size} bytes)`);

    const pixels = await imageToPixels(req.file.buffer);

    console.log(`🎨 Converted to ${pixels.length} pixels at ${CANVAS_SIZE}x${CANVAS_SIZE}`);

    await saveToGitHub(pixels, { filename: req.file.originalname });

    console.log(`✅ Saved to GitHub: ${GITHUB_REPO}/${GITHUB_FILE}`);

    res.json({
      success: true,
      totalPixels: pixels.length,
      canvasSize: CANVAS_SIZE,
      githubFile: `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${GITHUB_FILE}`,
      message: `Image converted to ${pixels.length} pixels and saved to GitHub`,
    });

  } catch (err) {
    console.error("❌ Error:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── STATUS ROUTE ─────────────────────────────────────────────────
app.get("/status", (_, res) => {
  res.json({
    status: "running",
    repo: GITHUB_REPO || "not configured",
    canvasSize: CANVAS_SIZE,
    file: GITHUB_FILE,
  });
});

// ── HOME ─────────────────────────────────────────────────────────
app.get("/", (_, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📦 Repo: ${GITHUB_REPO || "⚠️  Set GITHUB_REPO env var"}`);
  console.log(`🖼️  Canvas: ${CANVAS_SIZE}x${CANVAS_SIZE}`);
});
