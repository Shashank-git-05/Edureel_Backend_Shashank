require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { Pool } = require("pg");
const { OAuth2Client } = require("google-auth-library");
const jwt = require("jsonwebtoken");

const GOOGLE_WEB_CLIENT_ID = process.env.GOOGLE_WEB_CLIENT_ID || "";
const JWT_SECRET = process.env.JWT_SECRET || "edureel_jwt_secret_key_2026_dev_mode";
const googleClient = new OAuth2Client(GOOGLE_WEB_CLIENT_ID);

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
        const category = req.body.category || "General";
        const durationSeconds = parseFloat(req.body.duration_seconds || req.body.durationSeconds || 0);

        const result = await pool.query(
            "INSERT INTO reels (title, filename, file_data, category, duration_seconds) VALUES ($1, $2, $3, $4, $5) RETURNING id, title, filename, category, duration_seconds",
            [req.file.originalname, req.file.originalname, fileBuffer, category, durationSeconds]
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
        const result = await pool.query("SELECT id, title, filename, category, duration_seconds FROM reels ORDER BY id DESC");

        const protocol = req.headers["x-forwarded-proto"] || req.protocol;
        const host = req.get("host");

        const reelsWithUrls = result.rows.map(reel => ({
            id: reel.id,
            title: reel.title,
            filename: reel.filename,
            category: reel.category || "General",
            durationSeconds: parseFloat(reel.duration_seconds || 0),
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

// JWT Authentication Middleware verifying Bearer Token
const requireAuth = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.substring(7);
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            req.user = { id: decoded.id, googleId: decoded.googleId, email: decoded.email };
            return next();
        } catch (err) {
            return res.status(401).json({
                error: "Unauthorized access",
                message: "Invalid or expired JWT token."
            });
        }
    }

    // Support X-User-Id header for fast development/manual testing fallback
    const devUserId = req.headers["x-user-id"];
    if (devUserId) {
        req.user = { id: parseInt(devUserId, 10) };
        return next();
    }

    return res.status(401).json({
        error: "Unauthorized access",
        message: "Authentication required. Pass Authorization header: Bearer <accessToken>."
    });
};

// =============================================================
// GOOGLE OAUTH AUTHENTICATION ROUTE
// =============================================================

// POST /api/auth/google - Authenticate Flutter client with Google ID Token
app.post("/api/auth/google", async (req, res) => {
    try {
        const { idToken } = req.body;

        if (!idToken) {
            return res.status(400).json({ error: "Missing required parameter: idToken" });
        }

        let payload;
        // Verify Google ID token against Google OAuth API & Audience
        try {
            const ticket = await googleClient.verifyIdToken({
                idToken: idToken,
                audience: GOOGLE_WEB_CLIENT_ID || undefined
            });
            payload = ticket.getPayload();
        } catch (verifyErr) {
            console.error("Google ID Token verification failed:", verifyErr.message);
            return res.status(401).json({
                error: "Invalid Google ID Token",
                details: verifyErr.message
            });
        }

        if (!payload || !payload.sub) {
            return res.status(401).json({ error: "Invalid token payload: missing sub claim" });
        }

        const googleId = payload.sub;
        const name = payload.name || "EduReel User";
        const email = payload.email || `${googleId}@gmail.com`;
        const photoUrl = payload.picture || "";

        // Upsert user into PostgreSQL database
        const existingUserQuery = await pool.query(
            "SELECT id, google_id, name, email, profile_picture_url FROM users WHERE google_id = $1 OR email = $2 LIMIT 1",
            [googleId, email]
        );

        let user;
        if (existingUserQuery.rows.length > 0) {
            const dbUser = existingUserQuery.rows[0];
            const updateRes = await pool.query(
                `UPDATE users 
                 SET google_id = $1, name = $2, profile_picture_url = $3, last_login_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
                 WHERE id = $4 
                 RETURNING id, name, email, profile_picture_url`,
                [googleId, name, photoUrl, dbUser.id]
            );
            user = updateRes.rows[0];
        } else {
            const insertRes = await pool.query(
                `INSERT INTO users (google_id, name, email, profile_picture_url, last_login_at) 
                 VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP) 
                 RETURNING id, name, email, profile_picture_url`,
                [googleId, name, email, photoUrl]
            );
            user = insertRes.rows[0];
        }

        // Generate EduReel JWT accessToken
        const accessToken = jwt.sign(
            { id: user.id, googleId: googleId, email: user.email },
            JWT_SECRET,
            { expiresIn: "30d" }
        );

        res.status(200).json({
            accessToken: accessToken,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                photoUrl: user.profile_picture_url || photoUrl || ""
            }
        });

    } catch (err) {
        console.error("Error during Google auth route execution:", err);
        res.status(500).json({ error: "Server error during Google authentication" });
    }
});


// User Profile Route (Expects req.user context)
app.get("/api/users/me", requireAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const result = await pool.query("SELECT id, google_id, name, email, profile_picture_url, phone, institution, skills, created_at FROM users WHERE id = $1", [userId]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "User profile not found" });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error("Error fetching user profile:", err);
        res.status(500).json({ error: "Server error fetching user profile" });
    }
});

// GET /api/users/me/profile - Fetch structured user profile for Flutter app
app.get("/api/users/me/profile", requireAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const result = await pool.query(
            "SELECT id, name, phone, email, institution, skills FROM users WHERE id = $1",
            [userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "User profile not found" });
        }

        const user = result.rows[0];
        let skillsArray = [];
        if (Array.isArray(user.skills)) {
            skillsArray = user.skills;
        } else if (typeof user.skills === "string") {
            try {
                skillsArray = JSON.parse(user.skills);
            } catch (e) {
                skillsArray = [];
            }
        }

        res.status(200).json({
            profile: {
                id: user.id,
                name: user.name || "",
                phone: user.phone || null,
                email: user.email || "",
                institution: user.institution || null,
                skills: skillsArray
            }
        });
    } catch (err) {
        console.error("Error fetching user profile:", err);
        res.status(500).json({ error: "Server error fetching user profile" });
    }
});

// PUT /api/users/me/profile - Update authenticated user profile
app.put("/api/users/me/profile", requireAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        let { name, phone, email, institution, skills } = req.body;

        // Validations
        if (!name || typeof name !== "string" || name.trim() === "") {
            return res.status(400).json({ error: "Validation error: 'name' is required and cannot be empty." });
        }
        name = name.trim();

        if (!email || typeof email !== "string" || email.trim() === "") {
            return res.status(400).json({ error: "Validation error: 'email' is required and cannot be empty." });
        }
        email = email.trim();
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: "Validation error: 'email' must be a valid email address." });
        }

        if (phone !== undefined && phone !== null) {
            if (typeof phone !== "string") {
                return res.status(400).json({ error: "Validation error: 'phone' must be a string or null." });
            }
            phone = phone.trim() === "" ? null : phone.trim();
        } else {
            phone = null;
        }

        if (institution !== undefined && institution !== null) {
            if (typeof institution !== "string") {
                return res.status(400).json({ error: "Validation error: 'institution' must be a string or null." });
            }
            institution = institution.trim() === "" ? null : institution.trim();
        } else {
            institution = null;
        }

        if (skills !== undefined && skills !== null) {
            if (!Array.isArray(skills)) {
                return res.status(400).json({ error: "Validation error: 'skills' must be an array of strings." });
            }
            for (let i = 0; i < skills.length; i++) {
                if (typeof skills[i] !== "string") {
                    return res.status(400).json({ error: `Validation error: skills[${i}] must be a string.` });
                }
                skills[i] = skills[i].trim();
            }
        } else {
            skills = [];
        }

        const result = await pool.query(
            `UPDATE users 
             SET name = $1, email = $2, phone = $3, institution = $4, skills = $5::jsonb, updated_at = CURRENT_TIMESTAMP 
             WHERE id = $6 
             RETURNING id, name, phone, email, institution, skills`,
            [name, email, phone, institution, JSON.stringify(skills), userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "User profile not found" });
        }

        const updatedUser = result.rows[0];
        let skillsArray = [];
        if (Array.isArray(updatedUser.skills)) {
            skillsArray = updatedUser.skills;
        } else if (typeof updatedUser.skills === "string") {
            try {
                skillsArray = JSON.parse(updatedUser.skills);
            } catch (e) {
                skillsArray = [];
            }
        }

        res.status(200).json({
            profile: {
                id: updatedUser.id,
                name: updatedUser.name,
                phone: updatedUser.phone || null,
                email: updatedUser.email,
                institution: updatedUser.institution || null,
                skills: skillsArray
            }
        });
    } catch (err) {
        if (err.code === '23505') { // Unique constraint violation (email)
            return res.status(400).json({ error: "Validation error: email address is already in use by another account." });
        }
        console.error("Error updating user profile:", err);
        res.status(500).json({ error: "Server error updating user profile" });
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
// USER QUIZ ATTEMPTS & SCORE HISTORY ENDPOINTS
// =============================================================

// POST /api/quizzes/:id/submit - Submit quiz attempt & compute score atomically
app.post("/api/quizzes/:id/submit", requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
        const quizId = parseInt(req.params.id, 10);
        const userId = req.user.id;
        let rawAnswers = req.body.answers || req.body;

        console.log(`[Quiz Submit] User ${userId} submitting for Quiz ${quizId}. Payload:`, JSON.stringify(req.body));

        // Convert answers object { "qId": optId } into array if needed
        let answersArray = [];
        if (Array.isArray(rawAnswers)) {
            answersArray = rawAnswers;
        } else if (rawAnswers && typeof rawAnswers === "object") {
            answersArray = Object.entries(rawAnswers).map(([k, v]) => ({
                questionId: k,
                selectedOptionId: v
            }));
        }

        if (!answersArray || answersArray.length === 0) {
            return res.status(400).json({ error: "Invalid payload. Non-empty answers array or map is required." });
        }

        // Verify quiz exists
        const quizRes = await client.query("SELECT id, title FROM quizzes WHERE id = $1", [quizId]);
        if (quizRes.rows.length === 0) {
            return res.status(404).json({ error: `Quiz with id ${quizId} not found.` });
        }

        // Fetch all questions and options for this quiz
        const questionsRes = await client.query(
            "SELECT id, question_order FROM quiz_questions WHERE quiz_id = $1 ORDER BY question_order ASC, id ASC",
            [quizId]
        );
        const totalQuestions = questionsRes.rows.length;

        if (totalQuestions === 0) {
            return res.status(400).json({ error: "Quiz has no questions to evaluate." });
        }

        // Fetch all options per question for this quiz
        const optionsRes = await client.query(
            `SELECT id, question_id, option_text, is_correct 
             FROM quiz_options 
             WHERE question_id IN (SELECT id FROM quiz_questions WHERE quiz_id = $1)
             ORDER BY id ASC`,
            [quizId]
        );

        // Map options by question_id: qId -> Array of options
        const questionOptionsMap = {};
        const correctOptionsMap = {};

        optionsRes.rows.forEach(opt => {
            const qId = opt.question_id;
            if (!questionOptionsMap[qId]) questionOptionsMap[qId] = [];
            questionOptionsMap[qId].push(opt);
            if (opt.is_correct) {
                correctOptionsMap[qId] = opt.id;
            }
        });

        // Compute score & build results array
        let score = 0;
        const results = [];
        const answerSubmissions = [];

        answersArray.forEach(ans => {
            const qId = parseInt(ans.questionId || ans.question_id || ans.questionIdStr || ans.id, 10);
            let rawOpt = (ans.selectedOptionId !== undefined && ans.selectedOptionId !== null)
                ? ans.selectedOptionId
                : (ans.selected_option_id !== undefined && ans.selected_option_id !== null)
                    ? ans.selected_option_id
                    : (ans.optionId !== undefined && ans.optionId !== null)
                        ? ans.optionId
                        : (ans.option_id !== undefined && ans.option_id !== null)
                            ? ans.option_id
                            : ans.selectedOption || ans.selected_option || null;

            let selectedOptId = rawOpt !== null ? parseInt(rawOpt, 10) : null;
            const qOptions = questionOptionsMap[qId] || [];
            const correctOptId = correctOptionsMap[qId] || null;

            // Check if selectedOptId directly matches an option ID
            let matchedOption = qOptions.find(o => o.id === selectedOptId);

            // Fallback: If selectedOptId did not match any option ID, check if Flutter sent 0-based option index (0, 1, 2, 3)
            if (!matchedOption && selectedOptId !== null && selectedOptId >= 0 && selectedOptId < qOptions.length) {
                matchedOption = qOptions[selectedOptId];
                if (matchedOption) {
                    selectedOptId = matchedOption.id;
                }
            }

            const isCorrect = (matchedOption && matchedOption.id === correctOptId);

            if (isCorrect) score++;

            results.push({
                questionId: qId,
                selectedOptionId: selectedOptId,
                correctOptionId: correctOptId,
                isCorrect: isCorrect
            });

            answerSubmissions.push({
                questionId: qId,
                selectedOptionId: selectedOptId,
                isCorrect: isCorrect
            });
        });

        const percentage = parseFloat(((score / totalQuestions) * 100).toFixed(2));

        console.log(`[Quiz Submit Result] Quiz ${quizId}, User ${userId} -> Score: ${score}/${totalQuestions} (${percentage}%)`);

        await client.query("BEGIN");

        // Insert overall attempt
        const attemptRes = await client.query(
            `INSERT INTO user_quiz_attempts (user_id, quiz_id, score, total_questions, percentage)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, completed_at`,
            [userId, quizId, score, totalQuestions, percentage]
        );
        const attemptId = attemptRes.rows[0].id;

        // Insert individual question answers
        for (const item of answerSubmissions) {
            await client.query(
                `INSERT INTO user_quiz_answers (attempt_id, question_id, selected_option_id, is_correct)
                 VALUES ($1, $2, $3, $4)`,
                [attemptId, item.questionId, item.selectedOptionId, item.isCorrect]
            );
        }

        await client.query("COMMIT");

        res.status(201).json({
            message: "Quiz attempt submitted successfully",
            attemptId: attemptId,
            quizId: quizId,
            score: score,
            totalQuestions: totalQuestions,
            percentage: percentage,
            completedAt: attemptRes.rows[0].completed_at,
            results: results
        });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Error submitting quiz attempt:", err);
        res.status(500).json({ error: "Server error submitting quiz attempt" });
    } finally {
        client.release();
    }
});

// GET /api/users/me/quiz-attempts - Retrieve past quiz attempts for logged-in user
app.get("/api/users/me/quiz-attempts", requireAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const result = await pool.query(
            `SELECT uqa.id AS "attemptId", 
                    uqa.quiz_id AS "quizId", 
                    q.title AS "quizTitle", 
                    q.reel_id AS "reelId", 
                    uqa.score, 
                    uqa.total_questions AS "totalQuestions", 
                    uqa.percentage, 
                    uqa.completed_at AS "completedAt"
             FROM user_quiz_attempts uqa
             JOIN quizzes q ON uqa.quiz_id = q.id
             WHERE uqa.user_id = $1
             ORDER BY uqa.completed_at DESC`,
            [userId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error("Error fetching user quiz attempts:", err);
        res.status(500).json({ error: "Server error fetching quiz attempts" });
    }
});

// GET /api/users/me/quiz-attempts/:attemptId - Detailed breakdown of a specific attempt
app.get("/api/users/me/quiz-attempts/:attemptId", requireAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const attemptId = parseInt(req.params.attemptId, 10);

        // Fetch attempt metadata
        const attemptRes = await pool.query(
            `SELECT uqa.id AS "attemptId", 
                    uqa.quiz_id AS "quizId", 
                    q.title AS "quizTitle", 
                    q.description AS "quizDescription", 
                    q.reel_id AS "reelId", 
                    uqa.score, 
                    uqa.total_questions AS "totalQuestions", 
                    uqa.percentage, 
                    uqa.completed_at AS "completedAt"
             FROM user_quiz_attempts uqa
             JOIN quizzes q ON uqa.quiz_id = q.id
             WHERE uqa.id = $1 AND uqa.user_id = $2`,
            [attemptId, userId]
        );

        if (attemptRes.rows.length === 0) {
            return res.status(404).json({ error: "Quiz attempt not found." });
        }

        const attempt = attemptRes.rows[0];

        // Fetch question choices & options breakdown
        const answersRes = await pool.query(
            `SELECT uqa.question_id AS "questionId",
                    qq.question AS "questionText",
                    uqa.selected_option_id AS "selectedOptionId",
                    sel_opt.option_text AS "selectedOptionText",
                    corr_opt.id AS "correctOptionId",
                    corr_opt.option_text AS "correctOptionText",
                    uqa.is_correct AS "isCorrect"
             FROM user_quiz_answers uqa
             JOIN quiz_questions qq ON uqa.question_id = qq.id
             LEFT JOIN quiz_options sel_opt ON uqa.selected_option_id = sel_opt.id
             LEFT JOIN quiz_options corr_opt ON corr_opt.question_id = qq.id AND corr_opt.is_correct = TRUE
             WHERE uqa.attempt_id = $1
             ORDER BY qq.question_order ASC, qq.id ASC`,
            [attemptId]
        );

        attempt.answers = answersRes.rows;
        res.json(attempt);
    } catch (err) {
        console.error("Error fetching quiz attempt detail:", err);
        res.status(500).json({ error: "Server error fetching quiz attempt detail" });
    }
});

// =============================================================
// AI DOCUMENT & REEL SUMMARIES ENDPOINTS
// =============================================================

const saveSummaryHandler = async (req, res) => {
    try {
        const {
            reel_id, reelId,
            note_id, noteId,
            title,
            summary,
            bullets,
            source_chunks, sourceChunks
        } = req.body;

        const targetReelId = reel_id || reelId || null;
        const targetNoteId = note_id || noteId || null;
        const summaryTitle = title || "AI Document Summary";
        const summaryText = summary || "";

        const bulletsJson = JSON.stringify(bullets || []);
        const sourceChunksJson = JSON.stringify(source_chunks || sourceChunks || []);

        const result = await pool.query(
            `INSERT INTO summaries (reel_id, note_id, title, summary, bullets, source_chunks)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, reel_id AS "reelId", note_id AS "noteId", title, summary, bullets, source_chunks AS "sourceChunks", created_at AS "createdAt"`,
            [targetReelId, targetNoteId, summaryTitle, summaryText, bulletsJson, sourceChunksJson]
        );

        const saved = result.rows[0];

        res.status(201).json({
            message: "Summary saved successfully",
            summaryId: saved.id,
            summary: saved
        });
    } catch (err) {
        console.error("Error saving summary:", err);
        res.status(500).json({ error: "Server error saving summary" });
    }
};

// POST /api/summaries and POST /api/summary (React Summarizer frontend integration)
app.post("/api/summaries", saveSummaryHandler);
app.post("/api/summary", saveSummaryHandler);

// GET /api/summaries - Fetch all saved summaries
app.get("/api/summaries", async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, 
                    reel_id AS "reelId", 
                    note_id AS "noteId", 
                    title, 
                    summary, 
                    bullets, 
                    source_chunks AS "sourceChunks", 
                    created_at AS "createdAt" 
             FROM summaries 
             ORDER BY id DESC`
        );
        res.json(result.rows);
    } catch (err) {
        console.error("Error fetching summaries:", err);
        res.status(500).json({ error: "Server error fetching summaries" });
    }
});

// GET /api/summaries/:id - Fetch summary by ID
app.get("/api/summaries/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            `SELECT id, 
                    reel_id AS "reelId", 
                    note_id AS "noteId", 
                    title, 
                    summary, 
                    bullets, 
                    source_chunks AS "sourceChunks", 
                    created_at AS "createdAt" 
             FROM summaries 
             WHERE id = $1`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Summary not found" });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error("Error fetching summary detail:", err);
        res.status(500).json({ error: "Server error fetching summary detail" });
    }
});

// GET /api/notes/:id/summary - Fetch summary for a specific note
app.get("/api/notes/:id/summary", async (req, res) => {
    try {
        const noteId = req.params.id;
        const result = await pool.query(
            `SELECT id, 
                    reel_id AS "reelId", 
                    note_id AS "noteId", 
                    title, 
                    summary, 
                    bullets, 
                    source_chunks AS "sourceChunks", 
                    created_at AS "createdAt" 
             FROM summaries 
             WHERE note_id = $1 
             ORDER BY id DESC LIMIT 1`,
            [noteId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "No summary found for this note" });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error("Error fetching note summary:", err);
        res.status(500).json({ error: "Server error fetching note summary" });
    }
});

// =============================================================
// REEL WATCH TIME & CATEGORY METRICS ENDPOINTS
// =============================================================

// POST /api/reels/:id/watch - Record/Update user watch time & view count for a reel
app.post("/api/reels/:id/watch", requireAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const reelId = parseInt(req.params.id, 10);
        const watchTimeSeconds = parseFloat(req.body.watchTimeSeconds || req.body.watch_time_seconds || 0);
        const totalDurationSeconds = parseFloat(req.body.totalDurationSeconds || req.body.total_duration_seconds || 0);
        const isCompleted = Boolean(req.body.completed);

        // Fetch reel to verify existence and fallback total_duration if not supplied
        const reelRes = await pool.query("SELECT id, duration_seconds FROM reels WHERE id = $1", [reelId]);
        if (reelRes.rows.length === 0) {
            return res.status(404).json({ error: `Reel with id ${reelId} not found.` });
        }

        const actualDuration = totalDurationSeconds > 0 ? totalDurationSeconds : parseFloat(reelRes.rows[0].duration_seconds || 0);
        const completionRate = actualDuration > 0 ? Math.min(100.0, parseFloat(((watchTimeSeconds / actualDuration) * 100).toFixed(2))) : 0;
        const markCompleted = isCompleted || completionRate >= 90.0;

        // UPSERT into user_reel_metrics
        const result = await pool.query(
            `INSERT INTO user_reel_metrics (user_id, reel_id, watch_count, watch_time_seconds, total_duration_seconds, completion_rate, completed, last_watched_at)
             VALUES ($1, $2, 1, $3, $4, $5, $6, CURRENT_TIMESTAMP)
             ON CONFLICT (user_id, reel_id) DO UPDATE SET
                watch_count = user_reel_metrics.watch_count + 1,
                watch_time_seconds = GREATEST(user_reel_metrics.watch_time_seconds, EXCLUDED.watch_time_seconds),
                total_duration_seconds = GREATEST(user_reel_metrics.total_duration_seconds, EXCLUDED.total_duration_seconds),
                completion_rate = GREATEST(user_reel_metrics.completion_rate, EXCLUDED.completion_rate),
                completed = user_reel_metrics.completed OR EXCLUDED.completed,
                last_watched_at = CURRENT_TIMESTAMP
             RETURNING id, user_id AS "userId", reel_id AS "reelId", watch_count AS "watchCount", 
                       watch_time_seconds AS "watchTimeSeconds", total_duration_seconds AS "totalDurationSeconds",
                       completion_rate AS "completionRate", completed, last_watched_at AS "lastWatchedAt"`,
            [userId, reelId, watchTimeSeconds, actualDuration, completionRate, markCompleted]
        );

        res.status(200).json({
            message: "Watch metric recorded successfully",
            metric: result.rows[0]
        });
    } catch (err) {
        console.error("Error recording watch metric:", err);
        res.status(500).json({ error: "Server error recording watch metric" });
    }
});

// GET /api/users/me/watch-metrics - Get student watch time metrics, category breakdown, & history
app.get("/api/users/me/watch-metrics", requireAuth, async (req, res) => {
    try {
        const userId = req.user.id;

        // Aggregate overall watch time and reels watched count
        const summaryRes = await pool.query(
            `SELECT COALESCE(SUM(watch_time_seconds), 0) AS "totalWatchTimeSeconds",
                    COUNT(DISTINCT reel_id) AS "totalReelsWatched",
                    COALESCE(SUM(watch_count), 0) AS "totalViewEvents"
             FROM user_reel_metrics
             WHERE user_id = $1`,
            [userId]
        );

        // Category breakdown
        const categoryRes = await pool.query(
            `SELECT COALESCE(r.category, 'General') AS category,
                    COUNT(DISTINCT urm.reel_id) AS "reelsWatched",
                    COALESCE(SUM(urm.watch_time_seconds), 0) AS "totalWatchTimeSeconds",
                    COALESCE(SUM(urm.watch_count), 0) AS "totalViews"
             FROM user_reel_metrics urm
             JOIN reels r ON urm.reel_id = r.id
             WHERE urm.user_id = $1
             GROUP BY COALESCE(r.category, 'General')
             ORDER BY "totalWatchTimeSeconds" DESC`,
            [userId]
        );

        // Recent watch history list per reel
        const historyRes = await pool.query(
            `SELECT urm.reel_id AS "reelId",
                    r.title AS "reelTitle",
                    COALESCE(r.category, 'General') AS category,
                    urm.watch_count AS "watchCount",
                    urm.watch_time_seconds AS "watchTimeSeconds",
                    urm.total_duration_seconds AS "totalDurationSeconds",
                    urm.completion_rate AS "completionRate",
                    urm.completed,
                    urm.last_watched_at AS "lastWatchedAt"
             FROM user_reel_metrics urm
             JOIN reels r ON urm.reel_id = r.id
             WHERE urm.user_id = $1
             ORDER BY urm.last_watched_at DESC`,
            [userId]
        );

        res.json({
            totalWatchTimeSeconds: parseFloat(summaryRes.rows[0].totalWatchTimeSeconds),
            totalReelsWatched: parseInt(summaryRes.rows[0].totalReelsWatched, 10),
            totalViewEvents: parseInt(summaryRes.rows[0].totalViewEvents, 10),
            categoryBreakdown: categoryRes.rows.map(c => ({
                category: c.category,
                reelsWatched: parseInt(c.reelsWatched, 10),
                totalWatchTimeSeconds: parseFloat(c.totalWatchTimeSeconds),
                totalViews: parseInt(c.totalViews, 10)
            })),
            recentWatchHistory: historyRes.rows.map(h => ({
                ...h,
                watchTimeSeconds: parseFloat(h.watchTimeSeconds),
                totalDurationSeconds: parseFloat(h.totalDurationSeconds),
                completionRate: parseFloat(h.completionRate)
            }))
        });
    } catch (err) {
        console.error("Error fetching watch metrics:", err);
        res.status(500).json({ error: "Server error fetching watch metrics" });
    }
});

// GET /api/users/me/reels/:id/watch-metric - Specific reel watch metric
app.get("/api/users/me/reels/:id/watch-metric", requireAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const reelId = parseInt(req.params.id, 10);

        const result = await pool.query(
            `SELECT urm.reel_id AS "reelId",
                    r.title AS "reelTitle",
                    COALESCE(r.category, 'General') AS category,
                    urm.watch_count AS "watchCount",
                    urm.watch_time_seconds AS "watchTimeSeconds",
                    urm.total_duration_seconds AS "totalDurationSeconds",
                    urm.completion_rate AS "completionRate",
                    urm.completed,
                    urm.last_watched_at AS "lastWatchedAt"
             FROM user_reel_metrics urm
             JOIN reels r ON urm.reel_id = r.id
             WHERE urm.user_id = $1 AND urm.reel_id = $2`,
            [userId, reelId]
        );

        if (result.rows.length === 0) {
            return res.json({
                reelId: reelId,
                watchCount: 0,
                watchTimeSeconds: 0,
                totalDurationSeconds: 0,
                completionRate: 0,
                completed: false,
                lastWatchedAt: null
            });
        }

        const m = result.rows[0];
        res.json({
            ...m,
            watchTimeSeconds: parseFloat(m.watchTimeSeconds),
            totalDurationSeconds: parseFloat(m.totalDurationSeconds),
            completionRate: parseFloat(m.completionRate)
        });
    } catch (err) {
        console.error("Error fetching specific watch metric:", err);
        res.status(500).json({ error: "Server error fetching watch metric" });
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