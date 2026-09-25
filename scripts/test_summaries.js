const http = require("http");
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

async function verifySummarySystem() {
    console.log("==========================================");
    console.log("AI Summary Endpoints Verification");
    console.log("==========================================\n");

    try {
        // 1. Post to /api/summaries
        console.log("1. Testing POST /api/summaries...");
        const payload1 = {
            title: "Summary - Machine_Learning_Lec1.pdf",
            summary: "This lecture introduces supervised learning algorithms, gradient descent optimization, and cost function minimization.",
            bullets: [
                "Supervised learning predicts outputs using labeled training pairs.",
                "Gradient descent minimizes MSE loss iteratively.",
                "Feature scaling improves convergence speed."
            ],
            source_chunks: [
                { page: 1, text: "Supervised learning relies on dataset D = {(x_i, y_i)}." },
                { page: 4, text: "Cost function J(theta) = 1/(2m) * sum((h_theta(x) - y)^2)." }
            ]
        };

        const res1 = await makeRequest("/api/summaries", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload1)
        });

        console.log(`   POST /api/summaries Status: ${res1.statusCode}`);
        const data1 = JSON.parse(res1.bodyText);
        console.log("   Saved response:", data1);

        if (res1.statusCode !== 201 || !data1.summaryId) {
            throw new Error("Failed to save summary to /api/summaries");
        }

        // 2. Post to /api/summary (Singular endpoint alias)
        console.log("\n2. Testing POST /api/summary (Alias)...");
        const payload2 = {
            title: "Summary - Deep_Learning_Ch2.pdf",
            summary: "Overview of Backpropagation and Activation Functions.",
            bullets: ["ReLU solves vanishing gradient problem.", "Adam optimizer combines Momentum and RMSProp."],
            sourceChunks: [{ page: 12, text: "Backpropagation computes partial derivatives using chain rule." }]
        };

        const res2 = await makeRequest("/api/summary", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload2)
        });

        console.log(`   POST /api/summary Status: ${res2.statusCode}`);
        const data2 = JSON.parse(res2.bodyText);
        console.log("   Saved response:", data2);

        if (res2.statusCode !== 201 || !data2.summaryId) {
            throw new Error("Failed to save summary to /api/summary");
        }

        // 3. GET /api/summaries
        console.log("\n3. Testing GET /api/summaries...");
        const getRes = await makeRequest("/api/summaries");
        console.log(`   GET /api/summaries Status: ${getRes.statusCode}`);
        const list = JSON.parse(getRes.bodyText);
        console.log(`   Fetched ${list.length} summaries.`);

        if (getRes.statusCode === 200 && list.length >= 2) {
            console.log("✅ All summary endpoints verified successfully!");
        } else {
            throw new Error("Failed to retrieve summaries list");
        }

        console.log("\n==========================================");
        console.log("🎉 ALL SUMMARY SYSTEM VERIFICATIONS PASSED!");
        console.log("==========================================");
    } catch (err) {
        console.error("❌ Summary verification failed:", err);
    }
}

verifySummarySystem();
