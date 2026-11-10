// supabase/functions/send-telegram/index.ts
// ═══════════════════════════════════════════════════════
// 📤 Send Telegram Message — допоміжна Edge Function
// Викликається для відправки нагадувань у Telegram
// ═══════════════════════════════════════════════════════

// @ts-ignore: Deno module
import { createClient } from "npm:@supabase/supabase-js@2";
import { operationalLog } from "../_shared/operationalLog.ts";

const TELEGRAM_BOT_SETTING_ID = 19;

// 🔐 CORS: обмежені домени замість wildcard
function getCorsHeaders(req: Request): Record<string, string> {
  const allowedRaw = Deno.env.get("ALLOWED_ORIGINS") || "";
  const allowedOrigins = allowedRaw
    .split(",")
    .map((o: string) => o.trim())
    .filter((o: string) => o.length > 0);

  const origin = req.headers.get("origin") || "";
  const isAllowed = allowedOrigins.length === 0 || allowedOrigins.includes(origin);

  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : allowedOrigins[0] || "",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

async function loadTelegramBotToken(
  supabase: ReturnType<typeof createClient>,
): Promise<string> {
  try {
    const { data, error } = await supabase
      .from("settings")
      .select('"Загальні"')
      .eq("setting_id", TELEGRAM_BOT_SETTING_ID)
      .maybeSingle();

    if (!error && data) {
      const token = String((data as any)?.["Загальні"] || "").trim();
      if (token) return token;
    }
  } catch (e) {
    console.error("loadTelegramBotToken DB error:", e);
  }

  return "";
}

Deno.serve(async (req: Request): Promise<Response> => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // 🔐 Перевірка авторизації — приймаємо Supabase JWT або apikey
  const authHeader = req.headers.get("authorization") || "";
  const apiKey = req.headers.get("apikey") || "";
  if (!authHeader && !apiKey) {
    return new Response(
      JSON.stringify({ success: false, error: "Unauthorized" }),
      {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Supabase service credentials not configured",
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);
    const BOT_TOKEN = await loadTelegramBotToken(supabase);

    if (!BOT_TOKEN) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Telegram bot token not configured",
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const {
      chat_id,
      text,
      parse_mode = "Markdown",
      reply_markup,
    }: {
      chat_id?: number;
      text?: string;
      parse_mode?: string;
      reply_markup?: Record<string, unknown>;
    } = await req.json();

    if (!chat_id || !text) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "chat_id and text are required",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Відправити через Telegram Bot API
    const tgResp = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id,
          text,
          parse_mode,
          disable_web_page_preview: true,
          ...(reply_markup ? { reply_markup } : {}),
        }),
      },
    );

    const tgText = await tgResp.text();
    operationalLog(tgResp.ok ? "debug" : "error", "telegram.send.response", { status: tgResp.status });

    if (!tgResp.ok) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Telegram API ${tgResp.status}`,
          body: tgText.slice(0, 300),
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    let result: unknown;
    try {
      result = JSON.parse(tgText);
    } catch {
      result = tgText;
    }

    return new Response(JSON.stringify({ success: true, result }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("send-telegram error:", msg);
    return new Response(JSON.stringify({ success: false, error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
