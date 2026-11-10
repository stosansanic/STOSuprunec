import { updateAllBd, updateTableNameDisplay } from '../dodatu_inchi_bazu_danux';
import { mountDirectoryDropdown, directoryId } from './directoryRead';
export async function handleDhereloClick(): Promise<void> {
 const old = document.getElementById('search-input-all_other_bases') as HTMLInputElement | null;
 const dropdown = document.getElementById('custom-dropdown-all_other_bases'); if (!old || !dropdown) return;
 const input = old.cloneNode(true) as HTMLInputElement;
 delete input.dataset.keyboardNavBound; old.replaceWith(input);
 input.value = ''; input.disabled = false; input.readOnly = false; input.title = '';
 input.style.backgroundColor = ''; input.style.cursor = '';
 let selected: any = null;
 updateTableNameDisplay('Джерело', 'incomes');
 const updateDraft = () => {
   if (!input.value.trim()) selected = null;
   updateAllBd(JSON.stringify({ table: 'incomes', [directoryId('incomes')]: selected?.[directoryId('incomes')] ?? null, data: selected?.data || { Name: input.value.trim() } }));
 };
 updateDraft();
 mountDirectoryDropdown('incomes', input, dropdown, row => { selected = row; updateDraft(); }, updateDraft);
}
export const initDherelo = () => {};
