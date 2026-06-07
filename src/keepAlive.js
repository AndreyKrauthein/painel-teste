import cron from 'node-cron';
import cmsClient from './cmsClient.js';
import { extractToken } from './parser.js';
import { updateStatus, loadSession } from './sessionStore.js';
import { notifySessionExpired } from './notifier.js';
import logger from './safeLogger.js';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Validates session status and pings the IPTV panel simpletest endpoint
 */
export async function checkSessionHealth() {
  logger.info('Iniciando verificação de Keep Alive da sessão...');
  
  const session = await loadSession();
  if (!session) {
    logger.warn('Nenhuma sessão salva em data/session.json. Marcando como expirada.');
    await updateStatus(false, 'Sessão inexistente. Por favor, envie os cookies iniciais.');
    await notifySessionExpired();
    return;
  }

  try {
    // Make GET request to simpletest page
    const response = await cmsClient.get('/clients/simpletest');
    
    // Check if we were redirected to login page or got authentication status code
    const finalUrl = response.request?.res?.responseUrl || '';
    if (
      finalUrl.includes('/login') || 
      response.status === 419 || 
      response.status === 401 ||
      response.status === 403
    ) {
      logger.warn(`Sessão expirada. Redirecionado para ${finalUrl || 'URL desconhecida'} com status ${response.status}.`);
      await updateStatus(false, 'Sessão expirada.');
      await notifySessionExpired();
      return;
    }

    const html = response.data;
    const token = extractToken(html);

    if (token) {
      logger.info('Sessão validada com sucesso. Keep Alive concluído com a sessão ativa.');
      await updateStatus(true, 'Sessão ativa e saudável.');
    } else {
      logger.warn('CSRF token não encontrado no HTML de simpletest. Considerando sessão expirada.');
      await updateStatus(false, 'Sessão expirada (token CSRF ausente).');
      await notifySessionExpired();
    }
  } catch (error) {
    logger.error('Erro de requisição durante o Keep Alive:', error.message);
    
    if (error.response) {
      const status = error.response.status;
      if ([401, 403, 419].includes(status)) {
        await updateStatus(false, `Erro de autenticação no painel (${status}).`);
        await notifySessionExpired();
        return;
      }
    }
    
    // For network errors or 500 errors, we do not mark the session as inactive.
    // We just report a log warning, since the session cookies might still be valid once connection returns.
    logger.warn('Erro temporário de conexão ou servidor CMS indisponível. Mantendo status atual da sessão.');
  }
}

/**
 * Starts the cron keep alive job based on minutes interval set in dotenv
 */
export function startKeepAliveJob() {
  const minutes = parseInt(process.env.KEEP_ALIVE_INTERVAL_MINUTES || '30', 10);
  let cronPattern = `*/${minutes} * * * *`;
  if (isNaN(minutes) || minutes <= 0 || minutes > 59) {
    cronPattern = '*/30 * * * *';
  }

  logger.info(`Agendando tarefa Keep Alive automática: "${cronPattern}"`);
  
  const job = cron.schedule(cronPattern, async () => {
    try {
      await checkSessionHealth();
    } catch (err) {
      logger.error('Erro não tratado na execução agendada de Keep Alive:', err);
    }
  });

  return job;
}
