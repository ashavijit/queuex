import { EventEmitter } from 'events';
import { QueueManager } from './services/queue-manager';
import { Worker } from './services/worker';
import { RedisStorage } from './storage/redis';
import { Job, JobOptions, JobState } from './models/job';
import { Queue, QueueOptions } from './models/queue';

export type QueueXEvent = 'jobCompleted' | 'jobFailed' | 'jobDelayed' | 'jobStarted' | 'jobPending' | 'jobReady';

export interface QueueXConfig {
  redisConnection: string;
  defaultConcurrency?: number;
}

/**
 * Main entry point for QueueX SDK, managing queues and workers.
 */
export class QueueX {
  private queueManager: QueueManager;
  private storage: RedisStorage;
  private workers: Worker[] = [];
  private eventEmitter: EventEmitter;

  constructor(config: QueueXConfig) {
    try {
      this.storage = new RedisStorage(config.redisConnection);
      this.queueManager = new QueueManager(config.redisConnection, this.emitEvent.bind(this));
      this.eventEmitter = new EventEmitter();
    } catch (err) {
      throw new Error(`Failed to initialize QueueX: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async createQueue(name: string, options: QueueOptions = {}): Promise<Queue> {
    await this.queueManager.createQueue(name, options);
    const queue: Queue = {
      name,
      options: {
        maxConcurrency: 1,
        ...options,
      },
    };
    return queue;
  }

  async enqueue(queueName: string, data: any, options: JobOptions = {}): Promise<Job> {
    return this.queueManager.enqueue(queueName, data, options);
  }

  async unscheduleJob(jobId: string): Promise<void> {
    return this.queueManager.unscheduleJob(jobId);
  }

  async updateJobDelay(jobId: string, newDelay: number): Promise<Job> {
    return this.queueManager.updateJobDelay(jobId, newDelay);
  }

  startWorker(queueName: string, processor: (job: Job) => Promise<any>, concurrency?: number): Worker {
    const worker = new Worker(this.queueManager, this.storage, concurrency || 1, this.emitEvent.bind(this));
    this.workers.push(worker);
    worker.start(queueName, processor).catch((err) => console.error(`Worker error for ${queueName}:`, err));
    return worker;
  }

  async shutdown(): Promise<void> {
    try {
      for (const worker of this.workers) {
        worker.stop();
      }
      this.queueManager.stopScheduler();
      await this.storage.disconnect();
    } catch (err) {
      throw new Error(`Failed to shutdown QueueX: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  on(event: QueueXEvent, listener: (job: Job) => void): void {
    this.eventEmitter.on(event, listener);
  }

  private emitEvent(event: QueueXEvent, job: Job): void {
    this.eventEmitter.emit(event, job);
    this.storage.logEvent(event, job).catch((err) => console.error(`Failed to log event for ${job.id}:`, err));
  }

  async getEvents(jobId: string): Promise<string[]> {
    return this.storage.getEvents(jobId);
  }
}

export { Job, JobOptions, JobState, Queue, QueueOptions };