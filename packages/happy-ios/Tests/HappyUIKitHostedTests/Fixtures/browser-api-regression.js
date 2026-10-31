"use strict";
(async () => {
    const results = window.browserAPIResults = { done: false, cases: [], failures: [], seeded: 0 };
    const equal = (actual, expected) => {
        if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    };
    const check = async (name, run) => {
        try { await run(); results.cases.push(name); }
        catch (error) { results.failures.push({ name, error: String(error) }); }
        document.querySelector("#result").textContent = JSON.stringify(results);
    };
    const call = async (method, path, body, headers = {}) => {
        const response = await fetch("/api/v1" + path, { method, cache: "no-store", headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await response.text();
        let json;
        try { json = JSON.parse(text); } catch {}
        return { status: response.status, headers: response.headers, text, json };
    };
    const entry = (key) => "/kv/entry?key=" + encodeURIComponent(key);
    const put = (key, value, headers, writeId) => call("PUT", entry(key), { value, ...(writeId ? { writeId } : {}) }, headers);
    const until = async (predicate) => {
        for (let index = 0; index < 200; index++) {
            if (predicate()) return;
            await new Promise((done) => setTimeout(done, 25));
        }
        throw Error("Timed out awaiting stream event");
    };
    const controller = new AbortController();
    const events = [];
    let streamError;
    const streaming = (async () => {
        const response = await fetch("/api/v1/kv/events?prefix=stream%2F", { signal: controller.signal });
        equal(response.status, 200);
        if (!response.headers.get("content-type").includes("text/event-stream")) throw Error("Missing SSE content type");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
            const { value, done } = await reader.read();
            if (done) throw Error("Event stream ended before completion");
            buffer += decoder.decode(value, { stream: true });
            buffer = buffer.replace(/\r\n/g, "\n");
            let end;
            while ((end = buffer.indexOf("\n\n")) >= 0) {
                const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
                const type = frame.match(/^event: ?(.*)$/m)?.[1];
                const data = frame.match(/^data: ?(.*)$/m)?.[1];
                if (data) events.push({ type, data: JSON.parse(data), id: frame.match(/^id: ?(.*)$/m)?.[1] });
            }
        }
    })().catch((error) => { if (error.name !== "AbortError") streamError = String(error); });
    await check("SDK ready and SSE ready", async () => { await happy.ready; await until(() => events.some((event) => event.type === "ready")); });
    await check("1005 parallel-batched writes with SSE live", async () => {
        for (let offset = 0; offset < 1005; offset += 50) {
            const batch = await Promise.all(Array.from({ length: Math.min(50, 1005 - offset) }, (_, index) => put("many/" + String(offset + index).padStart(4, "0"), offset + index)));
            for (const response of batch) equal(response.status, 200);
            results.seeded += batch.length;
        }
        const write = await put("stream/after-bulk", "live"); equal(write.status, 200);
        await until(() => events.some((event) => event.data.key === "stream/after-bulk"));
        equal(streamError, undefined);
    });
    await check("GET kv pageCursor", async () => {
        const first = await call("GET", "/kv?prefix=many%2F&limit=1000");
        equal(first.status, 200); equal(first.json.entries.length, 1000);
        const last = await call("GET", "/kv?prefix=many%2F&limit=1000&pageCursor=" + encodeURIComponent(first.json.nextPageCursor));
        equal(last.status, 200); equal(last.json.entries.length, 5); equal(last.json.nextPageCursor, null);
    });
    await check("SDK kv.list past 1000", async () => {
        const entries = await happy.kv.list("many/"); equal(entries.length, 1005); equal(entries[1004].key, "many/1004");
    });
    await check("writeId replay and different-key rejection", async () => {
        const first = await put("replay", 1, {}, "replay-1"); equal(first.status, 200); equal(first.json.replayed, false);
        const second = await put("replay", 2, {}, "replay-1"); equal(second.status, 200); equal(second.json.replayed, true);
        equal(second.json.entry.version, first.json.entry.version); equal(second.json.entry.value, 1);
        equal((await call("GET", entry("replay"))).json.entry.value, 1);
        equal((await put("replay-other", 3, {}, "replay-1")).status, 400);
    });
    await check("If-Match quoted, bare and stale conflict body", async () => {
        const a = await put("conditional", 1); equal(a.status, 200);
        const b = await put("conditional", 2, { "if-match": a.json.entry.version }); equal(b.status, 200);
        const c = await put("conditional", 3, { "if-match": '"' + b.json.entry.version + '"' }); equal(c.status, 200);
        const conflict = await put("conditional", 4, { "if-match": a.json.entry.version });
        equal(conflict.status, 409); equal(conflict.json.entry.value, 3); equal(conflict.json.entry.version, c.json.entry.version);
    });
    await check("If-None-Match conflict and both conditions", async () => {
        const conflict = await put("conditional", 9, { "if-none-match": "*" }); equal(conflict.status, 409); equal(conflict.json.entry.value, 3);
        equal((await put("conditional", 9, { "if-match": "x", "if-none-match": "*" })).status, 400);
    });
    await check("DELETE tombstone and absent GET", async () => {
        const deleted = await call("DELETE", entry("conditional"), { writeId: "delete-1" });
        equal(deleted.status, 200); equal(deleted.json.entry.deleted, true); equal(deleted.json.entry.value, null);
        equal((await call("GET", entry("conditional"))).json.entry, null);
    });
    await check("changes distinct keys and paging", async () => {
        const since = (await call("GET", "/kv?limit=1")).json.cursor;
        await put("changes/x", 1); await put("changes/y", 1); await put("changes/x", 2);
        const path = "/kv/changes?prefix=changes%2F&since=" + encodeURIComponent(since);
        const changes = await call("GET", path); equal(changes.status, 200);
        equal(changes.json.changes.map(({ key, value }) => [key, value]), [["changes/y", 1], ["changes/x", 2]]);
        equal(changes.json.hasMore, false); equal((await call("GET", path + "&limit=1")).json.hasMore, true);
    });
    await check("future cursor returns 409 body", async () => {
        const future = (Date.now() + 365 * 864e5).toString(16).padStart(12, "0");
        const response = await call("GET", "/kv/changes?since=" + future.slice(0, 8) + "-" + future.slice(8) + "-7000-8000-000000000000");
        equal(response.status, 409); equal(response.json.code, "cursor_unavailable");
    });
    await check("large request and response bytes preserved; API 413", async () => {
        const value = "é🌍".repeat(20000);
        equal((await put("large", value)).status, 200);
        equal((await call("GET", entry("large"))).json.entry.value, value);
        const rejected = await put("too-large", "x".repeat(300 * 1024)); equal(rejected.status, 413); equal(rejected.json.code, "too_large");
    });
    await check("client.js ETag, conditional 304 and 404", async () => {
        const first = await call("GET", "/client.js"); equal(first.status, 200);
        const etag = first.headers.get("etag"); if (!etag) throw Error("ETag missing");
        equal((await call("GET", "/client.js", undefined, { "if-none-match": etag })).status, 304);
        equal((await call("GET", "/missing-route")).status, 404);
    });
    await check("SSE still delivers after every API assertion", async () => {
        const response = await put("stream/final", "still-live"); equal(response.status, 200);
        await until(() => events.some((event) => event.data.key === "stream/final"));
        equal(events.find((event) => event.data.key === "stream/final").id, response.json.entry.version);
        equal(streamError, undefined);
    });
    controller.abort(); await streaming;
    results.done = true;
    document.querySelector("#result").textContent = JSON.stringify(results);
})().catch((error) => { window.browserAPIResults = { done: true, failures: [String(error)] }; });