// Compatibility exports only. All payment paths use the guarded accounting flow.
export {
  runMassPaymentCalculation as runMassPaymentCalculationForPodlegle,
  togglepodleglePaymentWithConfirmation as togglePaymentWithConfirmation,
  togglepodleglePayment as togglePayment,
} from "./zarplata";
export type { PodlegleRecord } from "./zarplata";
