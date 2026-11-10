// src/ts/roboha/zakaz_naraudy/inhi/act_notifications.ts

interface ActNotification {
    notification_id: number;
    act_id: number;
    act_number: string;
    change_type: 'added' | 'deleted';
    item_type: 'work' | 'detail';
    item_name: string;
    changed_by_surname: string;
    changed_at: string;
}

// Зберігаємо активні повідомлення
const activeNotifications = new Map<number, HTMLDivElement>();

/**
 * Групує зміни по акту
 */
function groupChangesByAct(changes: ActNotification[]): Map<number, ActNotification[]> {
    const grouped = new Map<number, ActNotification[]>();

    changes.forEach(change => {
        const actChanges = grouped.get(change.act_id) || [];
        actChanges.push(change);
        grouped.set(change.act_id, actChanges);
    });

    return grouped;
}

/**
 * Показує спливаюче повідомлення про зміни в акті
 */
export function showActChangeNotification(changes: ActNotification[]): void {
    if (changes.length === 0) return;

    // Групуємо зміни по акту
    const groupedChanges = groupChangesByAct(changes);

    groupedChanges.forEach((actChanges, actId) => {
        // Якщо вже є повідомлення для цього акту - видаляємо його
        if (activeNotifications.has(actId)) {
            const oldNotification = activeNotifications.get(actId);
            oldNotification?.remove();
            activeNotifications.delete(actId);
        }

        const firstChange = actChanges[0];
        const actNumber = firstChange.act_number;
        const changedBy = firstChange.changed_by_surname;

        // Створюємо HTML для списку змін
        const changesHTML = actChanges.map(change => {
            const icon = change.change_type === 'added' ? '✅' : '❌';
            const typeText = change.item_type === 'work' ? 'роботу' : 'деталь';
            const actionText = change.change_type === 'added' ? 'Додано' : 'Видалено';

            return `
        <div style="display: flex; align-items: center; gap: 6px; margin-top: 4px;">
          <span>${icon}</span>
          <span>${actionText} ${typeText}: ${change.item_name}</span>
        </div>
      `;
        }).join('');

        const notification = document.createElement('div');
        notification.className = 'act-notification';
        notification.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
        <div>
          <strong style="font-size: 16px;">🔔 Акт №${actNumber} змінено</strong>
        </div>
        <button class="act-notification-close" style="background: none; border: none; color: #2196F3; font-size: 20px; cursor: pointer; padding: 0; margin-left: 10px; line-height: 1;">✕</button>
      </div>
      <div style="font-size: 14px; color: #333; margin-bottom: 8px;">
        <strong>Слюсар:</strong> ${changedBy}
      </div>
      <div style="font-size: 13px; color: #555;">
        ${changesHTML}
      </div>
    `;

        // Стилі для повідомлення
        Object.assign(notification.style, {
            position: 'fixed',
            right: '20px',
            backgroundColor: '#E3F2FD', // світло-синій
            color: '#333',
            padding: '16px 20px',
            borderRadius: '12px',
            zIndex: '10001',
            boxShadow: '0 8px 25px rgba(33, 150, 243, 0.3)',
            fontSize: '15px',
            fontWeight: '500',
            minWidth: '320px',
            maxWidth: '400px',
            border: '2px solid #2196F3', // синій як паста
            backdropFilter: 'blur(10px)',
            transform: 'translateX(100%)',
            transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
            fontFamily: 'system-ui, -apple-system, sans-serif',
        });

        document.body.appendChild(notification);
        activeNotifications.set(actId, notification);

        // Перераховуємо позиції для всіх повідомлень (нові зверху)
        repositionNotifications();

        // Анімація появи
        requestAnimationFrame(() => {
            notification.style.transform = 'translateX(0)';
        });

        // Обробник закриття
        const closeBtn = notification.querySelector('.act-notification-close');
        closeBtn?.addEventListener('click', () => {
            notification.style.transform = 'translateX(100%)';
            notification.style.opacity = '0';

            setTimeout(() => {
                notification.remove();
                activeNotifications.delete(actId);
                repositionNotifications();
            }, 300);
        });

        // Ефекти при наведенні
        notification.addEventListener('mouseenter', () => {
            notification.style.transform = 'translateX(0) scale(1.02)';
        });

        notification.addEventListener('mouseleave', () => {
            notification.style.transform = 'translateX(0) scale(1)';
        });
    });
}

/**
 * Перераховує позиції всіх активних повідомлень
 * Нові повідомлення зверху, старі опускаються вниз
 */
function repositionNotifications(): void {
    const notifications = Array.from(activeNotifications.values());

    notifications.forEach((notification, index) => {
        const topPosition = 20 + (index * 10); // Невеликий відступ між повідомленнями
        notification.style.top = `${topPosition}px`;
        notification.style.zIndex = `${10001 - index}`; // Нові зверху
    });
}

/**
 * Закриває всі активні повідомлення
 */
export function closeAllActNotifications(): void {
    activeNotifications.forEach(notification => {
        notification.style.transform = 'translateX(100%)';
        notification.style.opacity = '0';
        setTimeout(() => notification.remove(), 300);
    });
    activeNotifications.clear();
}
