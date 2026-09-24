const fetch = globalThis.fetch;
const jwt = require("jsonwebtoken");
require("dotenv").config();

const JWT_SECRET = process.env.JWT_SECRET || "edureel_jwt_secret_key_2026_dev_mode";

async function runTests() {
    console.log("🧪 Starting User Profile API Automated Tests...");

    try {
        const testUserEmail = `profile_test_${Date.now()}@edureel.com`;
        const testUserName = "Initial Test Student";
        const googleId = `g_test_${Date.now()}`;

        // 1. Create dev test user
        const devRes = await fetch("http://localhost:3000/api/dev/test-user", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: testUserName, email: testUserEmail, google_id: googleId })
        });
        const devData = await devRes.json();
        const testUserId = devData.user.id;
        console.log(`✅ Created test user ID: ${testUserId}`);

        // Sign JWT token for test user
        const token = jwt.sign(
            { id: testUserId, googleId: googleId, email: testUserEmail },
            JWT_SECRET,
            { expiresIn: "1h" }
        );

        // Test 1: Fetch initial profile for pre-existing/new user (optional fields unpopulated)
        const getRes1 = await fetch("http://localhost:3000/api/users/me/profile", {
            headers: { "Authorization": `Bearer ${token}` }
        });
        const getData1 = await getRes1.json();
        console.log("Test 1 - Initial GET Profile:", getRes1.status, getData1);
        if (getRes1.status !== 200 || getData1.profile.phone !== null || !Array.isArray(getData1.profile.skills)) {
            throw new Error("Test 1 Failed: Initial profile format incorrect");
        }
        console.log("✅ Test 1 Passed: Pre-existing user initial profile fetched cleanly.");

        // Test 2: Update profile with complete valid payload
        const updatePayload = {
            name: " Updated Student Name ",
            phone: "+91 98765 43210",
            email: testUserEmail,
            institution: "Stanford University",
            skills: ["Flutter", "Dart", "Machine Learning"]
        };
        const putRes1 = await fetch("http://localhost:3000/api/users/me/profile", {
            method: "PUT",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(updatePayload)
        });
        const putData1 = await putRes1.json();
        console.log("Test 2 - Complete PUT Profile:", putRes1.status, putData1);
        if (putRes1.status !== 200 || putData1.profile.name !== "Updated Student Name" || putData1.profile.skills.length !== 3) {
            throw new Error("Test 2 Failed: Update profile response mismatch");
        }
        console.log("✅ Test 2 Passed: Profile creation & update succeeded.");

        // Test 3: Update profile with empty optional fields
        const putRes2 = await fetch("http://localhost:3000/api/users/me/profile", {
            method: "PUT",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                name: "Updated Student Name",
                email: testUserEmail,
                phone: "",
                institution: "",
                skills: []
            })
        });
        const putData2 = await putRes2.json();
        console.log("Test 3 - Empty Optionals PUT Profile:", putRes2.status, putData2);
        if (putRes2.status !== 200 || putData2.profile.phone !== null || putData2.profile.skills.length !== 0) {
            throw new Error("Test 3 Failed: Empty optionals handling mismatch");
        }
        console.log("✅ Test 3 Passed: Empty optional fields handled correctly.");

        // Test 4: Rejection of invalid email format
        const putRes3 = await fetch("http://localhost:3000/api/users/me/profile", {
            method: "PUT",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                name: "Updated Student Name",
                email: "invalid-email-format",
                skills: []
            })
        });
        console.log("Test 4 - Invalid Email PUT Profile:", putRes3.status, await putRes3.json());
        if (putRes3.status !== 400) {
            throw new Error("Test 4 Failed: Expected 400 Bad Request for invalid email format");
        }
        console.log("✅ Test 4 Passed: Invalid email rejected with 400 Bad Request.");

        // Test 5: Rejection of invalid skills data
        const putRes5 = await fetch("http://localhost:3000/api/users/me/profile", {
            method: "PUT",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                name: "Updated Student Name",
                email: testUserEmail,
                skills: "NotAnArray"
            })
        });
        console.log("Test 5 - Invalid Skills PUT Profile:", putRes5.status, await putRes5.json());
        if (putRes5.status !== 400) {
            throw new Error("Test 5 Failed: Expected 400 Bad Request for non-array skills");
        }
        console.log("✅ Test 5 Passed: Invalid skills format rejected with 400 Bad Request.");

        // Test 6: Preventing unauthorized / cross-user profile access
        const getRes2 = await fetch("http://localhost:3000/api/users/me/profile", {
            headers: { "Authorization": `Bearer invalid_token` }
        });
        console.log("Test 6 - Unauthorized GET Profile:", getRes2.status, await getRes2.json());
        if (getRes2.status !== 401) {
            throw new Error("Test 6 Failed: Expected 401 Unauthorized for invalid token");
        }
        console.log("✅ Test 6 Passed: Unauthorized access blocked.");

        console.log("\n🎉 ALL USER PROFILE TESTS PASSED SUCCESSFULLY!");
        process.exit(0);

    } catch (err) {
        console.error("❌ Test suite failed:", err.message);
        process.exit(1);
    }
}

runTests();
