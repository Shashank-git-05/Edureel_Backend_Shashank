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
const rawDbUrl = process.env.DATABASE_URL ? process.env.DATABASE_URL.trim() : "";
const isCloudDb = Boolean(rawDbUrl !== "");

if (isCloudDb) {
    try {
        const parsedUrl = new URL(rawDbUrl);
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

const localPoolConfig = {
    user: process.env.DB_USER || "postgres",
    host: process.env.DB_HOST || "localhost",
    database: process.env.DB_NAME || "edureel_db",
    password: process.env.DB_PASSWORD || "2705",
    port: process.env.DB_PORT || 5432,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
};

let pool = new Pool(
    isCloudDb
        ? {
            connectionString: rawDbUrl,
            ssl: { rejectUnauthorized: false },
            max: 10,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000,
        }
        : localPoolConfig
);

pool.on("error", (err) => {
    console.error("Unexpected database pool error ⚠️", err);
});

pool.connect()
    .then(client => {
        console.log(`Connected to PostgreSQL (${isCloudDb ? "Supabase Cloud ☁️" : "Local Database 💻"}) ✅`);
        client.release();
    })
    .catch(err => {
        console.error("Cloud DB connection failed. Falling back to Local PostgreSQL 💻...", err.message);
        pool = new Pool(localPoolConfig);
    });

// -------------------------------------------------------------
// 2. Middleware & CORS Configuration
// -------------------------------------------------------------
// Force custom headers to prevent browser-based CORS blocks on localhost web builds
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization, ngrok-skip-browser-warning");

    // Immediately clear preflight OPTIONS checks
    if (req.method === "OPTIONS") {
        return res.sendStatus(200);
    }
    next();
});

app.use(cors());
app.use(express.json());

// Initialize Multer memory storage
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// -------------------------------------------------------------
// 3. API Endpoints / Routes
// -------------------------------------------------------------

// Basic Server Health Route
app.get("/", (req, res) => {
    res.send("Server is running 🚀");
});

// =============================================================
// EXISTING ROUTES (UNCHANGED CONTRACTS)
// =============================================================

// POST /api/notes/upload - Triggered by React UI to upload lecture notes
app.post("/api/notes/upload", upload.single("file"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "No file was found in the request!" });
        }

        const title = req.body.title || req.file.originalname;
        const fileBuffer = req.file.buffer;

        console.log("Uploading note into PG 'notes' table:", title);

        const result = await pool.query(
            "INSERT INTO notes (title, file) VALUES ($1, $2) RETURNING id, title",
            [title, fileBuffer]
        );

        const documentId = result.rows[0].id;

        const ragApiUrl = process.env.RAG_API_URL;
        let ragStatus = "Not configured";

        if (ragApiUrl && !ragApiUrl.includes("ADD_YOUR_URL_HERE")) {
            console.log(`Forwarding document ID ${documentId} to RAG API at ${ragApiUrl}...`);
            try {
                const formData = new FormData();
                const fileBlob = new Blob([req.file.buffer], { type: req.file.mimetype });
                formData.append("file", fileBlob, req.file.originalname);
                formData.append("document_id", documentId.toString());
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
            console.log("⚠️ RAG_API_URL not set or default placeholder. Skipping RAG integration.");
        }

        res.status(200).json({
            message: "Success! Note uploaded to PostgreSQL notes table.",
            id: documentId,
            title: result.rows[0].title ? result.rows[0].title.trim() : title,
            filename: req.file.originalname,
            size: req.file.size,
            rag_status: ragStatus
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

// POST /api/upload - Triggered by React UI to upload shorts into PG
app.post("/api/upload", upload.single("file"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "No file was found in the request!" });
        }

        console.log("Success! Backend received file in memory:", req.file.originalname);
        const fileBuffer = req.file.buffer;

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
        const result = await pool.query("SELECT id, title, filename FROM reels ORDER BY id DESC");

        const protocol = req.headers["x-forwarded-proto"] || req.protocol;
        const host = req.get("host");

        const reelsWithUrls = result.rows.map(reel => ({
            id: reel.id,
            title: reel.title,
            filename: reel.filename,
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

        const range = req.headers.range;

        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : videoSize - 1;

            if (start >= videoSize || end >= videoSize) {
                res.status(416).set("Content-Range", `bytes */${videoSize}`).send("Requested range not satisfiable");
                return;
            }

            const chunksize = (end - start) + 1;
            const chunk = videoBuffer.slice(start, end + 1);

            res.writeHead(206, {
                "Content-Range": `bytes ${start}-${end}/${videoSize}`,
                "Accept-Ranges": "bytes",
                "Content-Length": chunksize,
                "Content-Type": "video/mp4",
                "Access-Control-Allow-Origin": "*",
            });

            res.end(chunk);
        } else {
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

// =============================================================
// PART 1 — QUIZ SYSTEM ROUTES
// =============================================================

// GET /api/quizzes - Fetch all available quizzes metadata
app.get("/api/quizzes", async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT id, reel_id AS \"reelId\", title, description, created_at FROM quizzes ORDER BY id DESC"
        );
        res.json(result.rows);
    } catch (err) {
        console.error("Error fetching quizzes list:", err);
        res.status(500).json({ error: "Server Error fetching quizzes" });
    }
});

// Helper function to assemble quiz response format
async function fetchQuizById(quizId, includeAnswers = false) {
    const quizRes = await pool.query(
        "SELECT id, reel_id AS \"reelId\", title, description, created_at FROM quizzes WHERE id = $1",
        [quizId]
    );

    if (quizRes.rows.length === 0) return null;
    const quiz = quizRes.rows[0];

    const questionsRes = await pool.query(
        "SELECT id, question, question_order FROM quiz_questions WHERE quiz_id = $1 ORDER BY question_order ASC, id ASC",
        [quizId]
    );

    const questions = [];
    for (const q of questionsRes.rows) {
        const optionsQuery = includeAnswers
            ? "SELECT id, option_text AS text, is_correct FROM quiz_options WHERE question_id = $1 ORDER BY id ASC"
            : "SELECT id, option_text AS text FROM quiz_options WHERE question_id = $1 ORDER BY id ASC";
        
        const optionsRes = await pool.query(optionsQuery, [q.id]);
        questions.push({
            id: q.id,
            question: q.question,
            options: optionsRes.rows
        });
    }

    return {
        id: quiz.id,
        title: quiz.title,
        description: quiz.description,
        reelId: quiz.reelId,
        questions: questions
    };
}

// GET /api/quizzes/:id - Fetch quiz for Flutter Mobile (Correct answers STRIPPED)
app.get("/api/quizzes/:id", async (req, res) => {
    try {
        const quiz = await fetchQuizById(req.params.id, false);
        if (!quiz) {
            return res.status(404).json({ error: "Quiz not found" });
        }
        res.json(quiz);
    } catch (err) {
        console.error("Error fetching quiz by ID:", err);
        res.status(500).json({ error: "Server Error fetching quiz details" });
    }
});

// GET /api/reels/:id/quiz - Fetch quiz associated with a specific reel for Flutter Mobile
app.get("/api/reels/:id/quiz", async (req, res) => {
    try {
        const reelId = req.params.id;
        const quizRes = await pool.query("SELECT id FROM quizzes WHERE reel_id = $1 ORDER BY id DESC LIMIT 1", [reelId]);
        
        if (quizRes.rows.length === 0) {
            return res.status(404).json({ error: "No quiz associated with this reel" });
        }

        const quiz = await fetchQuizById(quizRes.rows[0].id, false);
        res.json(quiz);
    } catch (err) {
        console.error("Error fetching reel quiz:", err);
        res.status(500).json({ error: "Server Error fetching reel quiz" });
    }
});

// POST /api/quizzes - Save a quiz with questions & options (Teacher App, ATOMIC TRANSACTION)
app.post("/api/quizzes", async (req, res) => {
    const client = await pool.connect();
    try {
        const { reelId, title, description, questions } = req.body;

        if (!reelId || !title || !Array.isArray(questions) || questions.length === 0) {
            return res.status(400).json({ error: "Invalid quiz payload. reelId, title, and non-empty questions array are required." });
        }

        // Verify that target reel exists
        const reelCheck = await client.query("SELECT id FROM reels WHERE id = $1", [reelId]);
        if (reelCheck.rows.length === 0) {
            return res.status(404).json({ error: `Reel with id ${reelId} does not exist.` });
        }

        await client.query("BEGIN");

        const quizRes = await client.query(
            "INSERT INTO quizzes (reel_id, title, description) VALUES ($1, $2, $3) RETURNING id, title, description, reel_id AS \"reelId\", created_at",
            [reelId, title, description || ""]
        );
        const quizId = quizRes.rows[0].id;

        for (let i = 0; i < questions.length; i++) {
            const q = questions[i];
            const qOrder = q.question_order || q.questionOrder || (i + 1);

            const qRes = await client.query(
                "INSERT INTO quiz_questions (quiz_id, question, question_order) VALUES ($1, $2, $3) RETURNING id",
                [quizId, q.question, qOrder]
            );
            const questionId = qRes.rows[0].id;

            if (Array.isArray(q.options)) {
                for (const opt of q.options) {
                    const optText = opt.text || opt.option_text;
                    const isCorrect = Boolean(opt.is_correct || opt.isCorrect);
                    await client.query(
                        "INSERT INTO quiz_options (question_id, option_text, is_correct) VALUES ($1, $2, $3)",
                        [questionId, optText, isCorrect]
                    );
                }
            }
        }

        await client.query("COMMIT");

        res.status(201).json({
            message: "Quiz created successfully!",
            quizId: quizId,
            title: title,
            reelId: reelId
        });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Atomic quiz insertion failed:", err);
        res.status(500).json({ error: "Failed to create quiz due to transaction error." });
    } finally {
        client.release();
    }
});

// =============================================================
// PART 2 — USER SYSTEM & RELATIONSHIPS
// =============================================================

// Mock auth middleware ready for Google OAuth / JWT token verification
const requireAuth = (req, res, next) => {
    // In production with Google OAuth / JWT, authentication middleware will decode token and set req.user
    if (!req.user || !req.user.id) {
        return res.status(401).json({
            error: "Unauthorized access",
            message: "Google OAuth authentication required. Client-provided user IDs are strictly disabled for security."
        });
    }
    next();
};

// User Profile Route (Expects req.user context)
app.get("/api/users/me", requireAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const result = await pool.query("SELECT id, google_id, name, email, profile_picture_url, created_at FROM users WHERE id = $1", [userId]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "User profile not found" });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error("Error fetching user profile:", err);
        res.status(500).json({ error: "Server error fetching user profile" });
    }
});

// GET Liked Reels (Expects req.user context)
app.get("/api/users/me/liked-reels", requireAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const result = await pool.query(
            `SELECT r.id, r.title, r.filename, rl.created_at AS "likedAt" 
             FROM reel_likes rl 
             JOIN reels r ON rl.reel_id = r.id 
             WHERE rl.user_id = $1 ORDER BY rl.created_at DESC`,
            [userId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error("Error fetching liked reels:", err);
        res.status(500).json({ error: "Server error fetching liked reels" });
    }
});

// GET Saved Reels (Expects req.user context)
app.get("/api/users/me/saved-reels", requireAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const result = await pool.query(
            `SELECT r.id, r.title, r.filename, rs.created_at AS "savedAt" 
             FROM reel_saves rs 
             JOIN reels r ON rs.reel_id = r.id 
             WHERE rs.user_id = $1 ORDER BY rs.created_at DESC`,
            [userId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error("Error fetching saved reels:", err);
        res.status(500).json({ error: "Server error fetching saved reels" });
    }
});

// POST Like Reel (Expects req.user context)
app.post("/api/reels/:id/like", requireAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const reelId = req.params.id;

        await pool.query(
            "INSERT INTO reel_likes (user_id, reel_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            [userId, reelId]
        );

        res.json({ message: "Reel liked successfully", reelId: parseInt(reelId, 10), userId: userId });
    } catch (err) {
        console.error("Error liking reel:", err);
        res.status(500).json({ error: "Server error liking reel" });
    }
});

// DELETE Unlike Reel (Expects req.user context)
app.delete("/api/reels/:id/like", requireAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const reelId = req.params.id;

        await pool.query("DELETE FROM reel_likes WHERE user_id = $1 AND reel_id = $2", [userId, reelId]);
        res.json({ message: "Reel unliked successfully", reelId: parseInt(reelId, 10) });
    } catch (err) {
        console.error("Error unliking reel:", err);
        res.status(500).json({ error: "Server error unliking reel" });
    }
});

// POST Save Reel (Expects req.user context)
app.post("/api/reels/:id/save", requireAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const reelId = req.params.id;

        await pool.query(
            "INSERT INTO reel_saves (user_id, reel_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            [userId, reelId]
        );

        res.json({ message: "Reel saved successfully", reelId: parseInt(reelId, 10), userId: userId });
    } catch (err) {
        console.error("Error saving reel:", err);
        res.status(500).json({ error: "Server error saving reel" });
    }
});

// DELETE Unsave Reel (Expects req.user context)
app.delete("/api/reels/:id/save", requireAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const reelId = req.params.id;

        await pool.query("DELETE FROM reel_saves WHERE user_id = $1 AND reel_id = $2", [userId, reelId]);
        res.json({ message: "Reel unsaved successfully", reelId: parseInt(reelId, 10) });
    } catch (err) {
        console.error("Error unsaving reel:", err);
        res.status(500).json({ error: "Server error unsaving reel" });
    }
});

// =============================================================
// DEV / TEST HELPER ENDPOINTS (ISOLATED DEVELOPMENT MECHANISM)
// =============================================================
app.post("/api/dev/test-user", async (req, res) => {
    try {
        const { name, email, google_id } = req.body;
        const userName = name || "Test Student";
        const userEmail = email || `test_${Date.now()}@edureel.com`;
        const gId = google_id || `google_${Date.now()}`;

        const result = await pool.query(
            `INSERT INTO users (name, email, google_id) 
             VALUES ($1, $2, $3) 
             ON CONFLICT (email) DO UPDATE SET last_login_at = CURRENT_TIMESTAMP 
             RETURNING id, name, email, google_id, created_at`,
            [userName, userEmail, gId]
        );

        res.json({
            message: "Development test user initialized successfully.",
            user: result.rows[0]
        });
    } catch (err) {
        console.error("Error creating dev test user:", err);
        res.status(500).json({ error: "Failed to create dev test user" });
    }
});

// -------------------------------------------------------------
// 4. Initialization Port Listener
// -------------------------------------------------------------
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT} 🚀`);
});