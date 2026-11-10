// src/ts/utils/urlUpdater.ts
// 🔗 ОНОВЛЕННЯ URL в HTML елементах

import { getGitUrl, getGitName } from "./gitUtils";

/**
 * Оновлює всі посилання в документі, що ведуть на старий домен
 */
export async function updateDynamicLinks(): Promise<void> {
  try {
    const gitName = await getGitName();
    const mainUrl = await getGitUrl("main.html");
    const indexUrl = await getGitUrl("index.html");
    const baseUrl = await getGitUrl();
    
    // Знаходимо всі посилання динамічно за gitName з бази
    const oldDomainSelectors = [
      `a[href*="${gitName}.github.io"]`,
      'a[href*=".github.io/"]',
      'a[id="postNavLinkHome"]' // конкретне посилання в planyvannya.html
    ];
    
    const links = document.querySelectorAll(oldDomainSelectors.join(', '));
    
    links.forEach((link) => {
      const href = link.getAttribute('href');
      if (!href) return;
      
      // Замінюємо посилання на main.html
      if (href.includes('/main.html') || link.id === 'postNavLinkHome') {
        link.setAttribute('href', mainUrl);
      }
      // Замінюємо посилання на index.html
      else if (href.includes('/index.html')) {
        link.setAttribute('href', indexUrl);
      }
      // Замінюємо базові посилання на домен
      else if (href.includes('.github.io/')) {
        const path = new URL(href, window.location.href).pathname.split('/').slice(2).join('/');
        getGitUrl(path).then(newUrl => {
          link.setAttribute('href', newUrl);
        });
      }
      // Замінюємо просто базовий URL
      else if (href.includes('.github.io/STO')) {
        link.setAttribute('href', baseUrl);
      }
    });
  } catch (error) {
    // console.error("❌ Помилка оновлення посилань:", error);
  }
}

/**
 * Ініціалізація оновлення посилань після завантаження DOM
 */
export function initUrlUpdater(): void {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updateDynamicLinks);
  } else {
    updateDynamicLinks();
  }
}