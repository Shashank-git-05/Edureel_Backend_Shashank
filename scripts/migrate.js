const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const { execSync } = require("child_process");
require("dotenv").config();

const backupFilePath = path.join(__dirname, "..", "edureel_backup.sql");

async function runMigration() {
    console.log("==========================================");
    console.log("EduReel Supabase Database Migration Tool");
    console.log("==========================================\n");

    const databaseUrl = process.env.DATABASE_URL;

    if (!databaseUrl || databaseUrl.trim() === "" || databaseUrl.includes("YOUR-PROJECT-REF")) {
        console.error("❌ ERROR: DATABASE_URL is not configured in .env file!");
        console.error("Please add your Supabase connection string to .env:");
        console.error('DATABASE_URL="postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres?sslmode=require"\n');
        process.exit(1);
    }

    if (!fs.existsSync(backupFilePath)) {
        console.error("❌ ERROR: edureel_backup.sql not found!");
        console.error("Please generate a backup first or check the repository files.\n");
        process.exit(1);
    }

    console.log("Connecting to target PostgreSQL cloud database...");

    // Try using native psql tool first if available for best SQL script execution performance
    const psqlPath = "C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe";
    let psqlSuccess = false;

    if (fs.existsSync(psqlPath)) {
        try {
            console.log("Executing migration via native PostgreSQL psql utility...");
            execSync(`"${psqlPath}" "${databaseUrl}" -f "${backupFilePath}"`, { stdio: "inherit" });
            psqlSuccess = true;
        } catch (psqlErr) {
            console.warn("⚠️ Native psql execution failed or encountered warning. Falling back to Node.js pg client driver execution...");
        }
    }

    if (!psqlSuccess) {
        // Fallback: Execute SQL via Node pg client
        const client = new Client({
            connectionString: databaseUrl,
            ssl: { rejectUnauthorized: false }
        });

        try {
            await client.connect();
            console.log("Connected to Supabase PostgreSQL via pg client.");
            
            const sqlContent = fs.readFileSync(backupFilePath, "utf8");
            
            // Clean out psql-specific meta commands if any
            const cleanedSql = sqlContent
                .split("\n")
                .filter(line => !line.trim().startsWith("\\"))
                .join("\n");

            console.log("Applying database schema and data migration to Supabase...");
            await client.query(cleanedSql);
            console.log("✅ SQL migration query executed successfully!");
        } catch (err) {
            console.error("❌ Error executing migration script:", err.message);
            process.exit(1);
        } finally {
            await client.end();
        }
    }

    // Verify row counts in target database
    console.log("\nVerifying row counts in Supabase database...");
    const clientVerify = new Client({
        connectionString: databaseUrl,
        ssl: { rejectUnauthorized: false }
    });

    try {
        await clientVerify.connect();

        const reelsRes = await clientVerify.query("SELECT COUNT(*) FROM public.reels");
        const notesRes = await clientVerify.query("SELECT COUNT(*) FROM public.notes");

        console.log("------------------------------------------");
        console.log(`✅ Reels table row count in Supabase: ${reelsRes.rows[0].count}`);
        console.log(`✅ Notes table row count in Supabase: ${notesRes.rows[0].count}`);
        console.log("------------------------------------------");
        console.log("🎉 MIGRATION TO SUPABASE COMPLETED SUCCESSFULLY!\n");
    } catch (vErr) {
        console.error("⚠️ Error verifying table row counts:", vErr.message);
    } finally {
        await clientVerify.end();
    }
}

runMigration();
