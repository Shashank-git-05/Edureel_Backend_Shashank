const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { Client } = require("pg");
require("dotenv").config();

const outputFile = path.join(__dirname, "..", "edureel_backup.sql");

async function exportLocalDb() {
    console.log("==========================================");
    console.log("EduReel Local Database Backup Tool");
    console.log("==========================================\n");

    const psqlDumpPath = "C:\\Program Files\\PostgreSQL\\18\\bin\\pg_dump.exe";
    let dumpSuccess = false;

    if (fs.existsSync(psqlDumpPath)) {
        try {
            console.log("Creating backup via native pg_dump utility...");
            const envVars = { ...process.env, PGPASSWORD: process.env.DB_PASSWORD || "2705" };
            execSync(
                `"${psqlDumpPath}" -U ${process.env.DB_USER || "postgres"} -h ${process.env.DB_HOST || "localhost"} -p ${process.env.DB_PORT || 5432} -d ${process.env.DB_NAME || "edureel_db"} -F p --clean --if-exists -f "${outputFile}"`,
                { env: envVars, stdio: "inherit" }
            );
            dumpSuccess = true;
        } catch (err) {
            console.warn("⚠️ pg_dump command warning/error:", err.message);
        }
    }

    if (dumpSuccess) {
        console.log(`\n✅ Local PostgreSQL database successfully backed up to:\n   ${outputFile}\n`);
    } else {
        console.error("❌ Failed to create backup file via pg_dump.");
    }
}

exportLocalDb();
