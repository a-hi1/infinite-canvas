/**
 * Lightweight regression for email uniqueness + password-matched login.
 * Run: node api/src/auth-email-unique.test.mjs
 * Uses an isolated temp DATA_DIR (does not touch ./data/api).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-auth-email-"));
const port = 18080 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function waitHealthy(timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(`${base}/health`);
            if (res.ok) return;
        } catch {
            // retry
        }
        await sleep(150);
    }
    throw new Error("api health timeout");
}

async function post(pathName, body, cookie = "") {
    const res = await fetch(`${base}${pathName}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(cookie ? { Cookie: cookie } : {}),
            Origin: base,
        },
        body: JSON.stringify(body),
    });
    const setCookie = res.headers.getSetCookie?.() || [];
    const json = await res.json().catch(() => null);
    return { status: res.status, json, setCookie };
}

function cookieFrom(setCookie) {
    const line = setCookie.find((c) => c.startsWith("ic_session="));
    if (!line) return "";
    return line.split(";")[0];
}

const child = spawn(process.execPath, ["src/index.js"], {
    cwd: apiRoot,
    env: {
        ...process.env,
        PORT: String(port),
        DATA_DIR: tmpDir,
        API_ALLOWED_ORIGINS: "*",
        API_TRUST_PROXY_SAME_ORIGIN: "true",
        API_INVITE_CODE: "",
        API_COOKIE_SECURE: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
});

try {
    await waitHealthy();

    const email = `Race.User+tag@Example.COM`;
    const passwordA = "password-aaa-1";
    const passwordB = "password-bbb-2";

    // Concurrent register with same email (different casing/spaces) must yield exactly one success.
    const [r1, r2] = await Promise.all([
        post("/auth/register", { email: ` ${email} `, password: passwordA, displayName: "A" }),
        post("/auth/register", { email: email.toLowerCase(), password: passwordB, displayName: "B" }),
    ]);

    const statuses = [r1.status, r2.status].sort();
    assert.equal(statuses.filter((s) => s === 200).length, 1, `expected one 200, got ${JSON.stringify([r1, r2])}`);
    assert.equal(statuses.filter((s) => s === 409).length, 1, `expected one 409, got ${JSON.stringify([r1, r2])}`);

    const winner = r1.status === 200 ? r1 : r2;
    const winnerPassword = r1.status === 200 ? passwordA : passwordB;
    const loserPassword = r1.status === 200 ? passwordB : passwordA;
    assert.equal(winner.json?.data?.user?.email, email.toLowerCase());

    // Login with winner password works; loser password fails (no silent wrong account).
    const loginOk = await post("/auth/login", { email: email.toUpperCase(), password: winnerPassword });
    assert.equal(loginOk.status, 200, JSON.stringify(loginOk.json));
    assert.equal(loginOk.json?.data?.user?.id, winner.json.data.user.id);

    const loginBad = await post("/auth/login", { email, password: loserPassword });
    assert.equal(loginBad.status, 401);

    // Re-register same email still 409 after success.
    const again = await post("/auth/register", { email, password: "password-ccc-3" });
    assert.equal(again.status, 409);

    // Session cookie follows the logged-in user (switch account replaces cookie).
    const otherEmail = "other-unique@example.com";
    const regOther = await post("/auth/register", { email: otherEmail, password: "password-other-9" });
    assert.equal(regOther.status, 200);
    const cookieOther = cookieFrom(regOther.setCookie);
    assert.ok(cookieOther);

    const switchLogin = await post("/auth/login", { email, password: winnerPassword }, cookieOther);
    assert.equal(switchLogin.status, 200);
    assert.equal(switchLogin.json?.data?.user?.email, email.toLowerCase());
    const cookieSwitched = cookieFrom(switchLogin.setCookie);
    assert.ok(cookieSwitched);
    assert.notEqual(cookieSwitched, cookieOther);

    console.log("auth-email-unique.test.mjs OK");
} catch (error) {
    console.error("auth-email-unique.test.mjs FAILED", error);
    if (stderr) console.error(stderr);
    process.exitCode = 1;
} finally {
    child.kill("SIGTERM");
    try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
        // ignore
    }
}
