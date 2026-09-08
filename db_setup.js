const { Pool } = require("pg");
require("dotenv").config();

const isCloudDb = Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== "");

const pool = new Pool(
    isCloudDb
        ? {
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false },
        }
        : {
            user: process.env.DB_USER,
            host: process.env.DB_HOST,
            database: process.env.DB_NAME,
            password: process.env.DB_PASSWORD,
            port: process.env.DB_PORT,
        }
);

async function run() {
    try {
        console.log("Adding required columns to your reels table...");
        await pool.query("ALTER TABLE reels ADD COLUMN IF NOT EXISTS file_data BYTEA");
        await pool.query("ALTER TABLE reels ADD COLUMN IF NOT EXISTS filename TEXT");
        console.log("Success! Columns added.");
    } catch (err) {
        console.error("Error setting up DB:", err);
    } finally {
        pool.end();
    }
}

run();
