const { Pool } = require("pg");
require("dotenv").config();

// Check if DATABASE_URL is set and non-empty
const rawDbUrl = process.env.DATABASE_URL ? process.env.DATABASE_URL.trim() : "";
const isCloudDb = Boolean(rawDbUrl !== "");

const poolConfig = isCloudDb
    ? {
        connectionString: rawDbUrl,
        ssl: { rejectUnauthorized: false },
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    }
    : {
        user: process.env.DB_USER || "postgres",
        host: process.env.DB_HOST || "localhost",
        database: process.env.DB_NAME || "edureel_db",
        password: process.env.DB_PASSWORD || "2705",
        port: process.env.DB_PORT || 5432,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    };

const pool = new Pool(poolConfig);

async function run() {
    try {
        console.log(`Setting up EduReel database schema on (${isCloudDb ? "Cloud DB" : "Local DB"})...`);

        // Ensure legacy reels columns exist
        await pool.query("ALTER TABLE reels ADD COLUMN IF NOT EXISTS file_data BYTEA");
        await pool.query("ALTER TABLE reels ADD COLUMN IF NOT EXISTS filename TEXT");
        await pool.query("ALTER TABLE reels ADD COLUMN IF NOT EXISTS category VARCHAR(255) DEFAULT 'General'");
        await pool.query("ALTER TABLE reels ADD COLUMN IF NOT EXISTS duration_seconds NUMERIC(10, 2) DEFAULT 0");

        // Ensure user profile columns exist
        await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50)");
        await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS institution VARCHAR(255)");
        await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS skills JSONB DEFAULT '[]'::jsonb");

        // 1. Users Table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                google_id VARCHAR(255) UNIQUE,
                name VARCHAR(255) NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                profile_picture_url TEXT,
                phone VARCHAR(50),
                institution VARCHAR(255),
                skills JSONB DEFAULT '[]'::jsonb,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                last_login_at TIMESTAMP WITH TIME ZONE
            );
        `);


        // 2. Quizzes Table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS quizzes (
                id SERIAL PRIMARY KEY,
                reel_id INTEGER NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
                title VARCHAR(255) NOT NULL,
                description TEXT,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 3. Quiz Questions Table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS quiz_questions (
                id SERIAL PRIMARY KEY,
                quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
                question TEXT NOT NULL,
                question_order INTEGER NOT NULL DEFAULT 1,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 4. Quiz Options Table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS quiz_options (
                id SERIAL PRIMARY KEY,
                question_id INTEGER NOT NULL REFERENCES quiz_questions(id) ON DELETE CASCADE,
                option_text TEXT NOT NULL,
                is_correct BOOLEAN NOT NULL DEFAULT FALSE
            );
        `);

        // 5. Reel Likes Table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS reel_likes (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                reel_id INTEGER NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, reel_id)
            );
        `);

        // 6. Reel Saves Table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS reel_saves (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                reel_id INTEGER NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, reel_id)
            );
        `);

        // 7. User Quiz Attempts Table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_quiz_attempts (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
                score INTEGER NOT NULL,
                total_questions INTEGER NOT NULL,
                percentage NUMERIC(5, 2) NOT NULL,
                completed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 8. User Quiz Answers Table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_quiz_answers (
                id SERIAL PRIMARY KEY,
                attempt_id INTEGER NOT NULL REFERENCES user_quiz_attempts(id) ON DELETE CASCADE,
                question_id INTEGER NOT NULL REFERENCES quiz_questions(id) ON DELETE CASCADE,
                selected_option_id INTEGER REFERENCES quiz_options(id) ON DELETE SET NULL,
                is_correct BOOLEAN NOT NULL
            );
        `);

        // 9. Summaries Table (AI Document & Reel Summaries)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS summaries (
                id SERIAL PRIMARY KEY,
                reel_id INTEGER REFERENCES reels(id) ON DELETE CASCADE,
                note_id INTEGER REFERENCES notes(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                summary TEXT NOT NULL,
                bullets JSONB DEFAULT '[]'::jsonb,
                source_chunks JSONB DEFAULT '[]'::jsonb,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 10. User Reel Metrics Table (Watch counts, duration, completion rate)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_reel_metrics (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                reel_id INTEGER NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
                watch_count INTEGER NOT NULL DEFAULT 1,
                watch_time_seconds NUMERIC(10, 2) NOT NULL DEFAULT 0,
                total_duration_seconds NUMERIC(10, 2) NOT NULL DEFAULT 0,
                completion_rate NUMERIC(5, 2) NOT NULL DEFAULT 0,
                completed BOOLEAN NOT NULL DEFAULT FALSE,
                last_watched_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT unique_user_reel UNIQUE (user_id, reel_id)
            );
        `);

        // 11. Indexes
        await pool.query("CREATE INDEX IF NOT EXISTS idx_quizzes_reel_id ON quizzes(reel_id)");
        await pool.query("CREATE INDEX IF NOT EXISTS idx_quiz_questions_quiz_id ON quiz_questions(quiz_id)");
        await pool.query("CREATE INDEX IF NOT EXISTS idx_quiz_options_question_id ON quiz_options(question_id)");
        await pool.query("CREATE INDEX IF NOT EXISTS idx_reel_likes_user_id ON reel_likes(user_id)");
        await pool.query("CREATE INDEX IF NOT EXISTS idx_reel_likes_reel_id ON reel_likes(reel_id)");
        await pool.query("CREATE INDEX IF NOT EXISTS idx_reel_saves_user_id ON reel_saves(user_id)");
        await pool.query("CREATE INDEX IF NOT EXISTS idx_reel_saves_reel_id ON reel_saves(reel_id)");
        await pool.query("CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id)");
        await pool.query("CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)");
        await pool.query("CREATE INDEX IF NOT EXISTS idx_user_quiz_attempts_user_id ON user_quiz_attempts(user_id)");
        await pool.query("CREATE INDEX IF NOT EXISTS idx_user_quiz_attempts_quiz_id ON user_quiz_attempts(quiz_id)");
        await pool.query("CREATE INDEX IF NOT EXISTS idx_user_quiz_answers_attempt_id ON user_quiz_answers(attempt_id)");
        await pool.query("CREATE INDEX IF NOT EXISTS idx_summaries_reel_id ON summaries(reel_id)");
        await pool.query("CREATE INDEX IF NOT EXISTS idx_summaries_note_id ON summaries(note_id)");
        await pool.query("CREATE INDEX IF NOT EXISTS idx_user_reel_metrics_user_id ON user_reel_metrics(user_id)");
        await pool.query("CREATE INDEX IF NOT EXISTS idx_user_reel_metrics_reel_id ON user_reel_metrics(reel_id)");

        console.log("Success! EduReel database schema setup completed successfully.");
    } catch (err) {
        console.error("Error setting up DB:", err);
    } finally {
        pool.end();
    }
}

run();
