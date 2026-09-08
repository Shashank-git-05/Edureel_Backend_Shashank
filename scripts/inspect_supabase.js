const { Client } = require("pg");
require("dotenv").config();

async function inspect() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });

    try {
        await client.connect();
        const res = await client.query(
            "SELECT table_schema, table_name FROM information_schema.tables WHERE table_name IN ('reels', 'notes')"
        );
        console.log("Found tables in Supabase:", res.rows);

        for (const row of res.rows) {
            const countRes = await client.query(`SELECT COUNT(*) FROM "${row.table_schema}"."${row.table_name}"`);
            console.log(`Schema "${row.table_schema}" Table "${row.table_name}": ${countRes.rows[0].count} rows`);
        }
    } catch (err) {
        console.error("Inspection error:", err.message);
    } finally {
        await client.end();
    }
}

inspect();
