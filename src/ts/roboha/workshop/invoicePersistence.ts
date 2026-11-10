import { supabase } from "../../vxid/supabaseClient";

// Read-only preflight. Actual persistence remains in the existing stock writer.
export async function assertInvoiceOriginsNotPresent(origins: string[]): Promise<void> {
  const unique = [...new Set(origins.filter(Boolean))];
  let legacy = false;
  for (let offset = 0; offset < unique.length; offset += 100) {
    const chunk = unique.slice(offset, offset + 100);
    if (!legacy) {
      const response = await supabase.rpc("traffic_invoice_origins", { p_origins: chunk });
      if (response.error) {
        if (["PGRST202", "42883"].includes(response.error.code)) legacy = true;
        else throw new Error("Не вдалося перевірити повторний імпорт. Запис зупинено.");
      } else {
        if (!Array.isArray(response.data)) throw new Error("Некоректна відповідь перевірки імпорту. Запис зупинено.");
        if (response.data.length) throw new Error("Позицію цієї накладної вже записано. Оновіть склад, щоб не оприбуткувати її повторно.");
        continue;
      }
    }
    for (const origin of chunk) {
      const literal = origin.replace(/[\\%_]/g, "\\$&");
      const { data, error } = await supabase.from("sclad").select("sclad_id")
        .like("prumitka", `%${literal}%`).limit(1);
      if (error) throw new Error("Не вдалося перевірити повторний імпорт. Запис зупинено.");
      if (data?.length) throw new Error("Позицію цієї накладної вже записано. Оновіть склад, щоб не оприбуткувати її повторно.");
    }
  }
}
