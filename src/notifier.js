import axios from 'axios';
import dotenv from 'dotenv';
import { getStatus, updateStatus } from './sessionStore.js';
import logger from './safeLogger.js';

dotenv.config();

/**
 * Notifies n8n webhook if the session has expired, respecting the 2-hour spam interval.
 * @returns {Promise<void>}
 */
export async function notifySessionExpired() {
  const webhookUrl = process.env.N8N_WEBHOOK_URL;
  if (!webhookUrl) {
    logger.info('N8N_WEBHOOK_URL não configurada. Notificação pulada.');
    return;
  }

  try {
    const status = await getStatus();
    const now = new Date();

    if (status.lastNotified) {
      const lastNotifiedTime = new Date(status.lastNotified);
      const timeDiffMs = now.getTime() - lastNotifiedTime.getTime();
      const twoHoursMs = 2 * 60 * 60 * 1000;

      if (timeDiffMs < twoHoursMs) {
        logger.info(`Notificação de expiração ignorada para evitar spam. Último envio: ${status.lastNotified}`);
        return;
      }
    }

    const payload = {
      tipo: 'sessao_expirada',
      servico: 'painel-testes',
      mensagem: 'A sessão do painel RBOYS expirou. Atualize os cookies.',
      timestamp: now.toISOString()
    };

    logger.info(`Enviando notificação de sessão expirada para o webhook n8n...`);
    await axios.post(webhookUrl, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    });

    logger.info('Notificação enviada com sucesso para o n8n.');
    // Update status to record the notification timestamp
    await updateStatus(false, status.message || 'Sessão expirada', now.toISOString());
  } catch (error) {
    logger.error('Erro ao enviar notificação para webhook n8n:', error.message);
  }
}
