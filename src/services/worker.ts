import { QueueManager } from './queue-manager';
import { Job, JobState, BackoffType } from '../models/job';
import { RedisStorage } from '../storage/redis';
import { QueueXEvent } from '../lib';
import { v4 as uuidv4 } from 'uuid';

/**
 * Processes jobs from a queue with concurrency control.
 * Handles job execution, retries, job chaining, timeouts, and TTL.
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
      private activeTimeouts: Map<string, NodeJS.Timeout> = new Map();

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
       * Handles job execution, retries, job chaining, timeouts, and TTL.
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

                  // Check TTL before processing
                  if (job.expiresAt && Date.now() > job.expiresAt) {
                        job.state = JobState.FAILED;
                        job.logs.push(`Job expired: TTL of ${job.options.ttl}ms exceeded`);
                        await this.storage.saveJobResult(job);
                        this.emitEvent('jobFailed', job);
                        continue;
                  }

                  activeJobs.add(job.id);
                  job.state = JobState.ACTIVE;
                  job.attempts++;
                  job.startedAt = Date.now();
                  this.emitEvent('jobStarted', job);

                  try {
                        // Set up timeout if configured
                        let timeoutId: NodeJS.Timeout | undefined;
                        if (job.options.timeout) {
                              timeoutId = setTimeout(() => {
                                    this.handleJobTimeout(job);
                              }, job.options.timeout);
                              this.activeTimeouts.set(job.id, timeoutId);
                        }

                        const result = await processor(job);

                        // Clear timeout if job completed successfully
                        if (timeoutId) {
                              clearTimeout(timeoutId);
                              this.activeTimeouts.delete(job.id);
                        }

                        job.state = JobState.COMPLETED;
                        job.completedAt = Date.now();
                        job.logs.push(`Completed with result: ${JSON.stringify(result)}`);
                        await this.storage.saveJobResult(job);
                        this.emitEvent('jobCompleted', job);

                        // Handle job chaining
                        if (job.options.chain?.length) {
                              const nextJobInChain = job.options.chain[0];
                              const remainingChain = job.options.chain.slice(1);

                              const nextJob: Job = {
                                    id: uuidv4(),
                                    queue: job.queue,
                                    data: nextJobInChain.data,
                                    state: JobState.WAITING,
                                    options: {
                                          ...nextJobInChain.options,
                                          chain:
                                                remainingChain.length > 0
                                                      ? remainingChain
                                                      : undefined,
                                    },
                                    attempts: 0,
                                    createdAt: Date.now(),
                                    logs: [],
                                    context: result,
                              };

                              if (nextJob.options.ttl) {
                                    nextJob.expiresAt = Date.now() + nextJob.options.ttl;
                              }

                              await this.storage.enqueueJob(nextJob);
                              this.emitEvent('jobReady', nextJob);
                        }

                        // Handle dependent jobs
                        if (job.dependents?.length) {
                              for (const depId of job.dependents) {
                                    const dependentJob = this.queueManager.getJobById(depId);
                                    if (dependentJob && dependentJob.state === JobState.PENDING) {
                                          const allDepsCompleted = dependentJob.dependencies!.every(
                                                (d) => {
                                                      const dJob = this.queueManager.getJobById(d);
                                                      return dJob?.state === JobState.COMPLETED;
                                                }
                                          );
                                          if (allDepsCompleted) {
                                                dependentJob.state = JobState.WAITING;
                                                await this.storage.enqueueJob(dependentJob);
                                                this.emitEvent('jobReady', dependentJob);
                                          }
                                    }
                              }
                        }
                  } catch (error) {
                        // Clear timeout if job failed
                        const timeoutId = this.activeTimeouts.get(job.id);
                        if (timeoutId) {
                              clearTimeout(timeoutId);
                              this.activeTimeouts.delete(job.id);
                        }

                        const shouldRetry = job.attempts < (job.options.retries ?? 0);
                        job.state = shouldRetry ? JobState.WAITING : JobState.FAILED;
                        job.logs.push(
                              `Error: ${error instanceof Error ? error.message : String(error)}`
                        );

                        if (shouldRetry) {
                              const delay = this.calculateBackoffDelay(job);
                              job.scheduledAt = Date.now() + delay;
                              job.logs.push(
                                    `Retrying in ${delay}ms (attempt ${job.attempts} of ${job.options.retries})`
                              );
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
       * Calculates the delay for the next retry attempt based on the backoff strategy.
       */
      private calculateBackoffDelay(job: Job): number {
            const backoff = job.options.backoff;
            if (!backoff) {
                  return this.calculateDefaultBackoff(job.attempts);
            }

            const { type, delay, maxDelay } = backoff;
            let calculatedDelay: number;

            switch (type) {
                  case 'exponential':
                        calculatedDelay = delay * Math.pow(2, job.attempts - 1);
                        if (maxDelay) {
                              calculatedDelay = Math.min(calculatedDelay, maxDelay);
                        }
                        break;
                  case 'linear':
                        calculatedDelay = delay * job.attempts;
                        break;
                  case 'fixed':
                        calculatedDelay = delay;
                        break;
                  default:
                        calculatedDelay = this.calculateDefaultBackoff(job.attempts);
            }

            return calculatedDelay;
      }

      /**
       * Default exponential backoff calculation.
       */
      private calculateDefaultBackoff(attempt: number): number {
            return Math.pow(2, attempt - 1) * 1000;
      }

      /**
       * Handles job timeout by failing the job and cleaning up.
       */
      private async handleJobTimeout(job: Job): Promise<void> {
            job.state = JobState.FAILED;
            job.logs.push(`Job timed out after ${job.options.timeout}ms`);
            await this.storage.saveJobResult(job);
            this.emitEvent('jobFailed', job);
            this.activeTimeouts.delete(job.id);
      }

      /**
       * Stops the worker from processing new jobs.
       * Cleans up any active timeouts.
       */
      stop(): void {
            this.running = false;
            // Clean up any active timeouts
            for (const [jobId, timeout] of this.activeTimeouts.entries()) {
                  clearTimeout(timeout);
                  this.activeTimeouts.delete(jobId);
            }
      }
}
