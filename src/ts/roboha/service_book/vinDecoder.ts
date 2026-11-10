// src/ts/roboha/service_book/vinDecoder.ts
// 🔍 VIN-декодер через безкоштовне API NHTSA (vpic.nhtsa.dot.gov)

export interface VinDecodedInfo {
  make: string;
  model: string;
  year: string;
  engineSize: string;
  fuelType: string;
  bodyType: string;
  driveType: string;
  transmission: string;
  engineCode: string;
  errorText?: string;
}

const VIN_CACHE = new Map<string, VinDecodedInfo>();

/**
 * Валідація VIN-коду (17 символів, без I/O/Q)
 */
export function isValidVin(vin: string): boolean {
  if (!vin || vin.length !== 17) return false;
  return /^[A-HJ-NPR-Z0-9]{17}$/i.test(vin);
}

/**
 * Декодує VIN через NHTSA API
 * https://vpic.nhtsa.dot.gov/api/
 */
export async function decodeVin(vin: string): Promise<VinDecodedInfo> {
  const vinUpper = vin.toUpperCase().trim();

  if (VIN_CACHE.has(vinUpper)) {
    return VIN_CACHE.get(vinUpper)!;
  }

  if (!isValidVin(vinUpper)) {
    return {
      make: "",
      model: "",
      year: "",
      engineSize: "",
      fuelType: "",
      bodyType: "",
      driveType: "",
      transmission: "",
      engineCode: "",
      errorText: "Невалідний VIN-код (потрібно 17 символів)",
    };
  }

  try {
    const response = await fetch(
      `https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues/${vinUpper}?format=json`,
      { signal: AbortSignal.timeout(10000) },
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    const results = data?.Results?.[0];

    if (!results) {
      return {
        make: "",
        model: "",
        year: "",
        engineSize: "",
        fuelType: "",
        bodyType: "",
        driveType: "",
        transmission: "",
        engineCode: "",
        errorText: "Немає даних від NHTSA API",
      };
    }

    const errorCode = results.ErrorCode;
    const hasError = errorCode && errorCode !== "0" && !errorCode.includes("0");

    const decoded: VinDecodedInfo = {
      make: results.Make || "",
      model: results.Model || "",
      year: results.ModelYear || "",
      engineSize: results.DisplacementL
        ? `${parseFloat(results.DisplacementL).toFixed(1)}L`
        : "",
      fuelType: translateFuelType(results.FuelTypePrimary || ""),
      bodyType: results.BodyClass || "",
      driveType: results.DriveType || "",
      transmission: results.TransmissionStyle || "",
      engineCode: results.EngineModel || "",
      errorText: hasError ? results.ErrorText || "" : undefined,
    };

    VIN_CACHE.set(vinUpper, decoded);
    return decoded;
  } catch (err: any) {
    return {
      make: "",
      model: "",
      year: "",
      engineSize: "",
      fuelType: "",
      bodyType: "",
      driveType: "",
      transmission: "",
      engineCode: "",
      errorText:
        err.name === "TimeoutError"
          ? "Таймаут запиту до NHTSA"
          : `Помилка: ${err.message}`,
    };
  }
}

/**
 * Переклад типу палива з англійської на українську
 */
function translateFuelType(fuel: string): string {
  const lower = fuel.toLowerCase();
  if (lower.includes("diesel")) return "Дизель";
  if (lower.includes("gasoline") || lower.includes("petrol")) return "Бензин";
  if (lower.includes("electric")) return "Електро";
  if (lower.includes("hybrid")) return "Гібрид";
  if (lower.includes("lpg") || lower.includes("propane")) return "Газ";
  if (lower.includes("cng") || lower.includes("natural gas")) return "Метан";
  return fuel || "";
}
