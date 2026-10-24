import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoveryProof, discoverySecret, newDiscoveryQuery } from "@aso/shared";
import { startWorker } from "@aso/worker";
import { hardware, tempDir, TOKEN, waitFor, withHub } from "./helpers.ts";

const NONCE = "AAAAAAAAAAAAAAAAAAAAAA";
const CLAIM = { nonce: NONCE, port: 7420, addresses: ["192.168.101.112"] };

const call = (port: number, route: string, body: unknown, auth: string | null = TOKEN) =>
  fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST",
    headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: (await r.json().catch(() => null)) as { proof?: string; code?: string; id?: string; key?: string } | null }));

/** Ask the Hub for the proof answering a query made with `credential`. */
const proofFor = (port: number, credential: string, auth: string | null = TOKEN) =>
  call(port, "/api/discovery/proof", { key: newDiscoveryQuery(credential, NONCE).key, ...CLAIM }, auth);

describe("LAN discovery on the Hub", () => {
  it("proves it holds its token, a worker key or an open join code, and nothing else", () =>
    withHub(async ({ port }) => {
      const own = await proofFor(port, TOKEN);
      assert.equal(own.status, 200);
      assert.equal(own.body?.proof, discoveryProof(discoverySecret(TOKEN), CLAIM));

      const code = (await call(port, "/api/worker-keys/join-codes", {})).body!.code!;
      assert.equal((await proofFor(port, code)).body?.proof, discoveryProof(discoverySecret(code), CLAIM), "a joining machine finds the Hub with its code");
      const joined = (await call(port, "/api/worker-keys/join", { code, machine: "avalon" }, null)).body!;
      assert.equal((await proofFor(port, code)).status, 404, "a used code no longer works");
      assert.equal((await proofFor(port, joined.key!)).body?.proof, discoveryProof(discoverySecret(joined.key!), CLAIM));

      await call(port, `/api/worker-keys/${joined.id}/revoke`, {});
      assert.equal((await proofFor(port, joined.key!)).status, 404, "a revoked key is shut out of discovery too");
      assert.equal((await proofFor(port, "asow_never-issued")).status, 404);
    }));

  it("answers only the Hub's token, and only well-formed claims", () =>
    withHub(async ({ port }) => {
      const code = (await call(port, "/api/worker-keys/join-codes", {})).body!.code!;
      const joined = (await call(port, "/api/worker-keys/join", { code, machine: "avalon" }, null)).body!;
      assert.equal((await proofFor(port, TOKEN, null)).status, 401);
      assert.equal((await proofFor(port, TOKEN, joined.key!)).status, 401, "a worker key can't ask for proofs");
      assert.equal((await call(port, "/api/discovery/proof", { key: "x", ...CLAIM })).status, 400);
      assert.equal((await call(port, "/api/discovery/proof", { key: newDiscoveryQuery(TOKEN).key, ...CLAIM, addresses: [] })).status, 400);
    }));
});

describe("a worker finding the Hub", () => {
  const listNodes = async (port: number) =>
    (await (await fetch(`http://127.0.0.1:${port}/api/nodes`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as Array<{ nodeId: string }>;
  const common = { token: TOKEN, hardware: hardware(), sandbox: "none" as const };

  it("connects to the Hub it locates when it has no address", () =>
    withHub(async ({ port }) => {
      const worker = await startWorker({ ...common, nodeId: "found", workDir: tempDir(), locate: async () => `127.0.0.1:${port}` });
      try {
        await waitFor(async () => (await listNodes(port)).some((n) => n.nodeId === "found") || undefined);
        assert.equal(worker.hubUrl()?.host, `127.0.0.1:${port}`);
      } finally {
        worker.stop();
      }
    }));

  it("looks again when the Hub isn't where it was, and keeps trying until one answers", () =>
    withHub(async ({ port }) => {
      let asked = 0;
      // The first look finds nothing; then the Hub is found at its new address.
      const locate = async () => (++asked === 1 ? undefined : `127.0.0.1:${port}`);
      const worker = await startWorker({ ...common, nodeId: "moved", workDir: tempDir(), hub: "127.0.0.1:1", locate });
      try {
        await waitFor(async () => (await listNodes(port)).some((n) => n.nodeId === "moved") || undefined, 10_000);
        assert.ok(asked >= 2);
        assert.equal(worker.hubUrl()?.port, String(port));
      } finally {
        worker.stop();
      }
    }));

  it("checks the Hub's address before every connection, and keeps trying while it is refused", () =>
    withHub(async ({ port }) => {
      let checks = 0;
      // The first check refuses (say the name resolved to a public address); later ones pass.
      const checkHub = async (url: URL) => {
        assert.equal(url.port, String(port));
        if (++checks === 1) throw new Error("the Hub is on the internet");
      };
      const worker = await startWorker({ ...common, nodeId: "checked", workDir: tempDir(), hub: `127.0.0.1:${port}`, checkHub });
      try {
        await waitFor(async () => (await listNodes(port)).some((n) => n.nodeId === "checked") || undefined, 10_000);
        assert.equal(checks, 2, "refused once, then connected");
      } finally {
        worker.stop();
      }
    }));

  it("needs an address or a way to find one", async () => {
    await assert.rejects(startWorker({ ...common, workDir: tempDir() }), /needs the Hub's address or a way to find it/);
  });
});
