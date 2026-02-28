--[[
╔══════════════════════════════════════════════════════════════════╗
║           DrawFromGitHub.lua — Draw & Donate (17070253881)       ║
╠══════════════════════════════════════════════════════════════════╣
║  Fetches drawing.json from your GitHub repo and auto-draws it    ║
║  on the canvas using the game's own RemoteEvents.                ║
║                                                                  ║
║  INSTALL:                                                        ║
║    Studio → StarterPlayerScripts → LocalScript → paste this     ║
║                                                                  ║
║  REQUIRED:                                                       ║
║    Game Settings → Security → Allow HTTP Requests  ✓            ║
║                                                                  ║
║  CHANGE:                                                         ║
║    RAW_JSON_URL  →  your GitHub raw drawing.json URL             ║
╚══════════════════════════════════════════════════════════════════╝
--]]

-- ════════════════════════════════════════════════════════════════
-- ①  CONFIG  — only section you need to edit
-- ════════════════════════════════════════════════════════════════

local RAW_JSON_URL  = "https://raw.githubusercontent.com/JUJUx1/Draw/main/drawing.json"
--  ^ get this URL from the web upload page after uploading an image

local POLL_INTERVAL = 10     -- seconds between checks for a new drawing
local BATCH_SIZE    = 5      -- pixels drawn per frame (higher = faster but may lag)
local TARGET_LAYER  = 1      -- canvas layer to draw on (1, 2, or 3)

-- ════════════════════════════════════════════════════════════════
-- ②  SERVICES
-- ════════════════════════════════════════════════════════════════

local HttpService       = game:GetService("HttpService")
local RunService        = game:GetService("RunService")
local Players           = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local TweenService      = game:GetService("TweenService")

local player    = Players.LocalPlayer
local playerGui = player:WaitForChild("PlayerGui")

-- ════════════════════════════════════════════════════════════════
-- ③  STATUS GUI  — floating overlay so you can see progress
-- ════════════════════════════════════════════════════════════════

local function buildStatusGui()
    local sg = Instance.new("ScreenGui")
    sg.Name = "DrawStatus"
    sg.ResetOnSpawn = false
    sg.DisplayOrder = 999
    sg.Parent = playerGui

    -- Background pill
    local bg = Instance.new("Frame")
    bg.Size = UDim2.new(0, 260, 0, 72)
    bg.Position = UDim2.new(1, -270, 0, 12)
    bg.BackgroundColor3 = Color3.fromRGB(15, 12, 30)
    bg.BackgroundTransparency = 0.1
    bg.BorderSizePixel = 0
    bg.Parent = sg
    Instance.new("UICorner", bg).CornerRadius = UDim.new(0, 10)
    local stroke = Instance.new("UIStroke", bg)
    stroke.Color = Color3.fromRGB(120, 80, 220)
    stroke.Thickness = 1.5

    -- Title
    local title = Instance.new("TextLabel")
    title.Size = UDim2.new(1, -12, 0, 20)
    title.Position = UDim2.new(0, 10, 0, 6)
    title.BackgroundTransparency = 1
    title.Font = Enum.Font.GothamBold
    title.TextSize = 12
    title.TextColor3 = Color3.fromRGB(180, 140, 255)
    title.TextXAlignment = Enum.TextXAlignment.Left
    title.Text = "🎨 DrawFromGitHub"
    title.Parent = bg

    -- Status text
    local status = Instance.new("TextLabel")
    status.Size = UDim2.new(1, -12, 0, 16)
    status.Position = UDim2.new(0, 10, 0, 26)
    status.BackgroundTransparency = 1
    status.Font = Enum.Font.Gotham
    status.TextSize = 11
    status.TextColor3 = Color3.fromRGB(160, 160, 160)
    status.TextXAlignment = Enum.TextXAlignment.Left
    status.Text = "Waiting for drawing..."
    status.Parent = bg

    -- Progress bar background
    local barBg = Instance.new("Frame")
    barBg.Size = UDim2.new(1, -20, 0, 6)
    barBg.Position = UDim2.new(0, 10, 0, 52)
    barBg.BackgroundColor3 = Color3.fromRGB(30, 20, 50)
    barBg.BorderSizePixel = 0
    barBg.Parent = bg
    Instance.new("UICorner", barBg).CornerRadius = UDim.new(1, 0)

    -- Progress bar fill
    local bar = Instance.new("Frame")
    bar.Size = UDim2.new(0, 0, 1, 0)
    bar.BackgroundColor3 = Color3.fromRGB(140, 80, 255)
    bar.BorderSizePixel = 0
    bar.Parent = barBg
    Instance.new("UICorner", bar).CornerRadius = UDim.new(1, 0)

    return { status = status, bar = bar }
end

local UI = buildStatusGui()

local function setStatus(text, color)
    UI.status.Text = text
    UI.status.TextColor3 = color or Color3.fromRGB(160, 160, 160)
end

local function setProgress(fraction)
    TweenService:Create(
        UI.bar,
        TweenInfo.new(0.2, Enum.EasingStyle.Quad),
        { Size = UDim2.new(math.clamp(fraction, 0, 1), 0, 1, 0) }
    ):Play()
end

-- ════════════════════════════════════════════════════════════════
-- ④  RESOLVE GAME REMOTE EVENTS
--    Paths confirmed from the game's Developer Console (images you shared)
-- ════════════════════════════════════════════════════════════════

local MainGameEvents = ReplicatedStorage:WaitForChild("MainGameEvents", 15)
local DataFolder     = ReplicatedStorage:WaitForChild("DataFolder", 15)

local ReplicateCanvas = nil   -- fires pixels onto the canvas
local ChangeSetting   = nil   -- sets brush colour
local UpdateBoard     = nil   -- refreshes the gallery board after drawing

if MainGameEvents then
    ReplicateCanvas = MainGameEvents:WaitForChild("ReplicateCanvas", 10)
    UpdateBoard     = MainGameEvents:FindFirstChild("UpdateBoard")
end

if DataFolder then
    local Edits = DataFolder:FindFirstChild("Edits")
    if Edits then
        ChangeSetting = Edits:FindFirstChild("ChangeSetting")
    end
end

print("────────────────────────────────────────")
print("🔌 DrawFromGitHub — Remote Events")
print("  ReplicateCanvas :", ReplicateCanvas and "✅ Found" or "❌ MISSING")
print("  ChangeSetting   :", ChangeSetting   and "✅ Found" or "⚠️  Not found")
print("  UpdateBoard     :", UpdateBoard     and "✅ Found" or "⚠️  Not found")
print("────────────────────────────────────────")

if not ReplicateCanvas then
    setStatus("❌ ReplicateCanvas missing!", Color3.fromRGB(255, 80, 80))
    error("[DrawFromGitHub] ReplicateCanvas remote not found. Are you in the right game?")
end

-- ════════════════════════════════════════════════════════════════
-- ⑤  COLOUR HELPER
-- ════════════════════════════════════════════════════════════════

local lastColor = nil

local function setColor(r, g, b)
    local c = Color3.fromRGB(r, g, b)
    if c == lastColor then return end
    lastColor = c
    if ChangeSetting then
        pcall(function() ChangeSetting:FireServer("Color", c) end)
        pcall(function() ChangeSetting:FireServer(c) end)
    end
end

-- ════════════════════════════════════════════════════════════════
-- ⑥  PIXEL SENDING
--    Tries bulk format first, falls back to single pixel
-- ════════════════════════════════════════════════════════════════

local function sendBulk(batch)
    local formatted = {}
    for _, p in ipairs(batch) do
        table.insert(formatted, {
            X     = p.x,
            Y     = p.y,
            Color = Color3.fromRGB(p.r, p.g, p.b),
            Layer = TARGET_LAYER,
        })
    end
    -- Try both common argument orders
    local ok = pcall(function()
        ReplicateCanvas:FireServer(TARGET_LAYER, formatted)
    end)
    if not ok then
        pcall(function()
            ReplicateCanvas:FireServer(formatted, TARGET_LAYER)
        end)
    end
end

-- ════════════════════════════════════════════════════════════════
-- ⑦  DRAW STATE & HEARTBEAT LOOP
-- ════════════════════════════════════════════════════════════════

local drawConnection = nil
local isDrawing      = false
local lastTimestamp  = ""

local function stopDrawing()
    if drawConnection then
        drawConnection:Disconnect()
        drawConnection = nil
    end
    isDrawing = false
end

local function startDrawing(pixels, meta)
    stopDrawing()
    isDrawing = true

    local total      = #pixels
    local canvasSize = (meta and meta.canvasSize) or 64
    local imgName    = (meta and meta.filename) or "image"
    local index      = 1

    print(string.format(
        "🎨 Drawing: '%s' | %d pixels | %d×%d | Layer %d | %d px/frame",
        imgName, total, canvasSize, canvasSize, TARGET_LAYER, BATCH_SIZE
    ))

    setStatus(string.format("Drawing %s…  0%%", imgName), Color3.fromRGB(180, 140, 255))
    setProgress(0)

    drawConnection = RunService.Heartbeat:Connect(function()
        if index > total then
            -- ✅ Finished
            drawConnection:Disconnect()
            drawConnection = nil
            isDrawing = false

            setStatus("✅ Done! " .. total .. " pixels placed", Color3.fromRGB(80, 220, 120))
            setProgress(1)

            if UpdateBoard then
                task.delay(0.5, function()
                    pcall(function() UpdateBoard:FireServer() end)
                end)
            end

            print("✅ Drawing complete — " .. total .. " pixels sent.")
            return
        end

        -- Build this frame's batch
        local batch = {}
        for _ = 1, BATCH_SIZE do
            if index > total then break end
            table.insert(batch, pixels[index])
            index += 1
        end

        sendBulk(batch)

        -- Update status UI every 50 pixels
        if index % 50 == 0 or index >= total then
            local pct = math.min(index, total) / total
            setProgress(pct)
            setStatus(
                string.format("Drawing %s…  %d%%", imgName, math.floor(pct * 100)),
                Color3.fromRGB(180, 140, 255)
            )
        end
    end)
end

-- ════════════════════════════════════════════════════════════════
-- ⑧  FETCH drawing.json FROM GITHUB & CHECK FOR CHANGES
-- ════════════════════════════════════════════════════════════════

local function fetchAndDraw()
    setStatus("🔄 Checking GitHub…", Color3.fromRGB(120, 180, 255))

    -- Cache-bust so GitHub CDN always returns the latest file
    local url = RAW_JSON_URL .. "?t=" .. math.floor(tick())

    local fetchOk, raw = pcall(function()
        return HttpService:GetAsync(url, true)
    end)

    if not fetchOk then
        setStatus("❌ Fetch failed — check HTTP setting", Color3.fromRGB(255, 80, 80))
        warn("[DrawFromGitHub] HTTP failed:", raw)
        return
    end

    local parseOk, data = pcall(function()
        return HttpService:JSONDecode(raw)
    end)

    if not parseOk or type(data) ~= "table" or not data.pixels then
        setStatus("❌ Bad JSON from GitHub", Color3.fromRGB(255, 80, 80))
        warn("[DrawFromGitHub] JSON parse error or wrong format")
        return
    end

    local meta   = data.meta or {}
    local pixels = data.pixels

    -- Only redraw if drawing.json actually changed
    local stamp = tostring(meta.updatedAt or #pixels)
    if stamp == lastTimestamp then
        setStatus("✅ Up to date — polling…", Color3.fromRGB(100, 180, 100))
        return
    end
    lastTimestamp = stamp

    print(string.format(
        "[DrawFromGitHub] New drawing! pixels=%d size=%s×%s file=%s updated=%s",
        #pixels,
        tostring(meta.canvasSize or "?"),
        tostring(meta.canvasSize or "?"),
        meta.filename or "?",
        meta.updatedAt or "?"
    ))

    startDrawing(pixels, meta)
end

-- ════════════════════════════════════════════════════════════════
-- ⑨  MAIN — start polling
-- ════════════════════════════════════════════════════════════════

task.spawn(function()
    task.wait(2) -- let the game finish loading

    print("════════════════════════════════════════")
    print("🚀 DrawFromGitHub — started!")
    print("📡 URL    :", RAW_JSON_URL)
    print("⏱  Poll   :", POLL_INTERVAL, "seconds")
    print("⚡ Batch  :", BATCH_SIZE, "pixels/frame")
    print("🗂  Layer  :", TARGET_LAYER)
    print("════════════════════════════════════════")

    fetchAndDraw()

    while true do
        task.wait(POLL_INTERVAL)
        if not isDrawing then
            fetchAndDraw()
        end
    end
end)
