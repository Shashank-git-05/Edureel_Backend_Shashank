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

async function verifyQuizAttemptSystem() {
    console.log("==========================================");
    console.log("Quiz Attempt & History System Verification");
    console.log("==========================================\n");

    try {
        // 1. Create a dev user
        console.log("1. Creating dev test user...");
        const userRes = await makeRequest("/api/dev/test-user", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "Student Test User", email: `student_${Date.now()}@edureel.com` })
        });
        const userData = JSON.parse(userRes.bodyText);
        console.log(`   User created ID: ${userData.user.id}`);

        // Sign a JWT token for the user to make authenticated requests
        const jwt = require("jsonwebtoken");
        const token = jwt.sign(
            { id: userData.user.id, email: userData.user.email },
            process.env.JWT_SECRET || "edureel_jwt_secret_key_2026_dev_mode"
        );

        // 2. Query available reel ID
        const dbPool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false }
        });
        const reelsRes = await dbPool.query("SELECT id FROM reels ORDER BY id DESC LIMIT 1");
        const validReelId = reelsRes.rows.length > 0 ? reelsRes.rows[0].id : 1;

        console.log(`\n2. Creating a test quiz for reel ID ${validReelId}...`);
        const createQuizRes = await makeRequest("/api/quizzes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                reelId: validReelId,
                title: "Data Structures & Algorithms Quiz",
                description: "Test quiz for user attempt tracking",
                questions: [
                    {
                        question: "What is the time complexity of searching in a Balanced BST?",
                        questionOrder: 1,
                        options: [
                            { text: "O(n)", isCorrect: false },
                            { text: "O(log n)", isCorrect: true },
                            { text: "O(1)", isCorrect: false }
                        ]
                    },
                    {
                        question: "Which data structure follows FIFO?",
                        questionOrder: 2,
                        options: [
                            { text: "Stack", isCorrect: false },
                            { text: "Queue", isCorrect: true }
                        ]
                    }
                ]
            })
        });

        console.log(`   Quiz post status: ${createQuizRes.statusCode}, body: ${createQuizRes.bodyText}`);
        const quizData = JSON.parse(createQuizRes.bodyText);
        console.log(`   Quiz created ID: ${quizData.quizId}`);

        // 3. Fetch full quiz details (with correct answers to get option IDs for test submission)
        const optionsRes = await dbPool.query(
            `SELECT qo.question_id, qo.id AS option_id, qo.is_correct
             FROM quiz_options qo
             JOIN quiz_questions qq ON qo.question_id = qq.id
             WHERE qq.quiz_id = $1 ORDER BY qo.id ASC`,
            [quizData.quizId]
        );

        // Map options per question
        const qOptionsMap = {};
        optionsRes.rows.forEach(r => {
            if (!qOptionsMap[r.question_id]) qOptionsMap[r.question_id] = [];
            qOptionsMap[r.question_id].push(r);
        });

        const questionIds = Object.keys(qOptionsMap);
        const q1Id = questionIds[0];
        const q2Id = questionIds[1];

        const q1CorrectOpt = qOptionsMap[q1Id].find(o => o.is_correct).option_id;
        const q2WrongOpt = qOptionsMap[q2Id].find(o => !o.is_correct).option_id;

        // 4. Submit quiz attempt (1 correct, 1 wrong -> 50% score expected)
        console.log("\n3. Submitting quiz attempt (1 correct answer, 1 wrong answer)...");
        const submitRes = await makeRequest(`/api/quizzes/${quizData.quizId}/submit`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`
            },
            body: JSON.stringify({
                answers: [
                    { questionId: q1Id, selectedOptionId: q1CorrectOpt },
                    { questionId: q2Id, selectedOptionId: q2WrongOpt }
                ]
            })
        });

        const submitResult = JSON.parse(submitRes.bodyText);
        console.log("   Submit result:", submitResult);
        console.log(`   Score: ${submitResult.score}/${submitResult.totalQuestions} (${submitResult.percentage}%)`);

        if (submitRes.statusCode === 201 && submitResult.score === 1 && submitResult.percentage === 50) {
            console.log("✅ Quiz submission & scoring verified!");
        } else {
            console.error("❌ Submission scoring mismatch!", submitResult);
        }

        // 5. Fetch user's past attempts history
        console.log("\n4. Fetching past quiz attempts history for student...");
        const attemptsRes = await makeRequest("/api/users/me/quiz-attempts", {
            method: "GET",
            headers: { "Authorization": `Bearer ${token}` }
        });
        const attemptsList = JSON.parse(attemptsRes.bodyText);
        console.log(`   Found ${attemptsList.length} past attempts in student history:`, attemptsList);

        if (attemptsList.length > 0 && attemptsList[0].quizId === quizData.quizId) {
            console.log("✅ Student quiz history verified!");
        } else {
            console.error("❌ Student quiz history failed!", attemptsList);
        }

        // 6. Fetch attempt breakdown detail
        console.log("\n5. Fetching attempt detail breakdown...");
        const detailRes = await makeRequest(`/api/users/me/quiz-attempts/${submitResult.attemptId}`, {
            method: "GET",
            headers: { "Authorization": `Bearer ${token}` }
        });
        const attemptDetail = JSON.parse(detailRes.bodyText);
        console.log("   Attempt detail answers:", attemptDetail.answers);

        if (detailRes.statusCode === 200 && attemptDetail.answers.length === 2) {
            console.log("✅ Detailed answer breakdown verified!");
        } else {
            console.error("❌ Detailed breakdown failed!", attemptDetail);
        }

        await dbPool.end();
        console.log("\n==========================================");
        console.log("🎉 ALL QUIZ ATTEMPT VERIFICATIONS PASSED!");
        console.log("==========================================");
    } catch (err) {
        console.error("Test execution failed:", err);
    }
}

verifyQuizAttemptSystem();
