// api/keep-alive.ts
// Vercel Cron Job — не дає Supabase заснути
// Запускається автоматично за розкладом із vercel.json

export default async function handler(req: any, res: any) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // Захист: впускаємо тільки Vercel Cron або ручні виклики
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
    const response = await fetch(
      `${supabaseUrl}/rest/v1/zakaz?select=id&order=id.desc&limit=1`,
      {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
        },
      },
    );

    if (!response.ok) {
      return res
        .status(500)
        .json({ error: `Supabase HTTP ${response.status}` });
    }

    const data = await response.json();
    return res
      .status(200)
      .json({ ok: true, message: "✅ Supabase активна", data });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
