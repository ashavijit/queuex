export interface QueueOptions {
  priority?: number;
  maxConcurrency?: number;
  rateLimit?: { max: number; interval: number };
}

export interface Queue {
  name: string;
  options: QueueOptions;
}