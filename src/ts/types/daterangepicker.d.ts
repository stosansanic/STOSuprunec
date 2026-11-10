declare module "daterangepicker";

interface DateRangePicker {
  element: JQuery;
  setStartDate(date: any): void;
  setEndDate(date: any): void;
  hide(): void;
}

interface DateRangePickerOptions {
  locale?: Record<string, unknown>;
  opens?: string;
  alwaysShowCalendars?: boolean;
  autoUpdateInput?: boolean;
  startDate?: any;
  endDate?: any;
  ranges?: Record<string, [any, any]>;
  showCustomRangeLabel?: boolean;
}

interface JQuery<TElement = HTMLElement> {
  daterangepicker(
    options: DateRangePickerOptions,
    callback?: (
      this: DateRangePicker,
      start: any,
      end: any,
      label: string,
    ) => void,
  ): this;
  data(key: "daterangepicker"): DateRangePicker | undefined;
}
