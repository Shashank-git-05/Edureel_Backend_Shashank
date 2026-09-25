const http = require("http");
const { Pool } = require("pg");
require("dotenv").config();

const BASE_URL = "http://localhost:3000";

function makeRequest(urlPath, options = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlPath, BASE_URL);
        const req = http.request(url, options, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
                const bodyBuffer = Buffer.concat(chunks);
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    bodyBuffer: bodyBuffer,
                    bodyText: bodyBuffer.toString("utf8")
                });
            });
        });
        req.on("error", (err) => reject(err));
        if (options.body) {
            req.write(options.body);
        }
        req.end();
    });
}

async function verifyWatchMetricsSystem() {
    console.log("==========================================");
    console.log("Reel Watch Metrics & Category Verification");
    console.log("==========================================\n");

    try {
        // 1. Create dev test user
        console.log("1. Creating dev test user...");
        const userRes = await makeRequest("/api/dev/test-user", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "Watch Metric Tester", email: `watch_${Date.now()}@edureel.com` })
        });
        const userData = JSON.parse(userRes.bodyText);

        const jwt = require("jsonwebtoken");
        const token = jwt.sign(
            { id: userData.user.id, email: userData.user.email },
            process.env.JWT_SECRET || "edureel_jwt_secret_key_2026_dev_mode"
        );

        // 2. Fetch or create a test reel
        const dbPool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false }
        });

        const reelQuery = await dbPool.query(
            "INSERT INTO reels (title, filename, category, duration_seconds) VALUES ($1, $2, $3, $4) RETURNING id",
            ["Physics Kinematics Short", "physics.mp4", "Physics", 60.0]
        );
        const testReelId = reelQuery.rows[0].id;
        console.log(`   Test Reel created with ID ${testReelId} (Category: Physics, Duration: 60s)`);

        // 3. Record watch metric event 1 (partial watch, 30s out of 60s)
        console.log("\n2. Recording first watch event (30s out of 60s)...");
        const watch1Res = await makeRequest(`/api/reels/${testReelId}/watch`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`
            },
            body: JSON.stringify({
                watchTimeSeconds: 30.0,
                totalDurationSeconds: 60.0,
                completed: false
            })
        });

        const w1Data = JSON.parse(watch1Res.bodyText);
        console.log("   First watch metric response:", w1Data.metric);

        if (watch1Res.statusCode !== 200 || w1Data.metric.watchCount !== 1) {
            throw new Error("First watch event recording failed");
        }

        // 4. Record watch metric event 2 (rewatched full video, 60s out of 60s)
        console.log("\n3. Recording second watch event (rewatched full 60s)...");
        const watch2Res = await makeRequest(`/api/reels/${testReelId}/watch`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`
            },
            body: JSON.stringify({
                watchTimeSeconds: 60.0,
                totalDurationSeconds: 60.0,
                completed: true
            })
        });

        const w2Data = JSON.parse(watch2Res.bodyText);
        console.log("   Second watch metric response:", w2Data.metric);

        if (watch2Res.statusCode !== 200 || w2Data.metric.watchCount !== 2 || !w2Data.metric.completed) {
            throw new Error("Second watch event recording / UPSERT failed");
        }

        // 5. Fetch overall watch analytics & category breakdown
        console.log("\n4. Fetching student overall watch metrics analytics...");
        const analyticsRes = await makeRequest("/api/users/me/watch-metrics", {
            method: "GET",
            headers: { "Authorization": `Bearer ${token}` }
        });

        const analytics = JSON.parse(analyticsRes.bodyText);
        console.log("   Overall Analytics:", JSON.stringify(analytics, null, 2));

        if (analyticsRes.statusCode === 200 && analytics.totalWatchTimeSeconds >= 60 && analytics.categoryBreakdown.length > 0) {
            console.log("✅ Overall watch metrics & category breakdown verified!");
        } else {
            throw new Error("Analytics retrieval failed");
        }

        await dbPool.end();
        console.log("\n==========================================");
        console.log("🎉 ALL WATCH METRICS VERIFICATIONS PASSED!");
        console.log("==========================================");
    } catch (err) {
        console.error("❌ Verification failed:", err);
    }
}

verifyWatchMetricsSystem();
