// Run with deno test --no-config --allow-env --allow-read. All HTTP is mocked.
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
Deno.test("Dashboard function boots without secrets, handles CORS and authenticates through mocked Supabase", async () => {
  const names = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY", "SUPABASE_SECRET_KEYS", "ALLOWED_ORIGINS", "NP_ENCRYPTION_KEY"];
  const saved = names.map(name => Deno.env.get(name));
  const originalServe = Deno.serve;
  const originalFetch = globalThis.fetch;
  let handler!: (request: Request) => Promise<Response>;
  let passwordValid = false;
  let sessions = 0;
  let syncing = false;
  let providerData: unknown = [];
  let incomingData: unknown = [];
  let rejectListing = false;
  let disabled = false;
  let imported: Record<string, unknown>[] = [];
  let savedDetails: { ttn: string; details: Record<string, unknown> }[] = [];
  let encrypted = "";
  const userId = "00000000-0000-4000-8000-000000000001";
  try {
    names.forEach(name => Deno.env.delete(name));
    Deno.serve = ((fn: typeof handler) => { handler = fn; return {}; }) as typeof Deno.serve;
    globalThis.fetch = async (input, options) => {
      const req = new Request(input, options);
      const url = new URL(req.url);
      const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      if (url.hostname === "api.novaposhta.ua") {
        const body = await req.json();
        if (["getOutgoingDocumentsByPhone", "getIncomingDocumentsByPhone"].includes(body.calledMethod)) {
          assert(!("system" in body) && body.apiKey === "fixture-api-key", "Lists must use API-key authentication without PA 3.0");
          assert(body.methodProperties.DateFrom.endsWith("00:00:00") && body.methodProperties.DateTo.endsWith("00:00:00"), "Use DateFrom/DateTo for phone lists");
          const rows = body.calledMethod === "getOutgoingDocumentsByPhone" ? providerData : incomingData;
          return rejectListing ? json({ success: false, errors: ["API key expired"] }) : json({ success: true, data: [{ result: body.methodProperties.Page === 1 ? rows : [] }] });
        }
        if (body.calledMethod === "getStatusDocuments") return json({ success: true, data: imported.map(row => ({ Number: row.ttn, StatusCode: "5" })) });
      }
      if (syncing) {
        if (url.pathname === "/rest/v1/np_sessions") return json({ employee_id: 1 });
        if (url.pathname === "/rest/v1/rpc/np_claim_sync") return json("fixture-lock");
        if (url.pathname === "/rest/v1/rpc/np_secret") return json(encrypted);
        if (url.pathname === "/rest/v1/rpc/np_apply_document_details") { savedDetails = (await req.json()).p_rows; return json(null); }
        if (url.pathname === "/rest/v1/np_connections") {
          if (req.method === "GET") return json({ enabled: true, import_page: 1, phone: "" });
          if ((await req.json()).enabled === false) disabled = true;
          return json(null);
        }
        if (url.pathname === "/rest/v1/np_shipments") {
          if (req.method === "POST") { imported = await req.json(); return json(null); }
          return json(imported.map((row, id) => ({ ...row, id: String(id) })));
        }
        if (url.pathname === "/rest/v1/rpc/np_apply_tracking" || url.pathname === "/rest/v1/np_sync_runs") return json(null);
      }
      if (url.pathname === "/auth/v1/user") return json({ id: userId, email: "fixture@example.com" });
      if (url.pathname === "/rest/v1/whitelist") return json({ email: "fixture@example.com" });
      if (url.pathname === "/rest/v1/rpc/np_rate") return json(true);
      if (url.pathname === "/rest/v1/rpc/verify_slyusar_password") return json([{ is_valid: passwordValid, slyusar_id: 1 }]);
      if (url.pathname === "/rest/v1/slyusars") return json({ slyusar_id: 1, data: { Name: "Fixture", Доступ: "Адміністратор" } });
      if (url.pathname === "/rest/v1/np_access") return json(null);
      if (url.pathname === "/rest/v1/np_connections") return json([]);
      if (url.pathname === "/rest/v1/np_sessions" && req.method === "POST") {
        const row = await req.json();
        assert(row.auth_uid === userId && /^[a-f0-9]{64}$/.test(row.token_hash), "Store only the session token hash");
        sessions++;
        return new Response(null, { status: 201 });
      }
      throw new Error(`Unexpected test request: ${req.method} ${url.pathname}`);
    };
    const target = Deno.env.get("NP_FUNCTION_TEST_PATH");
    await import(target || "../supabase/functions/nova-poshta/index.ts");
    const request = (method: string, body?: object) => handler(new Request("https://fixture.invalid/nova-poshta", {
      method, headers: { origin: "https://fixture.example", authorization: "Bearer fixture-jwt", "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }));
    const options = await request("OPTIONS");
    assert(options.ok && options.headers.get("access-control-allow-origin") === "https://fixture.example", "CORS must work without secrets");
    for (const config of [undefined, "null", "[1]", "malformed"]) {
      if (config) Deno.env.set("SUPABASE_SECRET_KEYS", config);
      const response = await request("GET");
      assert(response.status === 503 && (await response.json()).code === "SERVER_CONFIG", "Invalid configuration must return structured 503, not crash at boot");
    }
    Deno.env.set("SUPABASE_URL", "https://fixture.supabase.co");
    Deno.env.set("SUPABASE_SECRET_KEYS", JSON.stringify({ default: "sb_secret_fixture" }));
    assert((await request("GET")).ok, "Readiness succeeds with named secret keys");
    const rejected = await request("POST", { action: "authenticate", name: "Fixture", password: "wrong" });
    assert(rejected.status === 403 && sessions === 0, "Wrong password must not create a session");
    passwordValid = true;
    const accepted = await request("POST", { action: "authenticate", name: "Fixture", password: "fixture" });
    const result = await accepted.json();
    assert(accepted.ok && result.actor.id === 1 && result.token.length === 72 && Number(sessions) === 1, "Successful login returns a password-verified session");
    syncing = true;
    Deno.env.set("NP_ENCRYPTION_KEY", "ab".repeat(32));
    const encryptionKey = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(171), "AES-GCM", false, ["encrypt"]);
    const iv = new Uint8Array(12);
    const bytes = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, encryptionKey, new TextEncoder().encode("fixture-api-key")));
    encrypted = btoa(String.fromCharCode(...iv, ...bytes));
    const runSync = async () => (await request("POST", { action: "sync", session: result.token })).json();
    const empty = await runSync();
    assert(empty.import?.fetched === 0 && empty.message.includes("0 вхідних та вихідних накладних"), "Empty provider list must be explained, not reported as zero updated only");
    providerData = [{ Number: "59 0017 8913 9523", CargoDescription: "Fixture", ScheduledDeliveryDate: "02.10.2026", ArrivalDateTime: "01.01.0001 00:00:00", SenderName: "Fixture sender", PhoneSender: "380000000000" }];
    incomingData = [{ Number: "59001789080864", CargoDescription: "Incoming fixture" }];
    const populated = await runSync();
    assert(populated.import?.accepted === 2 && populated.updated === 2 && imported[0].ttn === "59001789139523", "Import normalizes whitespace and tracks both lists");
    assert(imported[0].direction === "outgoing" && imported[1].direction === "incoming" && imported[0].provider_description === "Fixture" && imported[0].estimated_date === "2026-10-02", "Preserve direction, description and delivery date");
    assert(savedDetails[0].details.sender === "Fixture sender" && savedDetails[0].details.sender_phone === "380000000000" && savedDetails[0].details.delivery === "2026-10-02", "Persist sender fields and discard sentinel arrival date");
    rejectListing = true;
    const listingRejected = await runSync();
    assert(listingRejected.updated === 2 && !disabled, "A listing authorization error must not disable valid tracking for saved TTNs");
    rejectListing = false;
    providerData = [{ unexpected: "value" }];
    incomingData = [];
    const invalid = await runSync();
    assert(invalid.import?.skipped === 1 && invalid.message.includes("коректного номера"), "Invalid TTNs must not silently disappear");
    providerData = {};
    const malformed = await runSync();
    assert(malformed.message.includes("неочікуваний формат"), "Malformed provider data must not appear as an empty list");
  } finally {
    Deno.serve = originalServe;
    globalThis.fetch = originalFetch;
    names.forEach((name, index) => saved[index] === undefined ? Deno.env.delete(name) : Deno.env.set(name, saved[index]!));
  }
});
