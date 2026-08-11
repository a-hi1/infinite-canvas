/**
 * Regression for canvas blob idempotency before new-upload rate limiting.
 * Run: node api/src/blob-upload-idempotency.test.mjs
 * Uses an isolated temp DATA_DIR and local API process only.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-blob-idempotency-"));
const port = 19080 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitHealthy(timeoutMs = 15000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        try {
            const response = await fetch(`${base}/health`);
            if (response.ok) return;
        } catch {
            // retry until the isolated API process is ready
        }
        await sleep(150);
    }
    throw new Error("api health timeout");
}

async function register() {
    const response = await fetch(`${base}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: base },
        body: JSON.stringify({ email: "blob-test@example.com", password: "password-blob-1" }),
    });
    const body = await response.json().catch(() => null);
    assert.equal(response.status, 200, JSON.stringify(body));
    const setCookies = response.headers.getSetCookie?.() || [];
    const session = setCookies.find((value) => value.startsWith("ic_session="))?.split(";")[0] || "";
    assert.ok(session, "registration did not return ic_session cookie");
    return session;
}

async function upload(clientKey, cookie) {
    const form = new FormData();
    form.append("client_key", clientKey);
    form.append("file", new Blob([clientKey], { type: "image/png" }), `${clientKey.replace(":", "-")}.png`);
    const response = await fetch(`${base}/blobs`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: base },
        body: form,
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
}

const child = spawn(process.execPath, ["src/index.js"], {
    cwd: apiRoot,
    env: {
        ...process.env,
        PORT: String(port),
        DATA_DIR: tmpDir,
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
    const cookie = await register();

    const first = await upload("image:blob000", cookie);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body?.data?.deduped, false);

    for (let index = 1; index < 120; index += 1) {
        const created = await upload(`image:blob${String(index).padStart(3, "0")}`, cookie);
        assert.equal(created.status, 200, `new blob ${index}: ${JSON.stringify(created.body)}`);
        assert.equal(created.body?.data?.deduped, false);
    }

    const deduped = await upload("image:blob000", cookie);
    assert.equal(deduped.status, 200, JSON.stringify(deduped.body));
    assert.equal(deduped.body?.data?.deduped, true);

    const overLimit = await upload("image:blob120", cookie);
    assert.equal(overLimit.status, 429, JSON.stringify(overLimit.body));
    assert.equal(overLimit.body?.reason, "upload_rate_limited");

    const dedupedAfterLimit = await upload("image:blob000", cookie);
    assert.equal(dedupedAfterLimit.status, 200, JSON.stringify(dedupedAfterLimit.body));
    assert.equal(dedupedAfterLimit.body?.data?.deduped, true);

    console.log("blob-upload-idempotency.test.mjs OK");
} catch (error) {
    console.error("blob-upload-idempotency.test.mjs FAILED", error);
    if (stderr) console.error(stderr);
    process.exitCode = 1;
} finally {
    child.kill("SIGTERM");
    try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
        // ignore cleanup errors
    }
}
