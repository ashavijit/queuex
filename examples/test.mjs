import { QueueX, QueueStrategy } from '../dist/index.js';

const queuex = new QueueX({ 
  redisConnection: 'redis://localhost:6379' 
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const log = (message) => {
  console.log(`[${new Date().toISOString()}] ${message}`);
};

async function runTests() {
  try {
    log('Starting QueueX tests...');

    log('\n=== Test 1: Basic Job Processing ===');
    await queuex.createQueue('basicQueue', { maxConcurrency: 2 });
    
    queuex.startWorker('basicQueue', async (job) => {
      log(`Processing basic job: ${JSON.stringify(job.data)}`);
      await delay(1000); // Simulate work
      return { processed: true };
    });

    await queuex.enqueue('basicQueue', { task: 'simple task' });
    await delay(2000);

    log('\n=== Test 2: Retry Strategies ===');
    await queuex.createQueue('retryQueue', { maxConcurrency: 1 });

    let retryCount = 0;
    queuex.startWorker('retryQueue', async (job) => {
      log(`Attempt ${retryCount + 1} for retry job`);
      retryCount++;
      
      if (retryCount < 3) {
        throw new Error('Simulated failure');
      }
      
      return { success: true, attempts: retryCount };
    });

    await queuex.enqueue('retryQueue', { task: 'retry task' }, {
      retries: 3,
      backoff: {
        type: 'exponential',
        delay: 1000,
        maxDelay: 5000
      }
    });

    await delay(10000);

    log('\n=== Test 3: Job Timeout ===');
    await queuex.createQueue('timeoutQueue', { maxConcurrency: 1 });

    queuex.startWorker('timeoutQueue', async (job) => {
      log('Starting long-running job...');
      await delay(6000); // Job takes longer than timeout
      return { completed: true };
    });

    await queuex.enqueue('timeoutQueue', { task: 'timeout task' }, {
      timeout: 3000 // 3 second timeout
    });

    await delay(7000);

    log('\n=== Test 4: Job TTL ===');
    await queuex.createQueue('ttlQueue', { maxConcurrency: 1 });

    queuex.startWorker('ttlQueue', async (job) => {
      log('Processing TTL job');
      return { processed: true };
    });

    await queuex.enqueue('ttlQueue', { task: 'ttl task' }, {
      ttl: 15000, // 15 second TTL
      delay: 10000 // 10 second delay
    });

    await delay(11000);

    log('\n=== Test 5: Job Chaining ===');
    await queuex.createQueue('chainQueue', { maxConcurrency: 1 });

    queuex.startWorker('chainQueue', async (job) => {
      log(`Processing chain step: ${job.data.step}`);
      if (job.context) {
        log(`Previous job result: ${JSON.stringify(job.context)}`);
      }
      await delay(1000);
      return { step: job.data.step, completed: true };
    });

    await queuex.enqueue('chainQueue', { step: 'start' }, {
      chain: [
        {
          data: { step: 'middle' },
          options: { timeout: 5000 }
        },
        {
          data: { step: 'end' },
          options: { 
            retries: 2,
            backoff: { type: 'linear', delay: 1000 }
          }
        }
      ]
    });

    await delay(5000);

    // Test 6: Queue Processing Strategies
    log('\n=== Test 6: Queue Processing Strategies ===');
    
    // LIFO Queue
    await queuex.createQueue('lifoQueue', { 
      strategy: QueueStrategy.LIFO,
      maxConcurrency: 1 
    });

    queuex.startWorker('lifoQueue', async (job) => {
      log(`Processing LIFO job: ${job.data.order}`);
      await delay(1000);
      return { processed: true };
    });

    // Add jobs in sequence
    for (let i = 1; i <= 3; i++) {
      await queuex.enqueue('lifoQueue', { order: i });
      await delay(100);
    }

    await delay(4000);

    // Priority Queue
    await queuex.createQueue('priorityQueue', { 
      strategy: QueueStrategy.PRIORITY,
      maxConcurrency: 1 
    });

    queuex.startWorker('priorityQueue', async (job) => {
      log(`Processing priority job: ${job.data.task} (Priority: ${job.options.priority})`);
      await delay(1000);
      return { processed: true };
    });

    await queuex.enqueue('priorityQueue', { task: 'Low Priority Task' }, { priority: 'low' });
    await queuex.enqueue('priorityQueue', { task: 'High Priority Task' }, { priority: 'high' });
    await queuex.enqueue('priorityQueue', { task: 'Medium Priority Task' }, { priority: 'medium' });

    await delay(4000);

    // Event Handling Test
    log('\n=== Test 7: Event Handling ===');
    
    queuex.on('jobStarted', (job) => {
      log(`Event - Job ${job.id} started`);
    });

    queuex.on('jobCompleted', (job) => {
      log(`Event - Job ${job.id} completed`);
    });

    queuex.on('jobFailed', (job) => {
      log(`Event - Job ${job.id} failed: ${job.error}`);
    });

    queuex.on('jobDelayed', (job) => {
      log(`Event - Job ${job.id} delayed until: ${new Date(job.scheduledAt).toISOString()}`);
    });

    await queuex.enqueue('basicQueue', { task: 'event test' });
    await delay(2000);

    log('\nAll tests completed!');
    
    // Cleanup
    await queuex.shutdown();
    process.exit(0);

  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  }
}

// Run the tests
runTests().catch(console.error); 