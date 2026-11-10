import { updateAllBd, updateTableNameDisplay } from '../dodatu_inchi_bazu_danux';
import { mountDirectoryDropdown, directoryId } from './directoryRead';
export async function handlePruimalnikClick(): Promise<void> {
 const old = document.getElementById('search-input-all_other_bases') as HTMLInputElement | null;
 const dropdown = document.getElementById('custom-dropdown-all_other_bases'); if (!old || !dropdown) return;
 const input = old.cloneNode(true) as HTMLInputElement;
 delete input.dataset.keyboardNavBound; old.replaceWith(input);
 input.value = ''; input.disabled = false; input.readOnly = false; input.title = '';
 input.style.backgroundColor = ''; input.style.cursor = '';
 let selected: any = null;
 updateTableNameDisplay('Приймальник', 'receivers');
 const updateDraft = () => {
   if (!input.value.trim()) selected = null;
   updateAllBd(JSON.stringify({ table: 'receivers', [directoryId('receivers')]: selected?.[directoryId('receivers')] ?? null, data: selected?.data || { Name: input.value.trim() } }));
 };
 updateDraft();
 mountDirectoryDropdown('receivers', input, dropdown, row => { selected = row; updateDraft(); }, updateDraft);
}
export const initPruimalnik = () => {};
