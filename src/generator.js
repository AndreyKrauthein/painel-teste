import path from 'path';
import fs from 'fs/promises';
import logger from './safeLogger.js';
import { extractToken, extractTestData, parseBrazilianDate } from './parser.js';
import { resolverClienteFornecedor, buscarClientePorNotes } from './clients.js';
import { acquireSlot, releaseSlot } from './concurrency.js';
import {
  computeRequestHash,
  reservar,
  atualizar
} from './idempotency.js';

const TIPO_CRIACAO = 'criacao_teste_inicial';
const SUPPLIER_LOCK_MS = 10 * 60 * 1000; // 10 min

/**
 * Executa a geração de teste no fornecedor IPTV com idempotência total e controle de concorrência.
 *
 * @param {object} params
 * @param {string} params.telefone
 * @param {number} [params.plano=90]
 * @param {string} [params.notes='']
 * @param {string} [params.mac_address]
 * @param {string} [params.idempotency_key]
 * @param {string} [params.request_hash]
 * @param {string} [params.usuario_id]
 * @param {string} [params.dispositivo_id]
 * @param {string} [params.acesso_provisionado_id]
 * @param {object} deps
 * @param {import('axios').AxiosInstance} deps.cmsClient
 * @param {object} [deps.db] Cliente Supabase
 * @returns {Promise<{ success: boolean; cached: boolean; data: object }>}
 */
export async function gerarAcesso(params, { cmsClient, db }) {
  const {
    telefone = '',
    plano = parseInt(process.env.DEFAULT_PLAN || '90', 10),
    notes = '',
    mac_address,
    idempotency_key,
    request_hash,
    usuario_id,
    dispositivo_id,
    acesso_provisionado_id
  } = params;

  // 1. Limite de concorrência em memória
  if (!acquireSlot()) {
    logger.warn('[generator] Bloqueio por limite de concorrência ativa.');
    throw Object.assign(new Error('Muitas solicitações no momento. Tente novamente em alguns segundos.'), {
      status: 429,
      action: 'try_again'
    });
  }

  try {
    // ─── FLUXO LEGADO (sem idempotency_key) ──────────────────────────────────
    if (!idempotency_key || !db) {
      logger.info(`[generator] Modo legado (sem idempotency_key). Telefone: ${telefone || 'Não informado'}, Plano: ${plano}`);
      const data = await executarCriacaoRBoys({ telefone, plano, notes, cmsClient });
      return { success: true, cached: false, data };
    }

    // ─── FLUXO CANÔNICO IDEMPOTENTE ──────────────────────────────────────────
    logger.info(`[generator][${idempotency_key}] Iniciando geração idempotente. Telefone: ${telefone}, Dispositivo: ${dispositivo_id}`);

    const hashCalculado = request_hash || computeRequestHash(TIPO_CRIACAO, dispositivo_id || telefone, telefone);

    // 2. Reserva / Leitura atômica em operacoes_fornecedor
    const { created, operacao } = await reservar(db, idempotency_key, {
      tipo: TIPO_CRIACAO,
      identificador_fornecedor: dispositivo_id || telefone,
      usuario_acesso: telefone,
      usuario_id,
      acesso_provisionado_id,
      request_hash: hashCalculado
    });

    if (!created && operacao) {
      // 3. Validação de Hash (conflito de chave reutilizada com outro payload)
      if (operacao.request_hash !== hashCalculado) {
        logger.warn(`[generator][${idempotency_key}] IDEMPOTENCY_KEY_REUSED: Hash diferente detectado.`);
        throw Object.assign(new Error('IDEMPOTENCY_KEY_REUSED'), {
          status: 409,
          details: 'Chave de idempotência já utilizada com parâmetros diferentes.'
        });
      }

      // 4. DONE REPLAY: Retornar resultado em cache sem tocar no fornecedor
      if (operacao.status === 'done' && operacao.resultado && operacao.resultado.usuario) {
        logger.info(`[generator][${idempotency_key}] Operação já concluída (done). Retornando resultado em cache (0 chamadas RBoys).`);
        return {
          success: true,
          cached: true,
          data: operacao.resultado
        };
      }

      // 5. LOCK ATIVO: Processo já em andamento por outro worker
      if (operacao.status === 'supplier_call_started') {
        const lockValido = operacao.lock_expires_at && new Date(operacao.lock_expires_at).getTime() > Date.now();
        if (lockValido) {
          logger.warn(`[generator][${idempotency_key}] IDEMPOTENCY_IN_PROGRESS: Lock de fornecedor ativo.`);
          throw Object.assign(new Error('IDEMPOTENCY_IN_PROGRESS'), {
            status: 409,
            details: 'A solicitação de criação já está em processamento.'
          });
        }
        // Lock expirado em criação -> tratar como uncertain (potencialmente ambíguo)
        operacao.status = 'uncertain';
      }

      // 6. TRATAMENTO DE UNCERTAIN (LOOKUP-FIRST DETERMINÍSTICO)
      if (operacao.status === 'uncertain') {
        logger.info(`[generator][${idempotency_key}] Operação em estado UNCERTAIN. Executando lookup determinístico no CMS antes de qualquer ação...`);
        
        const contaExistente = await buscarClientePorNotes(notes, cmsClient);
        if (contaExistente) {
          logger.warn(`[generator][${idempotency_key}] Conta encontrada no RBoys via notes (user_id=${contaExistente.user_id}), mas senha não salva. BLOQUEANDO segunda criação.`);
          
          await atualizar(db, idempotency_key, {
            status: 'uncertain',
            identificador_fornecedor: String(contaExistente.user_id),
            usuario_acesso: contaExistente.username || telefone,
            erro_codigo: 'AMBIGUOUS_CREATION_PASSWORD_UNAVAILABLE',
            erro_detalhe_sanitizado: 'Conta RBoys localizada no fornecedor sem senha disponível em cache',
            lock_expires_at: null
          });

          throw Object.assign(new Error('AMBIGUOUS_CREATION_PASSWORD_UNAVAILABLE'), {
            status: 409,
            details: 'Criação de teste ambígua detectada no fornecedor sem senha disponível.'
          });
        }

        logger.info(`[generator][${idempotency_key}] Lookup confirmou ausência de conta no RBoys. Permitindo nova tentativa controlada.`);
      }

      if (operacao.status === 'failed') {
        throw Object.assign(new Error('SUPPLIER_GENERATION_FAILED'), {
          status: 502,
          details: operacao.erro_codigo
        });
      }
    }

    // 7. ASSUMIR LOCK DE FORNECEDOR (supplier_call_started)
    const agora = new Date();
    const lockExpiresAt = new Date(agora.getTime() + SUPPLIER_LOCK_MS).toISOString();
    await atualizar(db, idempotency_key, {
      status: 'supplier_call_started',
      processing_started_at: agora.toISOString(),
      lock_expires_at: lockExpiresAt,
      erro_codigo: null,
      erro_detalhe_sanitizado: null
    });

    // 8. I/O FORNECEDOR: Obter CSRF e validar sessão
    let token;
    try {
      const simpleResponse = await cmsClient.get('/clients/simpletest');
      const responseUrl = simpleResponse?.request?.res?.responseUrl || simpleResponse?.config?.url || '';
      if (
        responseUrl.includes('/login') ||
        simpleResponse.status === 419 ||
        simpleResponse.status === 401 ||
        simpleResponse.status === 403
      ) {
        throw new Error('PANEL_SESSION_EXPIRED');
      }
      token = extractToken(simpleResponse.data);
      if (!token) {
        throw new Error('PANEL_CSRF_UNAVAILABLE');
      }
    } catch (err) {
      logger.warn(`[generator][${idempotency_key}] Falha antes do dispatch (failed_before_call): ${err.message}`);
      await atualizar(db, idempotency_key, {
        status: 'failed_before_call',
        erro_codigo: err.message || 'PANEL_SESSION_EXPIRED',
        erro_detalhe_sanitizado: err.message === 'PANEL_SESSION_EXPIRED'
          ? 'Sessão expirada no painel do fornecedor antes do dispatch'
          : 'CSRF indisponível antes do dispatch',
        lock_expires_at: null
      });
      throw Object.assign(err, { status: err.message === 'PANEL_SESSION_EXPIRED' ? 400 : 503 });
    }

    // 9. I/O FORNECEDOR: POST /clients/generatetest (A PARTIR DAQUI: UNCERTAIN EM QUALQUER FALHA)
    logger.info(`[generator][${idempotency_key}] Despachando POST /clients/generatetest...`);
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
      logger.error(`[generator][${idempotency_key}] Timeout/Erro durante POST /clients/generatetest (marcando UNCERTAIN): ${err.message}`);
      await atualizar(db, idempotency_key, {
        status: 'uncertain',
        erro_codigo: 'GENERATION_TIMEOUT',
        erro_detalhe_sanitizado: `Timeout ou falha de rede em generatetest: ${err.message}`,
        lock_expires_at: null
      });
      throw Object.assign(new Error('GENERATION_TIMEOUT'), { status: 504 });
    }

    // Verificar se redirecionou para login após o POST
    const finalUrl = generateResponse.request?.res?.responseUrl || '';
    if (finalUrl.includes('/login')) {
      logger.warn(`[generator][${idempotency_key}] Redirecionado para login após envio (marcando UNCERTAIN).`);
      await atualizar(db, idempotency_key, {
        status: 'uncertain',
        erro_codigo: 'PANEL_SESSION_EXPIRED_DURING_CALL',
        erro_detalhe_sanitizado: 'Sessão expirou durante/após envio do formulário de geração',
        lock_expires_at: null
      });
      throw Object.assign(new Error('PANEL_SESSION_EXPIRED'), { status: 400 });
    }

    // 10. Extrair credenciais do HTML retornado
    const testData = extractTestData(generateResponse.data);
    if (!testData.usuario || !testData.senha) {
      logger.error(`[generator][${idempotency_key}] Falha ao extrair credenciais do HTML (marcando UNCERTAIN).`);
      await atualizar(db, idempotency_key, {
        status: 'uncertain',
        erro_codigo: 'SUPPLIER_PARSE_FAILED',
        erro_detalhe_sanitizado: 'HTML retornado pelo painel não continha credenciais válidas',
        lock_expires_at: null
      });
      throw Object.assign(new Error('SUPPLIER_PARSE_FAILED'), { status: 500 });
    }

    // 11. Resolver identificador_fornecedor
    testData.identificador_fornecedor = null;
    try {
      const resolvedClient = await resolverClienteFornecedor(testData.usuario, cmsClient);
      testData.identificador_fornecedor = String(resolvedClient.user_id);

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
      logger.warn(`[generator][${idempotency_key}] Reconciliação pendente ao resolver user_id para '${testData.usuario}': ${err.message}`);
      testData.reconciliacao_requerida = true;
      testData.reconciliacao_erro = err.message;
    }

    // 12. Salvar histórico local sem senha
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
    } catch {}

    // 13. PERSISTIR STATUS DONE NO SUPABASE ANTES DE RESPONDER HTTP
    const resultadoCompleto = {
      ...testData,
      dispositivo_id: dispositivo_id || null,
      concessao_id: operacao?.resultado?.concessao_id || null
    };

    const updateDone = await atualizar(db, idempotency_key, {
      status: 'done',
      usuario_acesso: testData.usuario,
      identificador_fornecedor: String(testData.identificador_fornecedor || '0'),
      resultado: resultadoCompleto,
      lock_expires_at: null,
      erro_codigo: null,
      erro_detalhe_sanitizado: null,
      updated_at: new Date().toISOString()
    });

    if (!updateDone) {
      logger.error(`[generator][${idempotency_key}] Falha crítica ao gravar status done no Supabase!`);
      await atualizar(db, idempotency_key, {
        status: 'uncertain',
        erro_codigo: 'SUPABASE_PERSIST_FAILED'
      });
      throw Object.assign(new Error('SUPABASE_PERSIST_FAILED'), {
        status: 500,
        message: 'Falha ao persistir resultado da criação no banco de dados.'
      });
    }

    logger.info(`[generator][${idempotency_key}] Teste gerado e persistido como DONE com sucesso no Supabase!`);
    return {
      success: true,
      cached: false,
      data: resultadoCompleto
    };

  } finally {
    releaseSlot();
  }
}

/**
 * Função interna para execução pura de criação no RBoys (sem Supabase).
 */
async function executarCriacaoRBoys({ telefone, plano, notes, cmsClient }) {
  const simpleTestResponse = await cmsClient.get('/clients/simpletest');
  const token = extractToken(simpleTestResponse.data);
  if (!token) {
    throw Object.assign(new Error('Sessão expirada.'), { status: 400, action: 'session_expired' });
  }

  const formData = new URLSearchParams();
  formData.append('_token', token);
  formData.append('plans', plano.toString());
  formData.append('notes', notes);

  const generateResponse = await cmsClient.post('/clients/generatetest', formData, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });

  const testData = extractTestData(generateResponse.data);
  if (!testData.usuario || !testData.link_lista) {
    throw Object.assign(new Error('Não foi possível gerar o teste agora.'), { status: 500 });
  }

  testData.identificador_fornecedor = null;
  try {
    const resolvedClient = await resolverClienteFornecedor(testData.usuario, cmsClient);
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
    testData.reconciliacao_requerida = true;
    testData.reconciliacao_erro = err.message;
  }

  return testData;
}
