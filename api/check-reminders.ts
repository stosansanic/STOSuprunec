// api/check-reminders.ts
// Vercel Cron -> Supabase Edge Function check-reminders
// Працює навіть коли браузер користувача закритий.

export default async function handler(req: any, res: any) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const authHeader =
    req.headers["authorization"] || req.headers["Authorization"];
  if (
    process.env.CRON_SECRET &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const supabaseUrl =
    process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({
      error:
        "Missing SUPABASE_URL/SUPABASE_ANON_KEY or VITE_SUPABASE_URL/VITE_SUPABASE_KEY env vars",
    });
  }

  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/check-reminders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify({ source: "vercel-cron" }),
    });

    const text = await response.text();
    let payload: unknown = text;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      /* keep raw text */
    }

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error: `check-reminders HTTP ${response.status}`,
        payload,
      });
    }

    return res.status(200).json({ ok: true, payload });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
