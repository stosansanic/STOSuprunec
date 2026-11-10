// supabase/functions/groq-chat/index.ts
// Thin Groq proxy for browser clients: avoids CORS failures and keeps DB keys server-side.

// @ts-ignore: Deno module
import { createClient } from "npm:@supabase/supabase-js@2";

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

function getCorsHeaders(req: Request): Record<string, string> {
  // @ts-ignore
  const allowedRaw = Deno.env.get("ALLOWED_ORIGINS") || "";
  const allowedOrigins = allowedRaw
    .split(",")
    .map((o: string) => o.trim())
    .filter((o: string) => o.length > 0);

  const origin = req.headers.get("origin") || "";
  const isAllowed =
    allowedOrigins.length === 0 || allowedOrigins.includes(origin);

  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : allowedOrigins[0] || "",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

function jsonResp(
  corsHeaders: Record<string, string>,
  data: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

async function loadGroqKey(
  settingId: number | null,
  bodyKey: string,
): Promise<string> {
  if (settingId && settingId > 0) {
    // @ts-ignore
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
    // @ts-ignore
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    if (!SUPABASE_URL || !SERVICE_ROLE) {
      throw new Error("Supabase service credentials not configured");
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { data, error } = await supabase
      .from("settings")
      .select("Загальні")
      .eq("setting_id", settingId)
      .maybeSingle();

    if (error) throw error;

    const dbKey = String((data as any)?.["Загальні"] || "").trim();
    if (dbKey) return dbKey;
  }

  if (bodyKey.trim()) return bodyKey.trim();

  // @ts-ignore
  return (Deno.env.get("GROQ_API_KEY") || "").trim();
}

// @ts-ignore: Deno global
Deno.serve(async (req: Request): Promise<Response> => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const authHeader = req.headers.get("authorization") || "";
  const apiKeyHeader = req.headers.get("apikey") || "";
  if (!authHeader && !apiKeyHeader) {
    return jsonResp(corsHeaders, { ok: false, error: "Unauthorized" }, 401);
  }

  try {
    const body = await req.json();
    const settingId =
      typeof body?.setting_id === "number" ? body.setting_id : null;
    const requestBody = body?.request;

    if (!requestBody || typeof requestBody !== "object") {
      return jsonResp(corsHeaders, {
        ok: false,
        status: 400,
        errorText: "Missing Groq request body",
      });
    }

    const groqKey = await loadGroqKey(settingId, String(body?.api_key || ""));
    if (!/^gsk_/i.test(groqKey)) {
      return jsonResp(corsHeaders, {
        ok: false,
        status: 400,
        errorText: "Groq API key is missing or has invalid format",
      });
    }

    const groqResp = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${groqKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    const groqText = await groqResp.text();
    let parsed: unknown = groqText;
    try {
      parsed = JSON.parse(groqText);
    } catch {
      /* keep text */
    }

    return jsonResp(corsHeaders, {
      ok: groqResp.ok,
      status: groqResp.status,
      data: groqResp.ok ? parsed : null,
      errorText: groqResp.ok
        ? ""
        : typeof parsed === "string"
          ? parsed.slice(0, 2000)
          : JSON.stringify(parsed).slice(0, 2000),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("groq-chat error:", msg);
    return jsonResp(corsHeaders, { ok: false, status: 500, errorText: msg });
  }
});
