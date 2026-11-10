export const ACT_FROZEN_DATA_KEY = "Заморожений";

export function parseActData(value: any): Record<string, any> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

export function isActFrozen(act: any): boolean {
  return parseActData(act?.data)?.[ACT_FROZEN_DATA_KEY] === true;
}

export function dataWithFrozenState(data: any, frozen: boolean): Record<string, any> {
  return { ...parseActData(data), [ACT_FROZEN_DATA_KEY]: frozen };
}
