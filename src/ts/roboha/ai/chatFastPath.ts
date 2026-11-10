/** Only complete social phrases: never swallow an appended database/action request. */
export function isTrivialQuery(query: string): boolean {
  const q = query.toLowerCase().trim().replace(/[.!?…]+$/u, "").trim();
  return /^(привіт|здоров|здрастуй|вітаю|салам|хай|hello|hi|дякую|дуже дякую|спасибі|спс|дяка|ок|окей|зрозуміло|добре|ясно|гуд|бувай|до побачення|поки|пока|хто ти|як тебе звати|що ти вмієш|що ти можеш|help|як справи|що можеш)$/u.test(q);
}
