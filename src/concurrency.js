import dotenv from 'dotenv';
dotenv.config();

let currentConcurrentGenerations = 0;

/**
 * Attempts to acquire a generation slot.
 * Returns true if slot was acquired, false if max concurrency reached.
 * @returns {boolean}
 */
export function acquireSlot() {
  const max = parseInt(process.env.MAX_CONCURRENT_GENERATIONS || '3', 10);
  if (currentConcurrentGenerations >= max) {
    return false;
  }
  currentConcurrentGenerations++;
  return true;
}

/**
 * Releases a generation slot.
 */
export function releaseSlot() {
  if (currentConcurrentGenerations > 0) {
    currentConcurrentGenerations--;
  }
}

/**
 * Gets the number of current concurrent generations.
 * @returns {number}
 */
export function getCurrentCount() {
  return currentConcurrentGenerations;
}
