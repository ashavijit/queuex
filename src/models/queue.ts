/**
 * Queue processing strategy
 */
export enum QueueStrategy {
      /** First In, First Out - Jobs are processed in the order they were added */
      FIFO = 'fifo',
      /** Last In, First Out - Most recently added jobs are processed first */
      LIFO = 'lifo',
      /** Priority-based - Jobs are processed based on their priority level */
      PRIORITY = 'priority',
      /** Round Robin - Jobs are processed in a circular order */
      ROUND_ROBIN = 'round_robin',
}

export interface QueueOptions {
      /** Priority level for the queue */
      priority?: number;
      /** Maximum number of concurrent jobs allowed */
      maxConcurrency?: number;
      /** Rate limiting configuration */
      rateLimit?: { max: number; interval: number };
      /** Queue processing strategy */
      strategy?: QueueStrategy;
}

export interface Queue {
      name: string;
      options: QueueOptions;
}
