import fs from 'fs/promises';
import path from 'path';
import logger from './safeLogger.js';

/**
 * Calculates temporal generation statistics from the local generated-tests.jsonl file
 * @returns {Promise<{ today: number, yesterday: number, last7Days: number, thisMonth: number, total: number, lastGeneratedTestAt: string|null }>}
 */
export async function getGenerationStats() {
  const filePath = path.resolve('data/generated-tests.jsonl');
  
  const stats = {
    today: 0,
    yesterday: 0,
    last7Days: 0,
    thisMonth: 0,
    total: 0,
    lastGeneratedTestAt: null
  };

  try {
    const data = await fs.readFile(filePath, 'utf-8');
    const lines = data.split('\n');
    
    const now = new Date();
    
    // Boundaries in local time (ignoring hour/minutes/seconds for day calculations)
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const endOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    const startOfLast7Days = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
    const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    let lastCreatedAt = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const record = JSON.parse(trimmed);
        if (!record.createdAt) continue;

        const date = new Date(record.createdAt);
        if (isNaN(date.getTime())) continue;

        stats.total++;
        
        // Track the latest generation timestamp
        if (!lastCreatedAt || date > lastCreatedAt) {
          lastCreatedAt = date;
        }

        // Compare dates using time boundaries
        if (date >= startOfToday) {
          stats.today++;
        }
        if (date >= startOfYesterday && date < endOfYesterday) {
          stats.yesterday++;
        }
        if (date >= startOfLast7Days) {
          stats.last7Days++;
        }
        if (date >= startOfThisMonth) {
          stats.thisMonth++;
        }
      } catch (err) {
        // Skip malformed lines and log as a minor warning
        logger.warn('Linha malformada no histórico ignorada no processamento de stats.');
      }
    }

    stats.lastGeneratedTestAt = lastCreatedAt ? lastCreatedAt.toISOString() : null;

  } catch (err) {
    // If file does not exist, that is expected on fresh installs, return zeros
    if (err.code !== 'ENOENT') {
      logger.error('Erro ao ler estatísticas do histórico:', err.message);
    }
  }

  return stats;
}

export default getGenerationStats;
