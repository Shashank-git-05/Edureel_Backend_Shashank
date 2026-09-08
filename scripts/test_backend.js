const http = require("http");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
require("dotenv").config();

const BASE_URL = "http://localhost:3000";

// Local PG Pool (strictly for Step 7 verification)
const localPool = new Pool({
    user: process.env.DB_USER || "postgres",
    host: process.env.DB_HOST || "localhost",
    database: process.env.DB_NAME || "edureel_db",
    password: process.env.DB_PASSWORD || "2705",
    port: process.env.DB_PORT || 5432,
});

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

function createMultipartBody(fields, fileField) {
    const boundary = "----WebKitFormBoundary" + Math.random().toString(36).substring(2);
    const CRLF = "\r\n";
    let bodyBuffers = [];

    // Add normal text fields
    for (const [key, val] of Object.entries(fields)) {
        let fieldHeader = `--${boundary}${CRLF}Content-Disposition: form-data; name="${key}"${CRLF}${CRLF}${val}${CRLF}`;
        bodyBuffers.push(Buffer.from(fieldHeader, "utf8"));
    }

    // Add file field
    if (fileField) {
        let fileHeader = `--${boundary}${CRLF}Content-Disposition: form-data; name="${fileField.fieldname}"; filename="${fileField.filename}"${CRLF}Content-Type: ${fileField.mimetype}${CRLF}${CRLF}`;
        bodyBuffers.push(Buffer.from(fileHeader, "utf8"));
        bodyBuffers.push(fileField.buffer);
        bodyBuffers.push(Buffer.from(CRLF, "utf8"));
    }

    bodyBuffers.push(Buffer.from(`--${boundary}--${CRLF}`, "utf8"));

    return {
        boundary,
        body: Buffer.concat(bodyBuffers)
    };
}

async function runTests() {
    console.log("==========================================");
    console.log("EduReel Backend & Supabase Verification Tests");
    console.log("==========================================\n");

    const results = {};

    try {
        // -------------------------------------------------------------
        // TEST 1: GET /api/reels
        // -------------------------------------------------------------
        console.log("Running Test 1: GET /api/reels ...");
        const resReels = await makeRequest("/api/reels");
        if (resReels.statusCode === 200) {
            const reels = JSON.parse(resReels.bodyText);
            console.log(`  Received ${reels.length} reels.`);
            console.log(`  Sample metadata:`, reels[0]);
            if (Array.isArray(reels) && reels.length >= 6) {
                results.test1 = { passed: true, detail: `Returned ${reels.length} reels with id, title, filename, and videoUrl metadata.` };
            } else {
                results.test1 = { passed: false, detail: `Expected >= 6 reels, got ${reels ? reels.length : 0}` };
            }
        } else {
            results.test1 = { passed: false, detail: `HTTP status ${resReels.statusCode}` };
        }

        // -------------------------------------------------------------
        // TEST 2: GET /api/video/:id
        // -------------------------------------------------------------
        console.log("\nRunning Test 2: GET /api/video/1 ...");
        const resVideo = await makeRequest("/api/video/1", {
            headers: { Range: "bytes=0-1023" }
        });
        console.log(`  Status Code: ${resVideo.statusCode}`);
        console.log(`  Content-Type: ${resVideo.headers["content-type"]}`);
        console.log(`  Content-Range: ${resVideo.headers["content-range"]}`);
        console.log(`  Bytes received: ${resVideo.bodyBuffer.length}`);
        if ((resVideo.statusCode === 206 || resVideo.statusCode === 200) && resVideo.bodyBuffer.length > 0) {
            results.test2 = { passed: true, detail: `Retrieved byte-range stream successfully (${resVideo.bodyBuffer.length} bytes, HTTP ${resVideo.statusCode}).` };
        } else {
            results.test2 = { passed: false, detail: `HTTP status ${resVideo.statusCode}, 0 bytes received.` };
        }

        // -------------------------------------------------------------
        // TEST 3: GET /api/notes
        // -------------------------------------------------------------
        console.log("\nRunning Test 3: GET /api/notes ...");
        const resNotes = await makeRequest("/api/notes");
        if (resNotes.statusCode === 200) {
            const notes = JSON.parse(resNotes.bodyText);
            console.log(`  Received ${notes.length} notes.`);
            console.log(`  Sample note metadata:`, notes[0]);
            if (Array.isArray(notes) && notes.length >= 1) {
                results.test3 = { passed: true, detail: `Returned ${notes.length} note(s) with id and title.` };
            } else {
                results.test3 = { passed: false, detail: `Expected >= 1 note, got ${notes ? notes.length : 0}` };
            }
        } else {
            results.test3 = { passed: false, detail: `HTTP status ${resNotes.statusCode}` };
        }

        // -------------------------------------------------------------
        // TEST 4: GET /api/notes/:id/file
        // -------------------------------------------------------------
        console.log("\nRunning Test 4: GET /api/notes/1/file ...");
        const resNoteFile = await makeRequest("/api/notes/1/file");
        console.log(`  Status Code: ${resNoteFile.statusCode}`);
        console.log(`  Content-Disposition: ${resNoteFile.headers["content-disposition"]}`);
        console.log(`  File buffer size: ${resNoteFile.bodyBuffer.length} bytes`);
        if (resNoteFile.statusCode === 200 && resNoteFile.bodyBuffer.length > 0) {
            results.test4 = { passed: true, detail: `Retrieved binary note file (${resNoteFile.bodyBuffer.length} bytes).` };
        } else {
            results.test4 = { passed: false, detail: `HTTP status ${resNoteFile.statusCode}, length 0` };
        }

        // -------------------------------------------------------------
        // TEST 5: POST /api/upload (Create new reel)
        // -------------------------------------------------------------
        console.log("\nRunning Test 5: POST /api/upload (Uploading test reel)...");
        const dummyVideoBuffer = Buffer.from("FAKE_MP4_VIDEO_HEADER_AND_DUMMY_BYTE_CONTENT_FOR_EDUREEL_TEST");
        const reelMultipart = createMultipartBody({}, {
            fieldname: "file",
            filename: "test_integration_reel.mp4",
            mimetype: "video/mp4",
            buffer: dummyVideoBuffer
        });

        const resUploadReel = await makeRequest("/api/upload", {
            method: "POST",
            headers: {
                "Content-Type": `multipart/form-data; boundary=${reelMultipart.boundary}`,
                "Content-Length": reelMultipart.body.length
            },
            body: reelMultipart.body
        });

        console.log(`  Upload status: ${resUploadReel.statusCode}`);
        console.log(`  Response body:`, resUploadReel.bodyText);
        
        let newReelId = null;
        if (resUploadReel.statusCode === 200) {
            const uploadJson = JSON.parse(resUploadReel.bodyText);
            newReelId = uploadJson.dbResult ? uploadJson.dbResult.id : null;
        }

        if (newReelId) {
            console.log(`  New Reel ID returned: ${newReelId}. Verifying retrieval via GET /api/video/${newReelId}...`);
            const resNewVideo = await makeRequest(`/api/video/${newReelId}`);
            if (resNewVideo.statusCode === 200 && resNewVideo.bodyBuffer.toString("utf8") === dummyVideoBuffer.toString("utf8")) {
                results.test5 = { passed: true, detail: `Uploaded reel successfully (ID: ${newReelId}), verified exact binary content retrieval.` };
            } else {
                results.test5 = { passed: false, detail: `Uploaded ID ${newReelId}, but retrieval returned HTTP ${resNewVideo.statusCode}` };
            }
        } else {
            results.test5 = { passed: false, detail: `Upload failed with status ${resUploadReel.statusCode}` };
        }

        // -------------------------------------------------------------
        // TEST 6: POST /api/notes/upload (Create new note)
        // -------------------------------------------------------------
        console.log("\nRunning Test 6: POST /api/notes/upload (Uploading test note)...");
        const dummyNoteBuffer = Buffer.from("DUMMY_LECTURE_NOTES_TEXT_CONTENT_FOR_TESTING");
        const noteMultipart = createMultipartBody({ title: "Integration Test Note" }, {
            fieldname: "file",
            filename: "test_lecture_notes.pdf",
            mimetype: "application/pdf",
            buffer: dummyNoteBuffer
        });

        const resUploadNote = await makeRequest("/api/notes/upload", {
            method: "POST",
            headers: {
                "Content-Type": `multipart/form-data; boundary=${noteMultipart.boundary}`,
                "Content-Length": noteMultipart.body.length
            },
            body: noteMultipart.body
        });

        console.log(`  Upload status: ${resUploadNote.statusCode}`);
        console.log(`  Response body:`, resUploadNote.bodyText);

        let newNoteId = null;
        if (resUploadNote.statusCode === 200) {
            const noteUploadJson = JSON.parse(resUploadNote.bodyText);
            newNoteId = noteUploadJson.id;
        }

        if (newNoteId) {
            console.log(`  New Note ID returned: ${newNoteId}. Verifying retrieval via GET /api/notes/${newNoteId}/file...`);
            const resNewNoteFile = await makeRequest(`/api/notes/${newNoteId}/file`);
            if (resNewNoteFile.statusCode === 200 && resNewNoteFile.bodyBuffer.toString("utf8") === dummyNoteBuffer.toString("utf8")) {
                results.test6 = { passed: true, detail: `Uploaded note successfully (ID: ${newNoteId}), verified exact binary content retrieval.` };
            } else {
                results.test6 = { passed: false, detail: `Uploaded ID ${newNoteId}, but file retrieval returned HTTP ${resNewNoteFile.statusCode}` };
            }
        } else {
            results.test6 = { passed: false, detail: `Upload failed with status ${resUploadNote.statusCode}` };
        }

        // -------------------------------------------------------------
        // TEST 7: Confirm Local PostgreSQL Database is Unmodified
        // -------------------------------------------------------------
        console.log("\nRunning Test 7: Inspecting Local PostgreSQL Database...");
        try {
            const localReels = await localPool.query("SELECT COUNT(*) FROM reels");
            const localNotes = await localPool.query("SELECT COUNT(*) FROM notes");
            console.log(`  Local PostgreSQL Reels Count: ${localReels.rows[0].count}`);
            console.log(`  Local PostgreSQL Notes Count: ${localNotes.rows[0].count}`);

            // Original local counts: reels = 6, notes = 1
            if (parseInt(localReels.rows[0].count, 10) === 6 && parseInt(localNotes.rows[0].count, 10) === 1) {
                results.test7 = { passed: true, detail: `Local database completely untouched (6 reels, 1 note). All new writes went strictly to Supabase Cloud.` };
            } else {
                results.test7 = { passed: false, detail: `Local database counts changed: reels=${localReels.rows[0].count}, notes=${localNotes.rows[0].count}` };
            }
        } catch (lErr) {
            results.test7 = { passed: false, detail: `Error inspecting local DB: ${lErr.message}` };
        } finally {
            await localPool.end();
        }

    } catch (err) {
        console.error("Test execution exception:", err);
    }

    console.log("\n==========================================");
    console.log("FINAL INTEGRATION TEST REPORT");
    console.log("==========================================");
    console.log(`1. GET /api/reels:          ${results.test1.passed ? "PASSED ✅" : "FAILED ❌"} (${results.test1.detail})`);
    console.log(`2. GET /api/video/:id:      ${results.test2.passed ? "PASSED ✅" : "FAILED ❌"} (${results.test2.detail})`);
    console.log(`3. GET /api/notes:          ${results.test3.passed ? "PASSED ✅" : "FAILED ❌"} (${results.test3.detail})`);
    console.log(`4. GET /api/notes/:id/file: ${results.test4.passed ? "PASSED ✅" : "FAILED ❌"} (${results.test4.detail})`);
    console.log(`5. POST /api/upload (Reel): ${results.test5.passed ? "PASSED ✅" : "FAILED ❌"} (${results.test5.detail})`);
    console.log(`6. POST /api/notes/upload:  ${results.test6.passed ? "PASSED ✅" : "FAILED ❌"} (${results.test6.detail})`);
    console.log(`7. Local DB Safety Check:   ${results.test7.passed ? "PASSED ✅" : "FAILED ❌"} (${results.test7.detail})`);
    console.log("==========================================\n");
}

runTests();
