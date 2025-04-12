export enum JobState {
      WAITING = 'waiting',
      ACTIVE = 'active',
      COMPLETED = 'completed',
      FAILED = 'failed',
      DELAYED = 'delayed',
      STALLED = 'stalled',
      PENDING = 'pending',
}

/**
 * Type of backoff strategy for job retries
 */
export type BackoffType = 'exponential' | 'linear' | 'fixed';

/**
 * Configuration for job retry backoff
 */
export interface BackoffOptions {
      /** Type of backoff strategy */
      type: BackoffType;
      /** Base delay in milliseconds */
      delay: number;
      /** Maximum delay in milliseconds (for exponential backoff) */
      maxDelay?: number;
}

/**
 * Options for configuring a job's behavior and execution.
 */
export interface JobOptions {
      /** Priority level of the job */
      priority?: 'high' | 'medium' | 'low';
      /** Number of retry attempts before marking job as failed */
      retries?: number;
      /**
       * Retry backoff strategy configuration.
       * Example:
       * ```typescript
       * backoff: {
       *   type: 'exponential',
       *   delay: 1000,
       *   maxDelay: 60000
       * }
       * ```
       */
      backoff?: BackoffOptions;
      /**
       * Maximum time (in milliseconds) a job can run before being marked as failed.
       * Example: 10000 for 10 seconds timeout
       */
      timeout?: number;
      /**
       * Time-to-live in milliseconds. Job will be discarded if not processed within this time.
       * Example: 3600000 for 1 hour TTL
       */
      ttl?: number;
      /** Delay in milliseconds before job execution */
      delay?: number;
      /** Maximum number of concurrent jobs allowed */
      concurrency?: number;
      /** IDs of jobs that must complete before this job starts */
      dependsOn?: string[];
      /** Cron expression for scheduling recurring jobs */
      cron?: string;
      /**
       * Array of subsequent jobs to execute after this job completes.
       * Each job in the chain will receive the result of the previous job as context.
       * Example:
       * ```typescript
       * chain: [
       *   {
       *     data: { step: 1 },
       *     options: { priority: 'high' }
       *   },
       *   {
       *     data: { step: 2 },
       *     options: { retries: 5 }
       *   }
       * ]
       * ```
       */
      chain?: { data: any; options?: Omit<JobOptions, 'chain'> }[];
}

/**
 * Represents a job in the queue system.
 */
export interface Job {
      /** Unique identifier for the job */
      id: string;
      /** Name of the queue this job belongs to */
      queue: string;
      /** Data payload for the job */
      data: any;
      /** Current state of the job */
      state: JobState;
      /** Configuration options for the job */
      options: JobOptions;
      /** Number of execution attempts made */
      attempts: number;
      /** Timestamp when the job was created */
      createdAt: number;
      /** Timestamp when the job is scheduled to run */
      scheduledAt?: number;
      /** Timestamp when the job completed */
      completedAt?: number;
      /** Timestamp when the job started processing */
      startedAt?: number;
      /** Timestamp when the job will expire (TTL) */
      expiresAt?: number;
      /** Array of log messages for the job */
      logs: string[];
      /** IDs of jobs that must complete before this job starts */
      dependencies?: string[];
      /** IDs of jobs that depend on this job's completion */
      dependents?: string[];
      /**
       * Result data from the previous job in the chain.
       * This field is populated automatically when a job is part of a chain.
       * The first job in a chain will not have this field set.
       */
      context?: any;
}
