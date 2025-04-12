interface CronField {
      min: number;
      max: number;
      values: number[];
}

export class CronParser {
      private fields: CronField[];

      constructor(expression: string) {
            this.fields = this.parseExpression(expression);
      }
      /**
       *
       * @param expression  cron expression
       * @returns  cron fields
       * @throws  Error if the expression is invalid
       *
       * @example  * * * * * *  (seconds, minutes, hours, day of month, month, day of week)
       * @example  0 0 0 * * *  (midnight every day)
       *
       *
       */
      private parseExpression(expression: string): CronField[] {
            const parts = expression.trim().split(/\s+/);
            if (parts.length !== 6) {
                  throw new Error(
                        `Invalid cron expression: expected 6 fields, got ${parts.length}`
                  );
            }

            const ranges: { min: number; max: number }[] = [
                  { min: 0, max: 59 }, // seconds
                  { min: 0, max: 59 }, // minutes
                  { min: 0, max: 23 }, // hours
                  { min: 1, max: 31 }, // day of month
                  { min: 1, max: 12 }, // month
                  { min: 0, max: 6 }, // day of week
            ];

            return parts.map((part, i) => this.parseField(part, ranges[i].min, ranges[i].max));
      }

      private parseField(field: string, min: number, max: number): CronField {
            if (field === '*') {
                  return {
                        min,
                        max,
                        values: Array.from({ length: max - min + 1 }, (_, i) => min + i),
                  };
            }

            if (field.startsWith('*/')) {
                  const step = parseInt(field.slice(2), 10);
                  if (isNaN(step) || step <= 0) throw new Error(`Invalid step value in ${field}`);
                  const values: number[] = [];
                  for (let i = min; i <= max; i += step) {
                        values.push(i);
                  }
                  return { min, max, values };
            }

            const value = parseInt(field, 10);
            if (isNaN(value) || value < min || value > max) {
                  throw new Error(`Invalid value ${field} for range ${min}-${max}`);
            }
            return { min, max, values: [value] };
      }

      public next(from: Date = new Date()): Date {
            const now = new Date(from);
            now.setMilliseconds(0);

            const maxIterations = 1000 * 60 * 60 * 24; // 1 day max
            let iterations = 0;

            while (iterations < maxIterations) {
                  now.setSeconds(now.getSeconds() + 1);
                  iterations++;

                  const year = now.getFullYear();
                  const month = now.getMonth() + 1;
                  const day = now.getDate();
                  const dow = now.getDay();
                  const hour = now.getHours();
                  const min = now.getMinutes();
                  const sec = now.getSeconds();

                  if (!this.fields[4].values.includes(month)) {
                        now.setMonth(now.getMonth() + 1, 1);
                        now.setHours(0, 0, 0);
                        continue;
                  }
                  if (
                        !this.fields[3].values.includes(day) ||
                        !this.fields[5].values.includes(dow)
                  ) {
                        now.setDate(now.getDate() + 1);
                        now.setHours(0, 0, 0);
                        continue;
                  }
                  if (!this.fields[2].values.includes(hour)) {
                        now.setHours(now.getHours() + 1, 0, 0);
                        continue;
                  }
                  if (!this.fields[1].values.includes(min)) {
                        now.setHours(now.getHours() + 1, 0);
                        continue;
                  }
                  if (!this.fields[0].values.includes(sec)) {
                        now.setMinutes(now.getMinutes() + 1);
                        continue;
                  }

                  return new Date(now);
            }

            throw new Error('No valid next execution time found within 24 hours');
      }
}
