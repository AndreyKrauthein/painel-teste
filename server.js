import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';

// Core imports
import logger from './src/safeLogger.js';
import { checkAuth } from './src/auth.js';
import { saveSession, loadSession, updateStatus, getStatus } from './src/sessionStore.js';
import { acquireSlot, releaseSlot } from './src/concurrency.js';
import { extractToken, extractTestData, parseBrazilianDate } from './src/parser.js';
import cmsClient from './src/cmsClient.js';
import { startKeepAliveJob, checkSessionHealth } from './src/keepAlive.js';
import { getGenerationStats } from './src/stats.js';
import { resolverClienteFornecedor } from './src/clients.js';
import { extenderAcesso, recuperarOperacoesExpiradas } from './src/extender.js';
import supabaseAdmin from './src/supabaseAdmin.js';

dotenv.config();

const fastify = Fastify({
  logger: false // Use our safeLogger
});

// Configure Global Rate Limit
const rateLimitMax = parseInt(process.env.RATE_LIMIT_MAX || '60', 10);
const rateLimitWindow = process.env.RATE_LIMIT_WINDOW || '1 minute';

fastify.register(rateLimit, {
  global: true,
  max: rateLimitMax,
  timeWindow: rateLimitWindow,
  errorResponseBuilder: (request, context) => {
    logger.warn(`Rate limit excedido para IP: ${request.ip}`);
    return {
      success: false,
      error: 'Limite de requisições excedido. Tente novamente mais tarde.',
      action: 'rate_limit_exceeded'
    };
  }
});

// Global Error Handler
fastify.setErrorHandler((error, request, reply) => {
  // Safe logging of the error (masked headers, secrets)
  logger.error(`Erro global capturado em ${request.method} ${request.url}:`, error);

  // If it's a rate limit error
  if (error.statusCode === 429) {
    return reply.status(429).send({
      success: false,
      error: 'Muitas solicitações. Por favor, aguarde.',
      action: 'rate_limit_exceeded'
    });
  }

  // Fallback for post generation route
  if (request.url === '/gerar-teste' && request.method === 'POST') {
    return reply.status(500).send({
      success: false,
      error: 'Não foi possível gerar o teste agora.',
      action: 'fallback_whatsapp'
    });
  }

  // Default server error fallback
  return reply.status(error.statusCode || 500).send({
    success: false,
    error: 'Ocorreu um erro interno no servidor.',
    action: 'try_again'
  });
});

/**
 * Uptime format helper
 * @returns {string}
 */
function getUptimeString() {
  const seconds = process.uptime();
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

/**
 * Shared Session Update and Validation logic
 */
async function refreshSessionHandler(request, reply) {
  const { cookie } = request.body || {};

  if (!cookie || typeof cookie !== 'string') {
    return reply.status(400).send({
      success: false,
      error: 'O campo "cookie" é obrigatório e deve ser uma string.',
      action: 'invalid_payload'
    });
  }

  try {
    logger.info('Recebida requisição para atualizar sessão. Salvando novos cookies...');
    
    // Save to data/session.json
    await saveSession(cookie);

    // Test session immediately
    logger.info('Testando a nova sessão no painel...');
    const response = await cmsClient.get('/clients/simpletest');
    
    const finalUrl = response.request?.res?.responseUrl || '';
    if (
      finalUrl.includes('/login') ||
      response.status === 419 ||
      response.status === 401 ||
      response.status === 403
    ) {
      logger.warn(`A nova sessão foi salva, mas falhou no teste do painel. Redirecionado para ${finalUrl}`);
      await updateStatus(false, 'Sessão inativa ou cookies expirados.');
      return reply.status(400).send({
        success: false,
        message: 'Cookies salvos, mas a sessão está inativa ou expirada no painel.',
        ativa: false
      });
    }

    const html = response.data;
    const token = extractToken(html);

    if (token) {
      logger.info('Sessão validada com sucesso.');
      await updateStatus(true, 'Sessão atualizada com sucesso e ativa.');
      return {
        success: true,
        message: 'Sessão atualizada com sucesso',
        ativa: true
      };
    } else {
      logger.warn('Sessão inativa. Token CSRF não encontrado na página de teste.');
      await updateStatus(false, 'Cookies salvos, mas token CSRF não foi encontrado.');
      return reply.status(400).send({
        success: false,
        message: 'Cookies salvos, mas a sessão está inativa ou expirada (token ausente).',
        ativa: false
      });
    }
  } catch (error) {
    logger.error('Erro ao processar atualização de cookies:', error);
    return reply.status(500).send({
      success: false,
      error: 'Erro interno ao tentar salvar ou validar a sessão.',
      action: 'try_again'
    });
  }
}

/**
 * GET /health
 * Public route for healthchecks
 */
fastify.get('/health', async (request, reply) => {
  return {
    success: true,
    service: 'painel-testes',
    status: 'online'
  };
});

/**
 * POST /sessao
 * Authenticated. Sets new cookies manual session.
 */
fastify.post('/sessao', { preHandler: checkAuth }, refreshSessionHandler);

/**
 * POST /admin/refresh-session
 * Authenticated. Sets new cookies manual session. Same handler as /sessao.
 */
fastify.post('/admin/refresh-session', { preHandler: checkAuth }, refreshSessionHandler);

/**
 * GET /sessao/status
 * Authenticated. Checks if the currently saved session is alive.
 */
fastify.get('/sessao/status', { preHandler: checkAuth }, async (request, reply) => {
  try {
    const session = await loadSession();
    if (!session) {
      return {
        success: true,
        ativa: false,
        message: 'Sessão expirada'
      };
    }

    logger.info('Verificando status atual da sessão...');
    const response = await cmsClient.get('/clients/simpletest');
    
    const finalUrl = response.request?.res?.responseUrl || '';
    if (
      finalUrl.includes('/login') ||
      response.status === 419 ||
      response.status === 401 ||
      response.status === 403
    ) {
      logger.warn('Sessão considerada inativa (redirecionado ou erro de auth).');
      await updateStatus(false, 'Sessão expirada.');
      return {
        success: true,
        ativa: false,
        message: 'Sessão expirada'
      };
    }

    const html = response.data;
    const token = extractToken(html);

    if (token) {
      logger.info('Sessão verificada como ativa.');
      await updateStatus(true, 'Sessão ativa.');
      return {
        success: true,
        ativa: true
      };
    } else {
      logger.warn('Sessão expirada: token CSRF não encontrado.');
      await updateStatus(false, 'Sessão expirada.');
      return {
        success: true,
        ativa: false,
        message: 'Sessão expirada'
      };
    }
  } catch (error) {
    logger.error('Erro ao verificar status da sessão:', error.message);
    
    // Check if error is due to authentication
    if (error.response && [401, 403, 419].includes(error.response.status)) {
      await updateStatus(false, 'Sessão expirada.');
      return {
        success: true,
        ativa: false,
        message: 'Sessão expirada'
      };
    }

    // Network error: read status from session-status.json as a fallback
    const localStatus = await getStatus();
    return {
      success: true,
      ativa: localStatus.ativa,
      message: localStatus.ativa ? 'Sessão ativa (Status Local)' : 'Sessão expirada'
    };
  }
});

/**
 * GET /admin/status
 * Authenticated. Returns system stats, session metrics, and uptime.
 */
fastify.get('/admin/status', { preHandler: checkAuth }, async (request, reply) => {
  try {
    const status = await getStatus();
    const stats = await getGenerationStats();

    return {
      success: true,
      service: 'painel-testes',
      sessionActive: status.ativa,
      lastSessionCheck: status.lastChecked || null,
      lastSessionSuccess: status.lastSuccess || null,
      lastSessionError: status.lastError || null,
      lastGeneratedTestAt: stats.lastGeneratedTestAt,
      generatedToday: stats.today,
      generatedTotal: stats.total,
      uptime: getUptimeString()
    };
  } catch (error) {
    logger.error('Erro ao processar rota /admin/status:', error.message);
    return reply.status(500).send({
      success: false,
      error: 'Erro ao carregar o status administrativo.',
      action: 'try_again'
    });
  }
});

/**
 * GET /admin/stats
 * Authenticated. Returns detailed counters (today, yesterday, last 7 days, this month, total).
 */
fastify.get('/admin/stats', { preHandler: checkAuth }, async (request, reply) => {
  try {
    const stats = await getGenerationStats();
    return {
      success: true,
      stats: {
        today: stats.today,
        yesterday: stats.yesterday,
        last7Days: stats.last7Days,
        thisMonth: stats.thisMonth,
        total: stats.total
      }
    };
  } catch (error) {
    logger.error('Erro ao processar rota /admin/stats:', error.message);
    return reply.status(500).send({
      success: false,
      error: 'Erro ao processar estatísticas de geração.',
      action: 'try_again'
    });
  }
});


/**
 * POST /gerar-teste
 * Authenticated. Generates an IPTV test and returns structured credentials.
 */
fastify.post('/gerar-teste', { preHandler: checkAuth }, async (request, reply) => {
  // 1. Memory Concurrency Check
  if (!acquireSlot()) {
    logger.warn('Bloqueio por limite de concorrência ativa.');
    return reply.status(429).send({
      success: false,
      error: 'Muitas solicitações no momento. Tente novamente em alguns segundos.',
      action: 'try_again'
    });
  }

  try {
    const { 
      telefone = '', 
      plano = parseInt(process.env.DEFAULT_PLAN || '90', 10), 
      notes = '' 
    } = request.body || {};

    logger.info(`Iniciando geração de teste. Telefone: ${telefone || 'Não informado'}, Plano: ${plano}`);

    // Check session existence
    const session = await loadSession();
    if (!session) {
      return reply.status(400).send({
        success: false,
        error: 'Sessão expirada. Atualize a sessão.',
        action: 'session_expired'
      });
    }

    // 2. Fetch /clients/simpletest to get fresh CSRF token
    logger.info('Carregando formulário de teste para obter token CSRF...');
    let simpleTestResponse;
    try {
      simpleTestResponse = await cmsClient.get('/clients/simpletest');
    } catch (err) {
      logger.error('Falha ao acessar /clients/simpletest:', err.message);
      return reply.status(500).send({
        success: false,
        error: 'Não foi possível gerar o teste agora.',
        action: 'fallback_whatsapp'
      });
    }

    const simpleTestUrl = simpleTestResponse.request?.res?.responseUrl || '';
    if (
      simpleTestUrl.includes('/login') ||
      simpleTestResponse.status === 419 ||
      simpleTestResponse.status === 401 ||
      simpleTestResponse.status === 403
    ) {
      logger.warn('Sessão expirou no momento da geração do teste (redirecionado ou status inválido).');
      await updateStatus(false, 'Sessão expirada.');
      return reply.status(400).send({
        success: false,
        error: 'Sessão expirada. Atualize a sessão.',
        action: 'session_expired'
      });
    }

    const htmlForm = simpleTestResponse.data;
    const token = extractToken(htmlForm);

    if (!token) {
      logger.warn('Token CSRF não localizado. Abortando geração.');
      await updateStatus(false, 'Sessão expirada (token ausente).');
      return reply.status(400).send({
        success: false,
        error: 'Sessão expirada. Atualize a sessão.',
        action: 'session_expired'
      });
    }

    // 3. Make POST /clients/generatetest
    logger.info('Enviando dados de geração de teste...');
    const formData = new URLSearchParams();
    formData.append('_token', token);
    formData.append('plans', plano.toString());
    formData.append('notes', notes);

    let generateResponse;
    try {
      generateResponse = await cmsClient.post('/clients/generatetest', formData, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });
    } catch (err) {
      logger.error('Falha na requisição POST /clients/generatetest:', err.message);
      return reply.status(500).send({
        success: false,
        error: 'Não foi possível gerar o teste agora.',
        action: 'fallback_whatsapp'
      });
    }

    // Verify response URL or body to check for redirects to login
    const finalUrl = generateResponse.request?.res?.responseUrl || '';
    if (finalUrl.includes('/login')) {
      logger.warn('Sessão expirada após envio do formulário de geração (redirecionado para login).');
      await updateStatus(false, 'Sessão expirada.');
      return reply.status(400).send({
        success: false,
        error: 'Sessão expirada. Atualize a sessão.',
        action: 'session_expired'
      });
    }

    // 4. Parse response HTML
    logger.info('Analisando resultado da geração...');
    const testData = extractTestData(generateResponse.data);

    // If parse didn't find usuario or link_lista, something went wrong (like IPTV panel limit reached, daily quota, etc.)
    if (!testData.usuario || !testData.link_lista) {
      logger.error('Falha ao extrair credenciais do HTML retornado pelo painel (pode ser limite excedido, cota diária ou alteração de layout).');
      return reply.status(500).send({
        success: false,
        error: 'Não foi possível gerar o teste agora.',
        action: 'fallback_whatsapp'
      });
    }

    // 5. Resolve internal client ID using getClients
    testData.identificador_fornecedor = null;
    let resolvedClient = null;
    try {
      resolvedClient = await resolverClienteFornecedor(testData.usuario, cmsClient);
      testData.identificador_fornecedor = resolvedClient.user_id;

      // Conferência de vencimento
      const genVencISO = parseBrazilianDate(testData.vencimento);
      const clientsVencISO = parseBrazilianDate(resolvedClient.expires);
      if (genVencISO && clientsVencISO) {
        const diffMs = Math.abs(new Date(genVencISO).getTime() - new Date(clientsVencISO).getTime());
        if (diffMs > 5000) {
          logger.warn(`[Vencimento] Divergência detectada entre generatetest (${testData.vencimento}) e getClients (${resolvedClient.expires})`);
        }
      }
    } catch (err) {
      logger.error(`[Reconciliação Requerida] Falha ao resolver ID interno para o usuário '${testData.usuario}': ${err.message}`);
      testData.reconciliacao_requerida = true;
      testData.reconciliacao_erro = err.message;
    }

    // 6. Save history to data/generated-tests.jsonl (No password saved)
    try {
      const historyPath = path.resolve('data/generated-tests.jsonl');
      const historyEntry = JSON.stringify({
        telefone: telefone || 'Não informado',
        plano: plano,
        usuario: testData.usuario,
        url: testData.url || '',
        vencimento: testData.vencimento,
        identificador_fornecedor: testData.identificador_fornecedor,
        createdAt: new Date().toISOString()
      }) + '\n';
      
      await fs.appendFile(historyPath, historyEntry, 'utf-8');
      logger.info('Geração gravada no arquivo de histórico.');
    } catch (err) {
      // Don't fail the request if writing history fails, just log it
      logger.error('Erro ao salvar histórico de geração localmente:', err.message);
    }

    // 7. Return Success Response
    logger.info('Teste gerado com sucesso!');
    return {
      success: true,
      data: testData
    };

  } finally {
    // Always release the concurrency slot
    releaseSlot();
  }
});

// ─── POST /acessos/estender ───────────────────────────────────────────────────
// Estende o vencimento de um acesso no fornecedor em +3 dias corridos.
// Idempotente via Supabase (tabela operacoes_fornecedor).
fastify.post('/acessos/estender', { preHandler: checkAuth }, async (request, reply) => {
  const {
    identificador_fornecedor,
    usuario_acesso,
    idempotency_key,
    usuario_id,
    acesso_provisionado_id
  } = request.body ?? {};

  // Validação básica de presença antes de chamar o extender
  if (!identificador_fornecedor || !usuario_acesso || !idempotency_key) {
    return reply.status(400).send({
      success: false,
      error: 'INVALID_REQUEST',
      message: 'identificador_fornecedor, usuario_acesso e idempotency_key são obrigatórios'
    });
  }

  try {
    const result = await extenderAcesso(
      { identificador_fornecedor, usuario_acesso, idempotency_key, usuario_id, acesso_provisionado_id },
      { cmsClient, db: supabaseAdmin }
    );

    const httpStatus = result.cached ? 200 : 200;
    return reply.status(httpStatus).send({ success: true, ...result });

  } catch (err) {
    const code = err.message;
    const httpStatus = err.status ?? 500;

    // Retornos esperados (não são bugs — não logar como erro crítico)
    const expectedCodes = [
      'PANEL_SESSION_EXPIRED', 'PANEL_CSRF_UNAVAILABLE',
      'SUPPLIER_CLIENT_NOT_FOUND', 'SUPPLIER_CLIENT_AMBIGUOUS', 'SUPPLIER_CLIENT_MISMATCH',
      'SUPPLIER_INVALID_EXPIRATION', 'SUPPLIER_CONNECTIONS_UNAVAILABLE',
      'SUPPLIER_EXTENSION_FAILED', 'SUPPLIER_EXTENSION_NOT_CONFIRMED', 'SUPPLIER_EXTENSION_UNCERTAIN',
      'IDEMPOTENCY_KEY_REUSED', 'IDEMPOTENCY_IN_PROGRESS', 'IDEMPOTENCY_RESERVATION_FAILED',
      'INVALID_REQUEST'
    ];

    if (!expectedCodes.includes(code)) {
      logger.error(`[/acessos/estender] Erro inesperado:`, err);
    } else {
      logger.warn(`[/acessos/estender] ${code} (${httpStatus})`);
    }

    return reply.status(httpStatus).send({
      success: false,
      error: code,
      message: err.details ?? code
    });
  }
});

// Start server
const start = async () => {
  try {
    const port = parseInt(process.env.PORT || '3000', 10);
    const host = process.env.HOST || '0.0.0.0';
    await fastify.listen({ port, host });
    logger.info(`Servidor da API de testes rodando na porta ${port} no host ${host}`);

    // Start background keep alive job
    startKeepAliveJob();

    // Recovery de operações com locks expirados (supplier_call_started → uncertain, reserved → failed_before_call)
    // Somente operações cujo lock REALMENTE expirou são afetadas.
    if (supabaseAdmin) {
      recuperarOperacoesExpiradas(supabaseAdmin).then(({ supplierCallStarted, reserved }) => {
        if (supplierCallStarted > 0 || reserved > 0) {
          logger.warn(
            `[Startup] Recovery concluído: ${supplierCallStarted} uncertain, ${reserved} failed_before_call.`
          );
        } else {
          logger.info('[Startup] Recovery: nenhuma operação expirada encontrada.');
        }
      }).catch(err => {
        logger.warn('[Startup] Recovery falhou (não fatal):', err.message);
      });
    }

    // Trigger initial health check in background on startup
    checkSessionHealth().catch(err => {
      logger.error('Erro na validação inicial de sessão no startup:', err.message);
    });

  } catch (err) {
    logger.error('Falha crítica ao iniciar o servidor:', err);
    process.exit(1);
  }
};

if (process.env.NODE_ENV !== 'test') {
  start();
}

export { fastify };
