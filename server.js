require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { Pool } = require("pg");

const app = express();
const PORT = 3000;

// -------------------------------------------------------------
// 1. Database Connection & Pooling Configuration
// -------------------------------------------------------------
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

pool.connect()
    .then(() => console.log("Connected to PostgreSQL ✅"))
    .catch(err => console.error("DB connection error ❌", err));

// -------------------------------------------------------------
// 2. Middleware & CORS Configuration
// -------------------------------------------------------------
// Force custom headers to prevent browser-based CORS blocks on localhost web builds
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, ngrok-skip-browser-warning");

    // Immediately clear preflight OPTIONS checks
    if (req.method === "OPTIONS") {
        return res.sendStatus(200);
    }
    next();
});

app.use(cors());
app.use(express.json());

// Initialize Multer memory storage (Fixes the "upload is not defined" error!)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// -------------------------------------------------------------
// 3. API Endpoints / Routes
// -------------------------------------------------------------

// Basic Server Health Route
app.get("/", (req, res) => {
    res.send("Server is running 🚀");
});

// POST /api/upload - Triggered by the React UI to upload shorts into PG
app.post("/api/upload", upload.single("file"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "No file was found in the request!" });
        }

        console.log("Success! Backend received file in memory:", req.file.originalname);
        const fileBuffer = req.file.buffer;

        // Inserting raw binary byte data directly into the 'reels' table
        const result = await pool.query(
            "INSERT INTO reels (title, filename, file_data) VALUES ($1, $2, $3) RETURNING id, title, filename",
            [req.file.originalname, req.file.originalname, fileBuffer]
        );

        res.status(200).json({
            message: "Success! The file has been instantly uploaded into your PostgreSQL database!",
            fileReceived: req.file.originalname,
            dbResult: result.rows[0]
        });

    } catch (err) {
        console.error("Upload route error:", err);
        res.status(500).json({ error: "Server error occurred during upload." });
    }
});

// GET /api/reels - Triggered by Flutter to fetch the listing meta-data
app.get("/api/reels", async (req, res) => {
    try {
        // We grab the ID and titles but exclude the heavy file_data column to remain lightning fast
        const result = await pool.query("SELECT id, title, filename FROM reels ORDER BY id DESC");

        // Map data rows to include an absolute streaming route pointing back to our server via ngrok
        const reelsWithUrls = result.rows.map(reel => ({
            id: reel.id,
            title: reel.title,
            filename: reel.filename,
            // Dynamic stream pointer used directly by the Flutter player engine
            videoUrl: `https://lisa-unevocable-undiscordantly.ngrok-free.dev/api/video/${reel.id}`
        }));

        res.json(reelsWithUrls);
    } catch (err) {
        console.error("Error fetching reels list:", err);
        res.status(500).json({ error: "Server Error fetching reels list" });
    }
});

// GET /api/video/:id - Supports HTTP Range streaming for browser compliance
app.get("/api/video/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query("SELECT file_data FROM reels WHERE id = $1", [id]);

        if (result.rows.length === 0) {
            return res.status(404).send("Video not found");
        }

        const videoBuffer = result.rows[0].file_data;
        const videoSize = videoBuffer.length;

        // Check if the browser is requesting a specific byte range (standard behavior)
        const range = req.headers.range;

        if (range) {
            // Parse out the exact chunk start and end boundaries requested by the player
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : videoSize - 1;

            // Safeguard boundaries
            if (start >= videoSize || end >= videoSize) {
                res.status(416).set("Content-Range", `bytes */${videoSize}`).send("Requested range not satisfiable");
                return;
            }

            const chunksize = (end - start) + 1;
            const chunk = videoBuffer.slice(start, end + 1);

            // HTTP 206 means "Partial Content" - exactly what the HTML5 engine expects
            res.writeHead(206, {
                "Content-Range": `bytes ${start}-${end}/${videoSize}`,
                "Accept-Ranges": "bytes",
                "Content-Length": chunksize,
                "Content-Type": "video/mp4",
                "Access-Control-Allow-Origin": "*",
            });

            res.end(chunk);
        } else {
            // Fallback: If no range is specified, deliver the whole file as standard HTTP 200
            res.writeHead(200, {
                "Content-Length": videoSize,
                "Content-Type": "video/mp4",
                "Accept-Ranges": "bytes",
                "Access-Control-Allow-Origin": "*",
            });
            res.end(videoBuffer);
        }
    } catch (err) {
        console.error("Error streaming video bytes:", err);
        res.status(500).send("Server Error streaming video");
    }
});

// -------------------------------------------------------------
// 4. Initialization Port Listener
// -------------------------------------------------------------
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT} 🚀`);
});