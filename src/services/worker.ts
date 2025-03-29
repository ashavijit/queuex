import { QueueManager } from './queue-manager';
import { Job, JobState } from '../models/job';
import { RedisStorage } from '../storage/redis';
import { QueueXEvent } from '../lib';
import { v4 as uuidv4 } from 'uuid';

/**
 * Processes jobs from a queue with concurrency control.
 * Handles job execution, retries, and job chaining.
 * 
 * Job Chaining:
 * When a job completes successfully and has a chain defined in its options,
 * the worker will automatically create and enqueue the next job in the chain.
 * The result of the completed job is passed as context to the next job.
 * 
 * Example:
 * ```typescript
 * // Create a chain of jobs
 * await queueX.enqueue('myQueue', initialData, {
 *   chain: [
 *     {
 *       data: { step: 1 },
 *       options: { priority: 'high' }
 *     },
 *     {
 *       data: { step: 2 },
 *       options: { retries: 5 }
 *     }
 *   ]
 * });
 * 
 * // In your job processor, you can access the previous job's result
 * const processor = async (job: Job) => {
 *   if (job.context) {
 *     // This is a chained job, job.context contains the previous job's result
 *     console.log('Previous job result:', job.context);
 *   }
 *   // Process the job...
 * };
 * ```
 */
export class Worker {
  private queueManager: QueueManager;
  private storage: RedisStorage;
  private running = false;
  private concurrency: number;
  private emitEvent: (event: QueueXEvent, job: Job) => void;

  constructor(
    queueManager: QueueManager,
    storage: RedisStorage,
    concurrency = 1,
    emitEvent: (event: QueueXEvent, job: Job) => void
  ) {
    this.queueManager = queueManager;
    this.storage = storage;
    this.concurrency = concurrency;
    this.emitEvent = emitEvent;
  }

  /**
   * Starts processing jobs from the specified queue.
   * Handles job execution, retries, and job chaining.
   * 
   * Job Chaining Process:
   * 1. When a job completes successfully, check if it has a chain defined
   * 2. If chain exists, create the next job with:
   *    - New unique ID
   *    - Data and options from the chain definition
   *    - Context set to the result of the completed job
   * 3. Enqueue the new job and emit a 'jobReady' event
   * 
   * @param queueName - Name of the queue to process jobs from
   * @param processor - Function to process each job
   */
  async start(queueName: string, processor: (job: Job) => Promise<any>): Promise<void> {
    this.running = true;
    const activeJobs: Set<string> = new Set();

    while (this.running) {
      if (activeJobs.size >= this.concurrency) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }

      const job = await this.queueManager.getJob(queueName);
      if (!job) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }

      activeJobs.add(job.id);
      job.state = JobState.ACTIVE;
      job.attempts++;
      this.emitEvent('jobStarted', job);

      try {
        const result = await processor(job);
        job.state = JobState.COMPLETED;
        job.completedAt = Date.now();
        job.logs.push(`Completed with result: ${JSON.stringify(result)}`);
        await this.storage.saveJobResult(job);
        this.emitEvent('jobCompleted', job);

        // Handle job chaining
        if (job.options.chain?.length) {
          const nextJobInChain = job.options.chain[0];
          const nextJob: Job = {
            id: uuidv4(),
            queue: job.queue,
            data: nextJobInChain.data,
            state: JobState.WAITING,
            options: { ...nextJobInChain.options },
            attempts: 0,
            createdAt: Date.now(),
            logs: [],
            context: result 
          };
          await this.storage.enqueueJob(nextJob);
          this.emitEvent('jobReady', nextJob);
        }

        if (job.dependents?.length) {
          for (const depId of job.dependents) {
            const dependentJob = this.queueManager.getJobById(depId);
            if (dependentJob && dependentJob.state === JobState.PENDING) {
              const allDepsCompleted = dependentJob.dependencies!.every((d) => {
                const dJob = this.queueManager.getJobById(d);
                return dJob?.state === JobState.COMPLETED;
              });
              if (allDepsCompleted) {
                dependentJob.state = JobState.WAITING;
                await this.storage.enqueueJob(dependentJob);
                this.emitEvent('jobReady', dependentJob);
              }
            }
          }
        }
      } catch (error) {
        job.state = job.attempts >= (job.options.retries ?? 0) ? JobState.FAILED : JobState.WAITING;
        job.logs.push(`Error: ${error instanceof Error ? error.message : String(error)}`);
        if (job.state === JobState.WAITING) {
          const delay = this.calculateBackoff(job.attempts);
          job.scheduledAt = Date.now() + delay;
          await this.storage.enqueueJob(job);
          this.emitEvent('jobDelayed', job);
        } else {
          await this.storage.saveJobResult(job);
          this.emitEvent('jobFailed', job);
        }
      } finally {
        activeJobs.delete(job.id);
      }
    }
  }

  /**
   * Stops the worker from processing new jobs.
   * Currently running jobs will complete.
   */
  stop(): void {
    this.running = false;
  }

  /**
   * Calculates exponential backoff delay for retries.
   * @param attempt - The attempt number (1-based)
   * @returns Delay in milliseconds
   */
  private calculateBackoff(attempt: number): number {
    return Math.pow(2, attempt - 1) * 1000;
  }
}