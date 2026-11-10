import "../../../scss/robocha/planyvannya/_planyvannya_post.scss";
import { supabase } from "../../vxid/supabaseClient";
import { showNotification } from "../zakaz_naraudy/inhi/vspluvauhe_povidomlenna";
import { logAction } from "../../utils/auditLogger";

export interface PostData { cehTitle: string; title: string; subtitle: string; staffId?: number; categoryId?: number; postId?: number; actor?: string }
export type PostSubmitCallback = (data: PostData) => void | Promise<void>;
export interface PostDirectoryReceipt {
  status: "created" | "updated" | "deleted" | "unchanged";
  category: { category_id: number; category: string } | null;
  post: { post_id: number; name: string; category: number } | null;
}
type DirectoryCallback = (receipt: PostDirectoryReceipt) => void | Promise<void>;
type Kind = "category" | "post" | "staff";
type Action = "add" | "edit" | "delete";
interface Choice { id: number; name: string; category?: number }
interface Page { items: Choice[]; has_more: boolean; next_cursor: number | null }
interface Menu {
  input: HTMLInputElement; list: HTMLElement; kind: Kind; revision: number;
  query: string; after: number | null; more: boolean; loading: boolean;
  scrollIntent: boolean;
  timer?: ReturnType<typeof setTimeout>;
}
const normalize = (value: string) => value.trim().replace(/\s+/gu, " ").toLowerCase();
const actor = () => localStorage.getItem("userAuthData") || "";
const validId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

/** A session owns its selections, compact pages and pending writes. */
export class PostModal {
  private modalOverlay: HTMLElement | null = null;
  private onSubmitCallback: PostSubmitCallback | null = null;
  private onDirectoryChange: DirectoryCallback | null = null;
  private isOpen = false;
  private isLocked = true;
  private isSubmitting = false;
  private currentActionState: Action = "add";
  private generation = 0;
  private owner = "";
  private selectedCategory: Choice | null = null;
  private selectedPost: Choice | null = null;
  private selectedStaff: Choice | null = null;
  private pages = new Map<string, Page>();
  private pending = new Map<string, Promise<Page>>();
  private menus: Menu[] = [];
  private controller: AbortController | null = null;

  constructor() { this.createModalHTML(); this.bindEvents(); }
  private field(id: string): HTMLInputElement { return document.getElementById(id) as HTMLInputElement; }
  private current(generation = this.generation): boolean {
    return this.isOpen && this.generation === generation && this.owner === actor();
  }
  private available(): boolean {
    if (!this.isOpen || this.isSubmitting) return false;
    if (!this.current()) {
      this.finishClose();
      showNotification("Користувач змінився. Відкрийте форму повторно.", "error");
      return false;
    }
    return true;
  }

  private createModalHTML(): void {
    this.modalOverlay = document.getElementById("postPostModalOverlay");
    if (this.modalOverlay) return;
    document.body.insertAdjacentHTML("beforeend", `
      <div class="post-modal-overlay" id="postPostModalOverlay" style="display:none">
        <div class="post-modal" id="postPostModal" role="dialog" aria-modal="true" aria-labelledby="postPostModalTitle">
          <div class="post-modal-header">
            <h2 class="post-modal-title" id="postPostModalTitle">Новий пост</h2>
            <button type="button" class="post-edit-mode-btn" id="postModalLockBtn" title="Довідник цехів і постів"><span class="icon-view">🔒</span><span class="icon-edit">🔓</span></button>
            <div class="post-modal-controls" id="postModalControls"><button id="postModalAddBtn" class="post-mode-toggle-btn post-mode--add" type="button">Додати</button></div>
            <button type="button" class="post-modal-close" id="postPostModalClose" aria-label="Закрити"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
          </div>
          <div class="post-modal-body">
            <div class="post-form-group post-autocomplete-wrapper"><label class="post-form-label" id="postCehFormLabelTitle" for="postCehFormInputTitle">Назва цеху</label><input type="text" class="post-form-input" id="postCehFormInputTitle" placeholder="Наприклад: ЦЕХ зварювання" autocomplete="off"><div class="post-autocomplete-dropdown" id="postCehDropdown"></div></div>
            <div class="post-form-group post-autocomplete-wrapper"><label class="post-form-label" id="postPostFormLabelTitle" for="postPostFormInputTitle">Назва поста</label><input type="text" class="post-form-input" id="postPostFormInputTitle" placeholder="Наприклад: Пост розвал-сходження" autocomplete="off"><div class="post-autocomplete-dropdown" id="postPostNameDropdown"></div></div>
            <div class="post-form-group post-autocomplete-wrapper" id="postPostFormGroupSubtitle"><label class="post-form-label" for="postPostFormInputSubtitle">Слюсар</label><input type="text" class="post-form-input" id="postPostFormInputSubtitle" placeholder="Наприклад: Шевченко Т.Г" autocomplete="off"><div class="post-autocomplete-dropdown" id="postSlyusarDropdown"></div></div>
          </div>
          <div class="post-modal-footer"><button type="button" class="post-btn post-btn-secondary" id="postPostModalCancel">Скасувати</button><button type="button" class="post-btn post-btn-primary" id="postPostModalSubmit">Створити</button></div>
        </div>
      </div>`);
    this.modalOverlay = document.getElementById("postPostModalOverlay");
  }
  private bindEvents(): void {
    document.getElementById("postPostModalClose")?.addEventListener("click", () => this.close());
    document.getElementById("postPostModalCancel")?.addEventListener("click", () => this.close());
    document.getElementById("postPostModalSubmit")?.addEventListener("click", () => { void this.handleSubmit(); });
    document.getElementById("postModalLockBtn")?.addEventListener("click", () => this.toggleLockMode());
    document.getElementById("postModalAddBtn")?.addEventListener("click", () => this.cycleActionState());
    this.modalOverlay?.addEventListener("click", event => { if (event.target === this.modalOverlay) this.close(); });
    document.addEventListener("click", event => {
      for (const menu of this.menus) if (event.target !== menu.input && !menu.list.contains(event.target as Node)) this.closeMenu(menu);
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && this.isOpen && !this.menus.some(menu => menu.list.style.display === "block")) this.close();
    });
    this.bindMenu("category", "postCehFormInputTitle", "postCehDropdown");
    this.bindMenu("post", "postPostFormInputTitle", "postPostNameDropdown");
    this.bindMenu("staff", "postPostFormInputSubtitle", "postSlyusarDropdown");
  }
  private bindMenu(kind: Kind, inputId: string, listId: string): void {
    const input = this.field(inputId), list = document.getElementById(listId);
    if (!input || !list) return;
    const menu: Menu = { kind, input, list, revision: 0, query: "", after: null, more: false, loading: false, scrollIntent: false };
    this.menus.push(menu);
    input.setAttribute("role", "combobox"); input.setAttribute("aria-controls", listId); input.setAttribute("aria-autocomplete", "list");
    list.setAttribute("role", "listbox");
    const open = () => { if (this.available() && document.activeElement === input) void this.showMenu(menu); };
    input.addEventListener("focus", open); input.addEventListener("click", open);
    input.addEventListener("input", () => {
      this.closeMenu(menu);
      if (!this.available()) return;
      this.onTyped(kind);
      menu.timer = setTimeout(open, 250);
    });
    input.addEventListener("blur", () => this.closeMenu(menu));
    list.addEventListener("mousedown", event => { event.preventDefault(); menu.scrollIntent = true; });
    const loadMore = () => {
      if (menu.scrollIntent && !menu.loading && menu.more && list.style.display === "block" && list.scrollTop + list.clientHeight >= list.scrollHeight - 35) {
        menu.scrollIntent = false;
        void this.showMenu(menu, true);
      }
    };
    list.addEventListener("wheel", event => { if (event.deltaY > 0) { menu.scrollIntent = true; loadMore(); } }, { passive: true });
    let touchY: number | null = null;
    list.addEventListener("touchstart", event => { touchY = event.touches[0]?.clientY ?? null; }, { passive: true });
    list.addEventListener("touchmove", event => {
      const nextY = event.touches[0]?.clientY;
      if (touchY !== null && nextY !== undefined && nextY < touchY) { menu.scrollIntent = true; loadMore(); }
      touchY = nextY ?? null;
    }, { passive: true });
    list.addEventListener("scroll", loadMore);
    input.addEventListener("keydown", event => {
      if (event.key === "Escape") { this.closeMenu(menu); event.preventDefault(); event.stopPropagation(); return; }
      const choices = Array.from(list.querySelectorAll<HTMLElement>(".post-autocomplete-option[data-choice]"));
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (list.style.display !== "block") { open(); return; }
        const current = choices.findIndex(choice => choice.classList.contains("active"));
        const next = Math.max(0, Math.min(choices.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
        choices.forEach((choice, index) => choice.classList.toggle("active", index === next));
        if (event.key === "ArrowDown" && next === choices.length - 1) menu.scrollIntent = true;
        choices[next]?.scrollIntoView({ block: "nearest" });
        loadMore();
      } else if (event.key === "Enter" && list.style.display === "block") {
        event.preventDefault(); choices.find(choice => choice.classList.contains("active"))?.click();
      }
    });
  }
  private onTyped(kind: Kind): void {
    const editing = !this.isLocked && this.currentActionState === "edit";
    if (kind === "category") {
      if (!editing) this.selectedCategory = null;
      if (!editing) { this.selectedPost = null; this.field("postPostFormInputTitle").value = ""; }
      const postMenu = this.menus.find(menu => menu.kind === "post"); if (postMenu) this.closeMenu(postMenu);
    } else if (kind === "post" && !editing) this.selectedPost = null;
    else if (kind === "staff") this.selectedStaff = null;
  }
  private choose(kind: Kind, choice: Choice): void {
    if (!this.available()) return;
    if (kind === "category") {
      this.selectedCategory = { ...choice }; this.selectedPost = null;
      this.field("postCehFormInputTitle").value = choice.name;
      this.field("postPostFormInputTitle").value = "";
    } else if (kind === "post") {
      if (choice.category !== this.selectedCategory?.id) return;
      this.selectedPost = { ...choice }; this.field("postPostFormInputTitle").value = choice.name;
    } else { this.selectedStaff = { ...choice }; this.field("postPostFormInputSubtitle").value = choice.name; }
    this.closeAllDropdowns();
  }
  private closeMenu(menu: Menu): void {
    menu.revision++; clearTimeout(menu.timer); menu.timer = undefined;
    menu.list.replaceChildren(); menu.list.style.display = "none";
    menu.input.setAttribute("aria-expanded", "false");
    menu.loading = false; menu.more = false; menu.after = null; menu.scrollIntent = false;
  }
  private closeAllDropdowns(): void { this.menus.forEach(menu => this.closeMenu(menu)); }
  private async readPage(kind: Kind, category: number | null, query: string, after: number | null): Promise<Page> {
    if (!this.current()) throw new Error("Користувач змінився. Відкрийте форму повторно.");
    const generation = this.generation, key = JSON.stringify([kind, category, query, after]);
    const saved = this.pages.get(key); if (saved) return saved;
    // A complete broader page can safely answer more specific text without another request.
    for (const [entryKey, page] of this.pages) {
      const [entryKind, entryCategory, entryQuery, entryAfter] = JSON.parse(entryKey);
      if (entryKind !== kind || entryCategory !== category || entryAfter !== null || page.has_more || !query.includes(entryQuery)) continue;
      const rows = page.items.filter(row => normalize(row.name).includes(query) && row.id > (after || 0));
      return { items: rows, has_more: false, next_cursor: null };
    }
    const pending = this.pending.get(key); if (pending) return pending;
    const job = (async () => {
      const request = supabase.rpc("traffic_planner_post_options", { p_kind: kind, p_category_id: category, p_query: query, p_after: after, p_limit: 30 });
      const { data, error } = await request.abortSignal(this.controller!.signal);
      if (!this.current(generation)) throw new Error("Форму вже закрито або змінено користувача.");
      if (error) throw error;
      if (!data || !Array.isArray(data.items) || data.items.length > 30 || typeof data.has_more !== "boolean") throw new Error("Некоректна сторінка підказок.");
      let previous = after ?? 0;
      for (const row of data.items) {
        if (!validId(row.id) || row.id <= previous || typeof row.name !== "string" || (kind === "post" && row.category !== category)) throw new Error("Некоректна сторінка підказок.");
        previous = row.id;
      }
      if ((data.has_more && (!data.items.length || data.next_cursor !== previous)) || (!data.has_more && data.next_cursor !== null)) throw new Error("Некоректна сторінка підказок.");
      this.pages.set(key, data);
      while (this.pages.size > 96) this.pages.delete(this.pages.keys().next().value!);
      return data as Page;
    })();
    this.pending.set(key, job);
    try { return await job; } finally { if (this.pending.get(key) === job) this.pending.delete(key); }
  }
  private async ensureCategory(isCurrent: () => boolean): Promise<number | null> {
    if (this.selectedCategory) return this.selectedCategory.id;
    const query = normalize(this.field("postCehFormInputTitle").value);
    if (!query) return null;
    const page = await this.readPage("category", null, query, null);
    const exact = page.items.filter(item => normalize(item.name) === query);
    // Never infer identity when the matching set is incomplete or ambiguous.
    if (isCurrent() && !page.has_more && exact.length === 1 && normalize(this.field("postCehFormInputTitle").value) === query) {
      this.selectedCategory = { ...exact[0] }; return exact[0].id;
    }
    return null;
  }
  private async showMenu(menu: Menu, append = false): Promise<void> {
    if (!this.available() || menu.input.disabled || document.activeElement !== menu.input) return;
    const query = normalize(menu.input.value);
    if (!append && menu.list.style.display === "block" && menu.query === query) return;
    if (!append) { this.closeAllDropdowns(); menu.query = query; menu.list.scrollTop = 0; }
    const revision = menu.revision, generation = this.generation, after = append ? menu.after : null;
    menu.loading = true; menu.list.style.display = "block"; menu.input.setAttribute("aria-expanded", "true");
    const current = () => this.current(generation) && revision === menu.revision && document.activeElement === menu.input && normalize(menu.input.value) === query && !this.isSubmitting;
    try {
      const category = menu.kind === "post" ? await this.ensureCategory(current) : null;
      if (!current()) return;
      if (menu.kind === "post" && !category) { menu.list.textContent = "Спочатку оберіть цех зі списку. Нову назву поста можна ввести вручну."; return; }
      const page = await this.readPage(menu.kind, category, query, after);
      if (!current()) return;
      menu.list.querySelectorAll("[data-post-status]").forEach(node => node.remove());
      for (const choice of page.items) {
        const option = document.createElement("div"); option.className = "post-autocomplete-option"; option.dataset.choice = String(choice.id); option.setAttribute("role", "option");
        option.textContent = `${choice.name} · №${choice.id}`;
        option.addEventListener("click", event => { event.stopPropagation(); if (current()) this.choose(menu.kind, choice); });
        option.addEventListener("mouseenter", () => { menu.list.querySelectorAll(".active").forEach(item => item.classList.remove("active")); option.classList.add("active"); });
        menu.list.appendChild(option);
      }
      menu.after = page.next_cursor; menu.more = page.has_more;
      if (!page.items.length || page.has_more) {
        const status = document.createElement("div"); status.dataset.postStatus = ""; status.setAttribute("role", "status");
        status.textContent = page.has_more ? "Прокрутіть, щоб побачити наступні назви" : "Збігів не знайдено"; menu.list.appendChild(status);
      }
    } catch (error) {
      if (current()) { menu.list.textContent = this.errorMessage(error); menu.more = false; menu.query = "\u0000"; }
    } finally { if (revision === menu.revision) menu.loading = false; }
  }
  public async refreshAutocompleteData(): Promise<void> {
    this.generation++; this.controller?.abort(); this.controller = this.isOpen ? new AbortController() : null;
    this.pages.clear(); this.pending.clear(); this.closeAllDropdowns();
  }
  private resetFields(): void {
    this.selectedCategory = this.selectedPost = this.selectedStaff = null;
    for (const id of ["postCehFormInputTitle", "postPostFormInputTitle", "postPostFormInputSubtitle"]) this.field(id).value = "";
    this.closeAllDropdowns();
  }
  private toggleLockMode(): void {
    if (!this.available()) return;
    this.isLocked = !this.isLocked; this.currentActionState = "add"; this.resetFields(); this.updateModalState();
  }
  private cycleActionState(): void {
    if (!this.available() || this.isLocked) return;
    this.currentActionState = this.currentActionState === "add" ? "edit" : this.currentActionState === "edit" ? "delete" : "add";
    this.resetFields(); this.updateModalState();
  }
  private updateModalState(): void {
    document.getElementById("postModalLockBtn")?.classList.toggle("active", !this.isLocked);
    document.getElementById("postModalControls")?.classList.toggle("visible", !this.isLocked);
    const group = document.getElementById("postPostFormGroupSubtitle"); if (group) group.style.display = this.isLocked ? "flex" : "none";
    const labels = { add: "Додати", edit: "Редагувати", delete: "Видалити" };
    const mode = document.getElementById("postModalAddBtn");
    if (mode) { mode.textContent = labels[this.currentActionState]; for (const action of ["add", "edit", "delete"]) mode.classList.toggle(`post-mode--${action}`, action === this.currentActionState); }
    const title = document.getElementById("postPostModalTitle"); if (title) title.textContent = this.isLocked ? "Новий пост" : "Цехи та пости";
    const submit = document.getElementById("postPostModalSubmit");
    if (submit) { submit.textContent = this.isSubmitting ? "Збереження…" : this.isLocked ? "Створити" : labels[this.currentActionState]; submit.classList.toggle("post-btn-primary", this.isLocked); submit.classList.toggle("post-btn-blue", !this.isLocked); }
    this.modalOverlay?.setAttribute("aria-busy", String(this.isSubmitting));
    this.modalOverlay?.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button").forEach(control => { control.disabled = this.isSubmitting; });
  }
  public open(onSubmit: PostSubmitCallback, prefillCehTitle?: string, onDirectoryChange?: DirectoryCallback): void {
    if (this.isSubmitting || (this.isOpen && this.current())) return;
    this.finishClose(); this.owner = actor(); this.isOpen = true; this.controller = new AbortController();
    this.onSubmitCallback = onSubmit; this.onDirectoryChange = onDirectoryChange ?? null;
    this.isLocked = true; this.currentActionState = "add"; this.resetFields();
    this.field("postCehFormInputTitle").value = prefillCehTitle || "";
    this.updateModalState(); if (this.modalOverlay) this.modalOverlay.style.display = "flex";
    // Opening itself does not fetch directories or staff; only a field interaction does.
  }
  public close(): void { if (!this.isSubmitting) this.finishClose(); }
  private finishClose(): void {
    this.isOpen = false; this.generation++; this.controller?.abort(); this.controller = null;
    this.pages.clear(); this.pending.clear(); this.closeAllDropdowns();
    this.onSubmitCallback = null; this.onDirectoryChange = null;
    this.selectedCategory = this.selectedPost = this.selectedStaff = null;
    if (this.modalOverlay) this.modalOverlay.style.display = "none";
  }
  private errorMessage(error: unknown): string {
    const value = error as { code?: string; message?: string } | null;
    if (value?.code === "PGRST202" || value?.code === "42883") return "Встановіть SQL-пакет planner-post-modal-repair.sql для цехів і постів.";
    return value?.message || String(error);
  }
  private async handleSubmit(): Promise<void> {
    if (!this.available()) return;
    const generation = this.generation, callback = this.onSubmitCallback, directoryCallback = this.onDirectoryChange;
    this.isSubmitting = true; this.closeAllDropdowns(); this.updateModalState();
    try {
      const cehTitle = this.field("postCehFormInputTitle").value.trim(), title = this.field("postPostFormInputTitle").value.trim(), subtitle = this.field("postPostFormInputSubtitle").value.trim();
      if (this.isLocked) {
        if (!cehTitle || !title || !subtitle) throw new Error("Заповніть назву цеху, поста та ПІБ слюсаря.");
        if (!callback) throw new Error("Не вдалося відкрити створення поста. Відкрийте форму повторно.");
        const staffId = this.selectedStaff && normalize(this.selectedStaff.name) === normalize(subtitle) ? this.selectedStaff.id : undefined;
        const categoryId = this.selectedCategory && normalize(this.selectedCategory.name) === normalize(cehTitle) ? this.selectedCategory.id : undefined;
        const postId = this.selectedPost && this.selectedPost.category === categoryId && normalize(this.selectedPost.name) === normalize(title) ? this.selectedPost.id : undefined;
        await callback({ cehTitle, title, subtitle, staffId, categoryId, postId, actor: this.owner });
      } else {
        const receipt = await this.writeDirectory(cehTitle, title);
        if (!this.current(generation)) return;
        if (receipt.status !== "unchanged") {
          try { await directoryCallback?.(receipt); } catch { if (this.current(generation)) showNotification("Зміни збережено. Оновіть планувальник, щоб побачити їх.", "info"); }
          if (!this.current(generation)) return;
          // A successful mutation must never become a failed save because of logging.
          void logAction(`settings_${this.currentActionState}_post_directory`, null, receipt, "settings").catch(() => {});
        }
        showNotification(receipt.status === "unchanged" ? "Змін немає" : receipt.status === "deleted" ? "Видалено" : "Збережено", receipt.status === "unchanged" ? "info" : "success");
      }
      if (this.current(generation)) this.finishClose();
    } catch (error) { if (this.current(generation)) showNotification(this.errorMessage(error), "error"); }
    finally { this.isSubmitting = false; this.updateModalState(); }
  }
  private async writeDirectory(category: string, name: string): Promise<PostDirectoryReceipt> {
    const action = this.currentActionState;
    const categoryRow = this.selectedCategory, postRow = this.selectedPost;
    let categoryId: number | null = null, postId: number | null = null;
    const patch: Record<string, string> = {}, expected: Record<string, string | number> = {};
    if (!category && !name) throw new Error("Оберіть або введіть цех чи пост.");
    if (action === "add") {
      if (!category) throw new Error("Спочатку оберіть або введіть назву цеху.");
      patch.category = category; if (name) patch.name = name;
      if (categoryRow && normalize(categoryRow.name) === normalize(category)) { categoryId = categoryRow.id; expected.category = categoryRow.name; }
    } else {
      if (!categoryRow) throw new Error("Спочатку оберіть цех зі списку.");
      categoryId = categoryRow.id; expected.category = categoryRow.name;
      if (name) {
        if (!postRow || postRow.category !== categoryRow.id) throw new Error("Спочатку оберіть конкретний пост зі списку.");
        postId = postRow.id; expected.name = postRow.name; expected.post_category = postRow.category;
      }
      if (action === "delete") {
        if (category !== categoryRow.name || (postRow && name && name !== postRow.name)) throw new Error("Для видалення повторно оберіть запис зі списку, без зміни назви.");
      } else {
        if (!category) throw new Error("Назва цеху не може бути порожньою.");
        if (category !== categoryRow.name) patch.category = category;
        if (postRow && name && name !== postRow.name) patch.name = name;
        if (!Object.keys(patch).length) return { status: "unchanged", category: { category_id: categoryId, category: categoryRow.name }, post: postRow && name ? { post_id: postRow.id, name: postRow.name, category: postRow.category! } : null };
      }
    }
    if (!this.current()) throw new Error("Користувач змінився. Відкрийте форму повторно.");
    const { data, error } = await supabase.rpc("traffic_planner_directory_write", { p_action: action, p_category_id: categoryId, p_post_id: postId, p_patch: patch, p_expected: expected });
    this.pages.clear(); this.pending.clear();
    if (error) throw error;
    if (!data || !["created", "updated", "deleted", "unchanged"].includes(data.status) || (!data.category && !data.post)
      || (data.category && (!validId(data.category.category_id) || typeof data.category.category !== "string"))
      || (data.post && (!validId(data.post.post_id) || !validId(data.post.category) || typeof data.post.name !== "string"))
      || (categoryId !== null && data.category && data.category.category_id !== categoryId)
      || (postId !== null && data.post?.post_id !== postId)
      || (action === "delete" && data.status !== "deleted")) throw new Error("База не підтвердила зміну цеху або поста. Перевірте запис перед повтором.");
    return data as PostDirectoryReceipt;
  }
}
