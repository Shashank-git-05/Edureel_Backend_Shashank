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

async function runTests() {
    console.log("==========================================");
    console.log("EduReel Extension Suite Verification");
    console.log("==========================================\n");

    const results = {};

    try {
        // -------------------------------------------------------------
        // TEST 1: GET /api/reels (Existing function check)
        // -------------------------------------------------------------
        console.log("Test 1: GET /api/reels ...");
        const resReels = await makeRequest("/api/reels");
        if (resReels.statusCode === 200) {
            const reels = JSON.parse(resReels.bodyText);
            console.log(`  Received ${reels.length} reels.`);
            results.test1 = { passed: true, detail: `Returned ${reels.length} reels.` };
        } else {
            results.test1 = { passed: false, detail: `HTTP status ${resReels.statusCode}` };
        }

        // -------------------------------------------------------------
        // TEST 2: GET /api/video/1 Range Stream (Existing function check)
        // -------------------------------------------------------------
        console.log("\nTest 2: GET /api/video/1 ...");
        const resVideo = await makeRequest("/api/video/1", {
            headers: { Range: "bytes=0-1023" }
        });
        if (resVideo.statusCode === 206 || resVideo.statusCode === 200) {
            console.log(`  Video stream response status: ${resVideo.statusCode}, length: ${resVideo.bodyBuffer.length} bytes`);
            results.test2 = { passed: true, detail: `HTTP ${resVideo.statusCode} Range response verified.` };
        } else {
            results.test2 = { passed: false, detail: `HTTP status ${resVideo.statusCode}` };
        }

        // -------------------------------------------------------------
        // TEST 3: POST /api/quizzes (Teacher creation transaction)
        // -------------------------------------------------------------
        console.log("\nTest 3: POST /api/quizzes ...");
        const quizPayload = JSON.stringify({
            reelId: 1,
            title: "Computer Networks Fundamentals",
            description: "Test quiz covering TCP/IP basics",
            questions: [
                {
                    question: "What does TCP stand for?",
                    questionOrder: 1,
                    options: [
                        { text: "Transmission Control Protocol", isCorrect: true },
                        { text: "Transfer Control Protocol", isCorrect: false }
                    ]
                },
                {
                    question: "Which layer does HTTP operate on?",
                    questionOrder: 2,
                    options: [
                        { text: "Application Layer", isCorrect: true },
                        { text: "Transport Layer", isCorrect: false }
                    ]
                }
            ]
        });

        const resCreateQuiz = await makeRequest("/api/quizzes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: quizPayload
        });

        let createdQuizId = null;
        if (resCreateQuiz.statusCode === 201) {
            const body = JSON.parse(resCreateQuiz.bodyText);
            createdQuizId = body.quizId;
            console.log(`  Quiz created successfully! ID: ${createdQuizId}`);
            results.test3 = { passed: true, detail: `Quiz created with ID ${createdQuizId}` };
        } else {
            results.test3 = { passed: false, detail: `HTTP ${resCreateQuiz.statusCode}: ${resCreateQuiz.bodyText}` };
        }

        // -------------------------------------------------------------
        // TEST 4: GET /api/quizzes/:id & GET /api/reels/1/quiz (Flutter Retrieval Security check)
        // -------------------------------------------------------------
        console.log("\nTest 4: GET /api/reels/1/quiz (Option stripping security check) ...");
        const resFlutterQuiz = await makeRequest("/api/reels/1/quiz");
        if (resFlutterQuiz.statusCode === 200) {
            const quizData = JSON.parse(resFlutterQuiz.bodyText);
            console.log("  Flutter received quiz:", JSON.stringify(quizData, null, 2));

            // Verify is_correct is stripped from student payload
            let hasIsCorrect = false;
            quizData.questions.forEach(q => {
                q.options.forEach(opt => {
                    if ("is_correct" in opt || "isCorrect" in opt) {
                        hasIsCorrect = true;
                    }
                });
            });

            if (!hasIsCorrect) {
                console.log("  Security verified: is_correct field was correctly stripped for student fetching!");
                results.test4 = { passed: true, detail: "Flutter payload received cleanly with correct answer stripped." };
            } else {
                results.test4 = { passed: false, detail: "SECURITY FAILURE: is_correct present in student payload!" };
            }
        } else {
            results.test4 = { passed: false, detail: `HTTP ${resFlutterQuiz.statusCode}: ${resFlutterQuiz.bodyText}` };
        }

        // -------------------------------------------------------------
        // TEST 5: GET /api/users/me Security Authentication Check
        // -------------------------------------------------------------
        console.log("\nTest 5: GET /api/users/me without Auth header ...");
        const resUnauth = await makeRequest("/api/users/me");
        if (resUnauth.statusCode === 401) {
            console.log("  Secured route correctly rejected unauthenticated request with HTTP 401!");
            results.test5 = { passed: true, detail: "HTTP 401 returned as expected without req.user identity." };
        } else {
            results.test5 = { passed: false, detail: `Expected 401, got ${resUnauth.statusCode}` };
        }

        // -------------------------------------------------------------
        // TEST 6: Development Test User Creation
        // -------------------------------------------------------------
        console.log("\nTest 6: POST /api/dev/test-user ...");
        const resDevUser = await makeRequest("/api/dev/test-user", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "Demo Student", email: "student@edureel.com", google_id: "google_12345" })
        });
        if (resDevUser.statusCode === 200) {
            const devUserData = JSON.parse(resDevUser.bodyText);
            console.log("  Dev user result:", devUserData.user);
            results.test6 = { passed: true, detail: `Dev user created with ID ${devUserData.user.id}` };
        } else {
            results.test6 = { passed: false, detail: `HTTP ${resDevUser.statusCode}` };
        }

    } catch (err) {
        console.error("Test execution error:", err);
    }

    console.log("\n==========================================");
    console.log("VERIFICATION TEST RESULTS SUMMARY:");
    console.log("==========================================");
    console.table(results);
}

runTests();
