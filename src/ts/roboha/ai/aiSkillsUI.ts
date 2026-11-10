// src/ts/roboha/ai/aiSkillsUI.ts
// 🧩 UI для CRUD скілів AI Атлас — інтегрується в модалку налаштувань

import {
  loadAllSkills,
  createSkill,
  updateSkill,
  deleteSkill,
  toggleSkillActive,
  invalidateSkillsCache,
  getSkillCategoryLabel,
  isSkillCategory,
  SKILL_CATEGORIES,
  type AISkill,
} from "./aiSkills";
import {
  cancelDeleteCountdown,
  isDeleteCountdownActive,
  startDeleteCountdown,
} from "./deleteCountdown";
import { showNotification } from "../zakaz_naraudy/inhi/vspluvauhe_povidomlenna";

// ─────────────────────────────────────────────────────────────────────
// HTML генерація
// ─────────────────────────────────────────────────────────────────────

type SkillDescriptionItem = {
  name: string;
  is_active: boolean;
};

/** Генерує HTML для списку скілів */
export function createSkillsHTML(): string {
  return `
    <div class="skills-manager">
      <div class="skills-header">
        <h3>🧩 Скіли AI Атлас</h3>
        <p class="skills-description">
          Кожен скіл — це набір інструкцій, що підвантажується за ключовими словами.
          Замість одного великого промпту → тільки релевантні скіли.
        </p>
        <button type="button" class="skills-add-btn" id="skills-add-btn">+ Додати скіл</button>
      </div>
      <div class="skills-list" id="skills-list">
        <div class="skills-loading">Завантаження...</div>
      </div>
    </div>
  `;
}

/** Генерує HTML для одного скіла в списку */
function renderSkillCard(skill: AISkill, index: number): string {
  const categoryLabel = getSkillCategoryLabel(skill.category);
  const keywordsStr = skill.keywords.length
    ? skill.keywords.join(", ")
    : "(завжди активний)";
  const activeClass = skill.is_active ? "active" : "inactive";
  // Обрізаємо промпт для прев'ю
  const promptPreview =
    skill.prompt.length > 120
      ? skill.prompt.substring(0, 120) + "..."
      : skill.prompt;

  return `
    <div class="skill-card ${activeClass}" data-skill-id="${skill.skill_id}">
      <span class="skill-card-index">${index + 1}</span>
      <div class="skill-card-header">
        <div class="skill-card-title">
          <span class="skill-name">${escapeHtml(skill.name)}</span>
          <span class="skill-category">${categoryLabel}</span>
          <span class="skill-priority">⚡${skill.priority}</span>
        </div>
        <div class="skill-card-actions">
          <label class="skill-toggle" title="${skill.is_active ? "Вимкнути" : "Увімкнути"}">
            <input type="checkbox" class="skill-active-cb" data-id="${skill.skill_id}" ${skill.is_active ? "checked" : ""} />
            <span class="skill-toggle-slider"></span>
          </label>
          <button type="button" class="skill-edit-btn" data-id="${skill.skill_id}" title="Редагувати">✏️</button>
          <button type="button" class="skill-delete-btn" data-id="${skill.skill_id}" title="Видалити">🗑️</button>
        </div>
      </div>
      <div class="skill-keywords">🔑 ${escapeHtml(keywordsStr)}</div>
      <div class="skill-prompt-preview">${escapeHtml(promptPreview)}</div>
    </div>
  `;
}

/** Генерує HTML для модалки редагування/створення */
function renderSkillEditor(skill?: AISkill): string {
  const isNew = !skill;
  const title = isNew ? "Новий скіл" : `Редагування: ${skill!.name}`;

  const categoryOptions = SKILL_CATEGORIES.map(
    (c) =>
      `<option value="${c.value}" ${skill?.category === c.value ? "selected" : ""}>${c.label}</option>`,
  ).join("");

  return `
    <div class="skill-editor-overlay" id="skill-editor-overlay">
      <div class="skill-editor">
        <h3>${escapeHtml(title)}</h3>
        
        <div class="skill-editor-field">
          <label>Назва</label>
          <input type="text" id="skill-edit-name" value="${escapeHtml(skill?.name || "")}" placeholder="Наприклад: Акти" />
        </div>
        
        <div class="skill-editor-row">
          <div class="skill-editor-field">
            <label>Категорія</label>
            <select id="skill-edit-category">${categoryOptions}</select>
          </div>
          <div class="skill-editor-field">
            <label>Пріоритет (0-100)</label>
            <input type="number" id="skill-edit-priority" min="0" max="100" value="${skill?.priority ?? 50}" />
          </div>
        </div>
        
        <div class="skill-editor-field">
          <label>Ключові слова <span class="skill-hint">(через кому; пусто = завжди активний)</span></label>
          <input type="text" id="skill-edit-keywords" value="${escapeHtml(skill?.keywords?.join(", ") || "")}" placeholder="акт, наряд, заказ, відкри, закри" />
        </div>
        
        <div class="skill-editor-field">
          <label>Промпт (інструкція для AI)</label>
          <textarea id="skill-edit-prompt" rows="10" placeholder="Опишіть інструкцію...">${escapeHtml(skill?.prompt || "")}</textarea>
          <div class="skill-prompt-counter" id="skill-prompt-counter">0 символів</div>
        </div>
        
        <div class="skill-editor-actions">
          <button type="button" id="skill-editor-cancel" class="skill-btn-cancel">Скасувати</button>
          <button type="button" id="skill-editor-save" class="skill-btn-save" data-id="${skill?.skill_id || ""}">${isNew ? "Створити" : "Зберегти"}</button>
        </div>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────
// ЛОГІКА ІНІЦІАЛІЗАЦІЇ ТА ОБРОБНИКИ
// ─────────────────────────────────────────────────────────────────────

/** Завантажити та відрендерити список скілів */
export async function initSkillsUI(container: HTMLElement): Promise<void> {
  const listEl = container.querySelector("#skills-list") as HTMLElement;
  if (!listEl) return;

  const skills = await loadAllSkills();
  updateSkillsDescription(container, skills);

  if (skills.length === 0) {
    listEl.innerHTML =
      '<div class="skills-empty">Скілів ще немає. Натисніть "+ Додати скіл"</div>';
  } else {
    listEl.innerHTML = skills.map((s, idx) => renderSkillCard(s, idx)).join("");
  }

  // Обробник — додати новий скіл
  container
    .querySelector("#skills-add-btn")
    ?.addEventListener("click", () => openSkillEditor(container));

  // Обробники на картках
  attachCardHandlers(container);
}

/** Привʼязати обробники до карток скілів */
function attachCardHandlers(container: HTMLElement): void {
  // Toggle active
  container
    .querySelectorAll<HTMLInputElement>(".skill-active-cb")
    .forEach((cb) => {
      cb.addEventListener("change", async () => {
        const id = Number(cb.dataset.id);
        const ok = await toggleSkillActive(id, cb.checked);
        if (ok) {
          const card = cb.closest(".skill-card");
          card?.classList.toggle("active", cb.checked);
          card?.classList.toggle("inactive", !cb.checked);
          updateSkillsDescriptionFromDom(container);
        } else {
          cb.checked = !cb.checked;
          showNotification("Помилка зміни статусу", "error", 2000);
        }
      });
    });

  // Edit
  container
    .querySelectorAll<HTMLButtonElement>(".skill-edit-btn")
    .forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = Number(btn.dataset.id);
        const skills = await loadAllSkills();
        const skill = skills.find((s) => s.skill_id === id);
        if (skill) openSkillEditor(container, skill);
      });
    });

  // Delete
  container
    .querySelectorAll<HTMLButtonElement>(".skill-delete-btn")
    .forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = Number(btn.dataset.id);
        const card = btn.closest(".skill-card");
        const name = card?.querySelector(".skill-name")?.textContent || "";
        if (!id || !card) return;

        if (isDeleteCountdownActive(btn)) {
          cancelDeleteCountdown(btn, {
            countingClass: "skill-delete-btn--counting",
          });
          return;
        }

        startDeleteCountdown(btn, {
          countingClass: "skill-delete-btn--counting",
          onConfirm: async () => {
            const ok = await deleteSkill(id);
            if (ok) {
              card.remove();
              showNotification(`Скіл "${name}" видалено`, "info", 2000);
              invalidateSkillsCache();
              updateSkillsDescriptionFromDom(container);
            } else {
              showNotification("Помилка видалення", "error", 2000);
            }
          },
        });
      });
    });
}

function updateSkillsDescription(
  container: HTMLElement,
  skills: SkillDescriptionItem[],
): void {
  const descEl = container.querySelector(
    ".skills-description",
  ) as HTMLElement | null;
  if (!descEl) return;

  const baseText =
    "Кожен скіл — це набір інструкцій, що підвантажується за ключовими словами.<br>" +
    "Замість одного великого промпту → тільки релевантні скіли.";

  if (!skills.length) {
    descEl.innerHTML = `${baseText}<br><span class="skills-status-title">Скіли:</span> <span class="skills-status-empty">ще немає</span>`;
    return;
  }

  const chips = skills
    .map(
      (skill) =>
        `<span class="skills-status-chip ${skill.is_active ? "skills-status-chip--active" : "skills-status-chip--inactive"}">${escapeHtml(skill.name)}</span>`,
    )
    .join(" ");

  descEl.innerHTML = `${baseText}<br><span class="skills-status-title">Скіли:</span> <span class="skills-status-list">${chips}</span>`;
}

function updateSkillsDescriptionFromDom(container: HTMLElement): void {
  const cards = Array.from(container.querySelectorAll(".skill-card"));
  const skills = cards.map((card, idx) => {
    const name =
      (
        card.querySelector(".skill-name") as HTMLElement | null
      )?.textContent?.trim() || `Скіл ${idx + 1}`;
    return {
      name,
      is_active: card.classList.contains("active"),
    };
  });
  updateSkillsDescription(container, skills);
}

/** Відкрити редактор скіла */
function openSkillEditor(container: HTMLElement, skill?: AISkill): void {
  // Закрити попередній якщо відкритий
  document.getElementById("skill-editor-overlay")?.remove();

  const html = renderSkillEditor(skill);
  container.insertAdjacentHTML("beforeend", html);

  const overlay = document.getElementById(
    "skill-editor-overlay",
  ) as HTMLElement;
  const promptArea = overlay.querySelector(
    "#skill-edit-prompt",
  ) as HTMLTextAreaElement;
  const counter = overlay.querySelector("#skill-prompt-counter") as HTMLElement;

  // Лічильник символів
  const updateCounter = () => {
    const len = promptArea?.value.length || 0;
    if (counter) counter.textContent = `${len} символів`;
  };
  promptArea?.addEventListener("input", updateCounter);
  updateCounter();

  // Закрити
  overlay
    .querySelector("#skill-editor-cancel")
    ?.addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  // Зберегти
  overlay
    .querySelector("#skill-editor-save")
    ?.addEventListener("click", async () => {
      const name = (
        overlay.querySelector("#skill-edit-name") as HTMLInputElement
      )?.value.trim();
      const categoryValue = (
        overlay.querySelector("#skill-edit-category") as HTMLSelectElement
      )?.value;
      const priority = Number(
        (overlay.querySelector("#skill-edit-priority") as HTMLInputElement)
          ?.value || 50,
      );
      const keywordsRaw = (
        overlay.querySelector("#skill-edit-keywords") as HTMLInputElement
      )?.value.trim();
      const prompt = (
        overlay.querySelector("#skill-edit-prompt") as HTMLTextAreaElement
      )?.value.trim();

      if (!name) {
        showNotification("Введіть назву", "error", 2000);
        return;
      }
      if (!prompt) {
        showNotification("Введіть промпт", "error", 2000);
        return;
      }
      if (!isSkillCategory(categoryValue)) {
        showNotification("Оберіть коректну категорію", "error", 2000);
        return;
      }

      const keywords = keywordsRaw
        ? keywordsRaw
            .split(",")
            .map((k) => k.trim())
            .filter(Boolean)
        : [];

      const saveBtn = overlay.querySelector(
        "#skill-editor-save",
      ) as HTMLButtonElement;
      const editId = saveBtn?.dataset.id;

      let ok: boolean;
      if (editId) {
        // Оновлення
        ok = await updateSkill(Number(editId), {
          name,
          category: categoryValue,
          priority,
          keywords,
          prompt,
        });
        if (ok) showNotification(`Скіл "${name}" оновлено ✅`, "info", 2000);
      } else {
        // Створення
        const result = await createSkill({
          name,
          category: categoryValue,
          keywords,
          prompt,
          is_active: true,
          priority,
        });
        ok = !!result;
        if (ok) showNotification(`Скіл "${name}" створено ✅`, "info", 2000);
      }

      if (ok) {
        overlay.remove();
        // Перезавантажити список
        await initSkillsUI(container);
      } else {
        showNotification("Помилка збереження", "error", 2000);
      }
    });
}

// ─────────────────────────────────────────────────────────────────────
// УТИЛІТИ
// ─────────────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
