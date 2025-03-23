export enum JobState {
  WAITING = 'waiting',
  ACTIVE = 'active',
  COMPLETED = 'completed',
  FAILED = 'failed',
  DELAYED = 'delayed',
  STALLED = 'stalled',
  PENDING = 'pending',
}

export interface JobOptions {
  priority?: 'high' | 'medium' | 'low';
  retries?: number;
  delay?: number;
  concurrency?: number;
  dependsOn?: string[];
}

export interface Job {
  id: string;
  queue: string;
  data: any;
  state: JobState;
  options: JobOptions;
  attempts: number;
  createdAt: number;
  scheduledAt?: number;
  completedAt?: number;
  logs: string[];
  dependencies?: string[];
  dependents?: string[];
}