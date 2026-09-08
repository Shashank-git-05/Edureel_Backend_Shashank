require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

// -------------------------------------------------------------
// 1. Database Connection & Pooling Configuration
// -------------------------------------------------------------
const isCloudDb = Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== "");

if (isCloudDb) {
    try {
        const parsedUrl = new URL(process.env.DATABASE_URL);
        console.log(`DATABASE_URL present: true`);
        console.log(`DB username: ${parsedUrl.username}`);
        console.log(`DB host: ${parsedUrl.hostname}`);
        console.log(`DB port: ${parsedUrl.port || 5432}`);
        console.log(`DB name: ${parsedUrl.pathname.replace(/^\//, "")}`);
    } catch (parseErr) {
        console.log(`DATABASE_URL present: true (URL parse error)`);
    }
} else {
    console.log(`DATABASE_URL present: false`);
}

const poolConfig = isCloudDb
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 10, // Max clients in pool, optimal for Supabase Free tier
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    }
    : {
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        password: process.env.DB_PASSWORD,
        port: process.env.DB_PORT,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    };

const pool = new Pool(poolConfig);

pool.on("error", (err) => {
    console.error("Unexpected database pool error ⚠️", err);
});

pool.connect()
    .then(client => {
        console.log(`Connected to PostgreSQL (${isCloudDb ? "Supabase Cloud ☁️" : "Local Database 💻"}) ✅`);
        client.release();
    })
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

// POST /api/notes/upload - Triggered by React UI to upload lecture notes into PostgreSQL 'notes' table
app.post("/api/notes/upload", upload.single("file"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "No file was found in the request!" });
        }

        const title = req.body.title || req.file.originalname;
        const fileBuffer = req.file.buffer;

        console.log("Uploading note into PG 'notes' table:", title);

        // Inserting title and bytea file into 'notes' table
        const result = await pool.query(
            "INSERT INTO notes (title, file) VALUES ($1, $2) RETURNING id, title",
            [title, fileBuffer]
        );

        const documentId = result.rows[0].id;

        // --- RAG API Integration ---
        // We check if the RAG_API_URL is set in the environment variables (e.g. his Ngrok URL)
        const ragApiUrl = process.env.RAG_API_URL;
        let ragStatus = "Not configured";

        if (ragApiUrl) {
            console.log(`Forwarding document ID ${documentId} to RAG API at ${ragApiUrl}...`);
            try {
                const formData = new FormData();

                // Convert the buffer to a Blob for native fetch FormData
                const fileBlob = new Blob([req.file.buffer], { type: req.file.mimetype });
                formData.append("file", fileBlob, req.file.originalname);

                formData.append("document_id", documentId.toString());

                // If the frontend sends course_id and user_id, use them, otherwise use placeholders
                formData.append("course_id", req.body.course_id || "default_course");
                formData.append("user_id", req.body.user_id || "default_user");

                const ragResponse = await fetch(`${ragApiUrl}/api/v1/documents/upload`, {
                    method: "POST",
                    body: formData
                });

                if (ragResponse.ok) {
                    console.log("✅ Successfully forwarded to RAG API.");
                    ragStatus = "Success";
                } else {
                    console.error("❌ RAG API responded with error:", ragResponse.status);
                    ragStatus = "Failed API Response";
                }
            } catch (ragErr) {
                console.error("❌ Error communicating with RAG API:", ragErr.message);
                ragStatus = "Connection Error";
            }
        } else {
            console.log("⚠️ RAG_API_URL not set in .env. Skipping RAG integration.");
        }

        res.status(200).json({
            message: "Success! Note uploaded to PostgreSQL notes table.",
            id: documentId,
            title: result.rows[0].title ? result.rows[0].title.trim() : title,
            filename: req.file.originalname,
            size: req.file.size,
            rag_status: ragStatus // Let the frontend know if RAG indexing succeeded
        });
    } catch (err) {
        console.error("Notes upload route error:", err);
        res.status(500).json({ error: "Server error occurred during note upload." });
    }
});

// GET /api/notes - Fetch list of uploaded notes
app.get("/api/notes", async (req, res) => {
    try {
        const result = await pool.query("SELECT id, title FROM notes ORDER BY id DESC");
        const formattedNotes = result.rows.map(row => ({
            id: row.id,
            title: row.title ? row.title.trim() : `Note #${row.id}`
        }));
        res.json(formattedNotes);
    } catch (err) {
        console.error("Error fetching notes list:", err);
        res.status(500).json({ error: "Server Error fetching notes list" });
    }
});

// GET /api/notes/:id/file - Download or view note file
app.get("/api/notes/:id/file", async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query("SELECT title, file FROM notes WHERE id = $1", [id]);

        if (result.rows.length === 0 || !result.rows[0].file) {
            return res.status(404).send("Note file not found");
        }

        const note = result.rows[0];
        const fileBuffer = note.file;

        res.setHeader("Content-Disposition", `inline; filename="${note.title ? note.title.trim() : 'note'}"`);
        res.setHeader("Content-Type", "application/octet-stream");
        res.send(fileBuffer);
    } catch (err) {
        console.error("Error fetching note file:", err);
        res.status(500).send("Server Error fetching note file");
    }
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

        const protocol = req.headers["x-forwarded-proto"] || req.protocol;
        const host = req.get("host");

        // Map data rows to include an absolute streaming route pointing back to our server
        const reelsWithUrls = result.rows.map(reel => ({
            id: reel.id,
            title: reel.title,
            filename: reel.filename,
            // Dynamic stream pointer used directly by the Flutter player engine
            videoUrl: `${protocol}://${host}/api/video/${reel.id}`
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
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT} 🚀`);
});