// src/ts/roboha/zakaz_naraudy/inhi/act_change_tracker.ts

import { supabase } from "../../../vxid/supabaseClient";

interface ActChange {
    act_id: number;
    act_number: string;
    change_type: 'added' | 'deleted';
    item_type: 'work' | 'detail';
    item_name: string;
    changed_by_surname: string;
}

interface DetailItem {
    Деталь: string;
    Кількість: number;
}

interface WorkItem {
    Робота: string;
    Кількість: number;
}

/**
 * Порівнює старі та нові дані акту і визначає що було додано або видалено
 */
export function detectActChanges(
    oldData: any,
    newData: any
): ActChange[] {
    const changes: ActChange[] = [];

    // Отримуємо номер акту з нових даних
    const actNumber = newData?.["Номер акту"] || newData?.act_number || "Невідомо";

    // Порівнюємо деталі
    const oldDetails: DetailItem[] = Array.isArray(oldData?.["Деталі"]) ? oldData["Деталі"] : [];
    const newDetails: DetailItem[] = Array.isArray(newData?.["Деталі"]) ? newData["Деталі"] : [];

    // Створюємо мапи для швидкого пошуку
    const oldDetailsMap = new Map<string, number>();
    oldDetails.forEach(d => {
        const name = d["Деталь"]?.trim();
        if (name) {
            oldDetailsMap.set(name, d["Кількість"] || 0);
        }
    });

    const newDetailsMap = new Map<string, number>();
    newDetails.forEach(d => {
        const name = d["Деталь"]?.trim();
        if (name) {
            newDetailsMap.set(name, d["Кількість"] || 0);
        }
    });

    // Знаходимо додані деталі
    newDetailsMap.forEach((_, name) => {
        if (!oldDetailsMap.has(name)) {
            changes.push({
                act_id: 0, // Буде заповнено пізніше
                act_number: actNumber,
                change_type: 'added',
                item_type: 'detail',
                item_name: name,
                changed_by_surname: '', // Буде заповнено пізніше
            });
        }
    });

    // Знаходимо видалені деталі
    oldDetailsMap.forEach((_, name) => {
        if (!newDetailsMap.has(name)) {
            changes.push({
                act_id: 0,
                act_number: actNumber,
                change_type: 'deleted',
                item_type: 'detail',
                item_name: name,
                changed_by_surname: '',
            });
        }
    });

    // Порівнюємо роботи
    const oldWorks: WorkItem[] = Array.isArray(oldData?.["Роботи"]) ? oldData["Роботи"] : [];
    const newWorks: WorkItem[] = Array.isArray(newData?.["Роботи"]) ? newData["Роботи"] : [];

    const oldWorksMap = new Map<string, number>();
    oldWorks.forEach(w => {
        const name = w["Робота"]?.trim();
        if (name) {
            oldWorksMap.set(name, w["Кількість"] || 0);
        }
    });

    const newWorksMap = new Map<string, number>();
    newWorks.forEach(w => {
        const name = w["Робота"]?.trim();
        if (name) {
            newWorksMap.set(name, w["Кількість"] || 0);
        }
    });

    // Знаходимо додані роботи
    newWorksMap.forEach((_, name) => {
        if (!oldWorksMap.has(name)) {
            changes.push({
                act_id: 0,
                act_number: actNumber,
                change_type: 'added',
                item_type: 'work',
                item_name: name,
                changed_by_surname: '',
            });
        }
    });

    // Знаходимо видалені роботи
    oldWorksMap.forEach((_, name) => {
        if (!newWorksMap.has(name)) {
            changes.push({
                act_id: 0,
                act_number: actNumber,
                change_type: 'deleted',
                item_type: 'work',
                item_name: name,
                changed_by_surname: '',
            });
        }
    });

    return changes;
}

/**
 * Записує зміни в таблицю act_changes_notifications
 */
export async function recordActChanges(
    actId: number,
    oldData: any,
    newData: any,
    userSurname: string
): Promise<void> {
    const changes = detectActChanges(oldData, newData);

    if (changes.length === 0) {
        return;
    }


    // Заповнюємо act_id та прізвище користувача
    const recordsToInsert = changes.map(change => ({
        act_id: actId,
        act_number: change.act_number,
        change_type: change.change_type,
        item_type: change.item_type,
        item_name: change.item_name,
        changed_by_surname: userSurname,
        viewed: false,
        delit: false, // ✅ За замовчуванням FALSE = показувати
        data: new Date().toISOString()
    }));

    // Записуємо в Supabase
    const { error } = await supabase
        .from('act_changes_notifications')
        .insert(recordsToInsert);

    if (error) {
        // console.error('❌ Помилка запису змін в act_changes_notifications:', error);
        throw new Error(`Не вдалося записати зміни: ${error.message}`);
    }

}
