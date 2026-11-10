import { updateAllBd, updateTableNameDisplay } from "../dodatu_inchi_bazu_danux";
import { mountDirectoryDropdown } from "./directoryRead";

/** Selection identifies the edited row; typing a replacement name never changes its ID. */
export async function handleRobotaClick(): Promise<void> {
  const input = document.getElementById("search-input-all_other_bases") as HTMLInputElement | null;
  const dropdown = document.getElementById("custom-dropdown-all_other_bases");
  if (!input || !dropdown) return;
  let selected: { work_id: number; data: string } | null = null;
  const updateDraft = () => {
    if (!input.value.trim()) selected = null;
    updateAllBd(JSON.stringify({
      table: "works",
      work_id: selected?.work_id ?? null,
      data: selected?.data ?? "",
    }));
  };
  input.value = "";
  updateTableNameDisplay("Робота", "works");
  updateDraft();
  mountDirectoryDropdown("works", input, dropdown, row => {
    selected = { work_id: row.work_id, data: row.data };
    updateDraft();
  }, updateDraft);
}

export const initRobota = () => {};
