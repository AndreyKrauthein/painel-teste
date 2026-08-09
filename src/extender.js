import logger from './safeLogger.js';
import { extractToken } from './parser.js';
import { parseBrazilianDateToLocal, calcularDataExtensao, isSupplierStatusOperational } from './parser.js';
import {
  computeRequestHash,
  reservar,
  atualizar,
  transicionar,
  lerOperacao,
  recuperarOperacoesExpiradas as _recuperar
} from './idempotency.js';

const TIPO = 'extensao_cortesia_3d';
const SUPPLIER_LOCK_MS = 10 * 60 * 1000; // 10 min

// ─── Helpers internos ─────────────────────────────────────────────────────────

/**
 * Normaliza o corpo retornado pelo POST /extend, aceitando:
 * - objeto JSON;
 * - JSON retornado como string;
 * - string com espaços;
 * - string com BOM.
 */
export function normalizarRespostaExtend(data) {
  if (data === null || data === undefined) {
    return null;
  }
  if (typeof data === 'object') {
    return data;
  }
  let str = '';
  if (Buffer.isBuffer(data)) {
    str = data.toString('utf8');
  } else if (typeof data === 'string') {
    str = data;
  } else {
    return null;
  }

  let clean = str.trim();
  // Remover BOM se presente
  if (clean.charCodeAt(0) === 0xFEFF) {
    clean = clean.substring(1).trim();
  }

  try {
    return JSON.parse(clean);
  } catch (e) {
    logger.warn(`[Extender] Falha ao fazer o parse da resposta extend como JSON: ${e.message}`);
    return null;
  }
}

/**
 * Obtém CSRF e valida sessão via GET /clients/simpletest.
 * Lança PANEL_SESSION_EXPIRED ou PANEL_CSRF_UNAVAILABLE.
 */
async function obterCsrf(cmsClient) {
  const res = await cmsClient.get('/clients/simpletest');
  const responseUrl =
    res?.request?.res?.responseUrl ||
    res?.request?.responseURL ||
    res?.config?.url ||
    '';
  if (responseUrl.includes('/login')) {
    throw new Error('PANEL_SESSION_EXPIRED');
  }
  const token = extractToken(res.data);
  if (!token) throw new Error('PANEL_CSRF_UNAVAILABLE');
  return token;
}

/**
 * Consulta POST /ajax/getClients e retorna o registro exato do cliente.
 * Lança SUPPLIER_CLIENT_NOT_FOUND | SUPPLIER_CLIENT_AMBIGUOUS | SUPPLIER_CLIENT_MISMATCH.
 */
async function buscarCliente(cmsClient, usuario_acesso, identificador_fornecedor, csrfToken = '') {
  const params = new URLSearchParams();
  params.append('draw', '2');
  params.append('start', '0');
  params.append('length', '25');
  params.append('search[value]', usuario_acesso);
  params.append('search[regex]', 'false');
  params.append('order[0][column]', '0');
  params.append('order[0][dir]', 'desc');
  const cols = ['id', 'username', 'status', 'expire', 'max_cons', 'active_cons', 'rest', 'action'];
  cols.forEach((c, i) => {
    params.append(`columns[${i}][data]`, c);
    params.append(`columns[${i}][name]`, '');
    params.append(`columns[${i}][searchable]`, 'true');
    params.append(`columns[${i}][orderable]`, 'true');
    params.append(`columns[${i}][search][value]`, '');
    params.append(`columns[${i}][search][regex]`, 'false');
  });

  const response = await cmsClient.post('/ajax/getClients', params.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-CSRF-TOKEN': csrfToken
    }
  });

  const json = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
  if (!json || !Array.isArray(json.data)) {
    throw new Error('SUPPLIER_INVALID_RESPONSE');
  }

  const matches = json.data.filter(
    item => item && String(item.raw_username).trim() === String(usuario_acesso).trim()
  );

  if (matches.length === 0) throw new Error('SUPPLIER_CLIENT_NOT_FOUND');
  if (matches.length > 1) throw new Error('SUPPLIER_CLIENT_AMBIGUOUS');

  const cliente = matches[0];
  if (String(cliente.user_id).trim() !== String(identificador_fornecedor).trim()) {
    throw new Error('SUPPLIER_CLIENT_MISMATCH');
  }

  return cliente;
}

/**
 * Verifica se o registro confirmado satisfaz todos os critérios de confirmação.
 * - user_id correto
 * - max_cons preservado e > 0
 * - data civil BRT do expire >= customDate
 * - status operacional
 */
export function confirmarCriterios(cliente, identificador_fornecedor, connections, customDate) {
  const isUserIdOk     = String(cliente.user_id).trim() === String(identificador_fornecedor).trim();
  const isConnectionsOk = Number(cliente.max_cons) === Number(connections) && Number(cliente.max_cons) > 0;
  const isStatusOk     = isSupplierStatusOperational(cliente.status);

  const expireDate = parseBrazilianDateToLocal(cliente.expire);
  let isDateOk = false;
  if (expireDate) {
    const expireBrtStr = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'America/Sao_Paulo'
    }).format(expireDate);
    isDateOk = expireBrtStr >= customDate;
  }

  return {
    confirmado: isUserIdOk && isConnectionsOk && isStatusOk && isDateOk,
    expireDate,
    detalhes: { isUserIdOk, isConnectionsOk, isStatusOk, isDateOk }
  };
}

// ─── Reconciliação ─────────────────────────────────────────────────────────────

/**
 * Tenta confirmar uma operação em estado uncertain via getClients.
 * NÃO chama /extend novamente.
 * Se confirmado → done. Se não → mantém uncertain, retorna 202.
 */
async function reconciliar(db, operacao, cmsClient) {
  const {
    idempotency_key,
    identificador_fornecedor,
    usuario_acesso,
    custom_date,
    connections,
    vencimento_anterior
  } = operacao;

  logger.info(`[extender][${idempotency_key}] Reconciliando operação uncertain...`);
  logger.info(`[extender][${idempotency_key}] Estado carregado da operação: status=${operacao.status}, custom_date=${custom_date}, connections=${connections}, user_id=${identificador_fornecedor}, raw_username=${usuario_acesso}`);

  // A customDate pode ser um objeto Date do Postgres; normalizamos para string YYYY-MM-DD
  const customDateStr = custom_date instanceof Date
    ? custom_date.toISOString().split('T')[0]
    : String(custom_date);

  let csrfToken, cliente;
  try {
    csrfToken = await obterCsrf(cmsClient);
    cliente   = await buscarCliente(cmsClient, usuario_acesso, identificador_fornecedor, csrfToken);
  } catch (err) {
    logger.warn(`[extender][${idempotency_key}] Reconciliação falhou ao consultar fornecedor: ${err.message}`);
    return {
      success: false,
      code:    'SUPPLIER_EXTENSION_UNCERTAIN',
      message: 'Reconciliação: fornecedor inacessível',
      status:  202
    };
  }

  const { confirmado, expireDate, detalhes } = confirmarCriterios(
    cliente, identificador_fornecedor, connections, customDateStr
  );

  logger.info(`[extender][${idempotency_key}] Critérios de confirmação na reconciliação: ${JSON.stringify(detalhes)}`);
  logger.info(`[extender][${idempotency_key}] Valores reais na reconciliação: custom_date=${customDateStr}, expire=${cliente.expire}, status=${cliente.status}, max_cons=${cliente.max_cons}, user_id=${cliente.user_id}, raw_username=${cliente.raw_username}`);

  if (!confirmado) {
    logger.warn(`[extender][${idempotency_key}] Reconciliação não confirmada. Mantendo status uncertain.`);
    return {
      success: false,
      code:    'SUPPLIER_EXTENSION_UNCERTAIN',
      message: 'Estado uncertain não pôde ser confirmado pelo fornecedor',
      status:  202
    };
  }

  const resultado = {
    identificador_fornecedor: String(identificador_fornecedor),
    usuario_acesso:           String(usuario_acesso),
    vencimento_anterior:      vencimento_anterior ? new Date(vencimento_anterior).toISOString() : null,
    data_base:                vencimento_anterior ? new Date(vencimento_anterior).toISOString() : null,
    data_solicitada:          customDateStr,
    vencimento_atual:         expireDate.toISOString(),
    connections:              Number(connections),
    status_fornecedor:        cliente.status,
    evidence: {
      mutationDispatched: true,
      supplierAccepted: true,
      confirmedByGetClients: true,
      confirmedAt: new Date().toISOString(),
      getClientsResponseSanitized: {
        user_id: String(cliente.user_id),
        raw_username: String(cliente.raw_username),
        expire: cliente.expire,
        status: cliente.status,
        max_cons: Number(cliente.max_cons)
      }
    }
  };

  // Transição condicional: uncertain -> done
  try {
    await transicionar(db, idempotency_key, 'uncertain', 'done', {
      resultado,
      erro_codigo: null,
      erro_detalhe_sanitizado: null,
      lock_expires_at: null
    });
  } catch (err) {
    logger.error(`[extender][${idempotency_key}] Erro ao transicionar de uncertain para done na reconciliação: ${err.message}`);
    const op = await lerOperacao(db, idempotency_key);
    if (op?.status === 'done') {
      return { success: true, cached: true, data: op.resultado };
    }
    throw err;
  }

  logger.info(`[extender][${idempotency_key}] Reconciliação confirmada → done. Vencimento: ${resultado.vencimento_atual}`);
  return { success: true, cached: false, data: resultado };
}

// ─── Entrada pública ───────────────────────────────────────────────────────────

/**
 * Estende o vencimento de um acesso no fornecedor em +3 dias corridos.
 * Implementa idempotência durável via Supabase.
 *
 * @param {object} params
 *   - identificador_fornecedor {string} user_id no fornecedor
 *   - usuario_acesso           {string} raw_username no fornecedor
 *   - idempotency_key          {string} chave única da operação
 *   - usuario_id               {string|null} UUID do usuário na Central Cine
 *   - acesso_provisionado_id   {string|null} UUID do acesso
 *
 * @param {object} deps
 *   - cmsClient {object} Cliente Axios para o CMS do fornecedor
 *   - db        {object} Cliente Supabase com service_role (ou mock nos testes)
 */
export async function extenderAcesso(params, { cmsClient, db }) {
  const {
    identificador_fornecedor,
    usuario_acesso,
    idempotency_key,
    usuario_id = null,
    acesso_provisionado_id = null,
    dias = 3,
    duracao_dias = null,
    customDate: customDateParam = null,
    custom_date: customDateParamAlt = null
  } = params;

  // 1. Validação básica
  if (!identificador_fornecedor || !usuario_acesso || !idempotency_key) {
    throw Object.assign(new Error('INVALID_REQUEST'), {
      details: 'identificador_fornecedor, usuario_acesso e idempotency_key são obrigatórios'
    });
  }

  // 2. Hash obrigatório do payload imutável
  const requestHash = computeRequestHash(TIPO, identificador_fornecedor, usuario_acesso);

  // 3. Reserva atômica
  let reserva;
  try {
    reserva = await reservar(db, idempotency_key, {
      tipo:                     TIPO,
      identificador_fornecedor: String(identificador_fornecedor),
      usuario_acesso:           String(usuario_acesso),
      usuario_id,
      acesso_provisionado_id,
      request_hash:             requestHash
    });
  } catch (err) {
    throw err; // IDEMPOTENCY_RESERVATION_FAILED
  }

  const { created, operacao } = reserva;

  // 4. Detecção de re-uso de chave com payload diferente
  if (!created && operacao.request_hash && operacao.request_hash !== requestHash) {
    throw Object.assign(new Error('IDEMPOTENCY_KEY_REUSED'), {
      details: 'idempotency_key usada com payload diferente do registrado',
      status:  409
    });
  }

  // 5. Roteamento por estado existente
  if (!created) {
    switch (operacao.status) {
      case 'done':
        logger.info(`[extender][${idempotency_key}] Chave já concluída. Retornando cache.`);
        return { success: true, cached: true, data: operacao.resultado };

      case 'reserved':
      case 'supplier_call_started':
        // Se o lock expirou, podemos avançar (reserved -> failed_before_call, supplier_call_started -> uncertain)
        const isLockExpired = new Date(operacao.lock_expires_at) < new Date();
        if (isLockExpired) {
          if (operacao.status === 'reserved') {
            logger.info(`[extender][${idempotency_key}] Lock de reserved expirou. Forçando re-tentativa.`);
            await atualizar(db, idempotency_key, { status: 'failed_before_call' });
            break; // Continua para o fluxo principal
          } else {
            logger.info(`[extender][${idempotency_key}] Lock de supplier_call_started expirou. Forçando reconciliação.`);
            const updatedOp = await atualizar(db, idempotency_key, {
              status: 'uncertain',
              erro_codigo: 'SUPPLIER_EXTENSION_UNCERTAIN',
              erro_detalhe_sanitizado: 'Lock supplier_call_started expirou em tempo de execução'
            });
            return reconciliar(db, updatedOp, cmsClient);
          }
        }
        throw Object.assign(new Error('IDEMPOTENCY_IN_PROGRESS'), { status: 409 });

      case 'uncertain':
        logger.info(`[extender][${idempotency_key}] Fluxo entrou em Reconciliação.`);
        return reconciliar(db, operacao, cmsClient);

      case 'failed_before_call':
        logger.info(`[extender][${idempotency_key}] Fluxo entrou em Re-tentativa (failed_before_call).`);
        // Continua para o fluxo principal
        break;

      case 'failed':
        throw Object.assign(new Error('SUPPLIER_EXTENSION_FAILED'), {
          details: operacao.erro_codigo,
          status:  502
        });

      default:
        throw new Error('IDEMPOTENCY_UNKNOWN_STATE');
    }
  } else {
    logger.info(`[extender][${idempotency_key}] Fluxo entrou em Nova Extensão.`);
  }

  // ── Fluxo principal ──────────────────────────────────────────────────────────

  // 6. Obter CSRF / validar sessão
  let csrfToken;
  try {
    csrfToken = await obterCsrf(cmsClient);
  } catch (err) {
    await atualizar(db, idempotency_key, {
      status:                  'failed_before_call',
      erro_codigo:             err.message,
      erro_detalhe_sanitizado: err.message === 'PANEL_SESSION_EXPIRED'
        ? 'Sessão expirada no painel do fornecedor'
        : 'CSRF não encontrado na resposta de simpletest'
    });
    throw Object.assign(err, { status: 503 });
  }

  // 7. Buscar cliente no fornecedor
  let cliente;
  try {
    cliente = await buscarCliente(cmsClient, usuario_acesso, identificador_fornecedor, csrfToken);
  } catch (err) {
    await atualizar(db, idempotency_key, {
      status:                  'failed_before_call',
      erro_codigo:             err.message,
      erro_detalhe_sanitizado: err.message
    });
    const httpStatus = err.message === 'SUPPLIER_CLIENT_NOT_FOUND' ? 404 : 409;
    throw Object.assign(err, { status: httpStatus });
  }

  // 8. Validar campos críticos do cliente
  const expireRaw = cliente.expire;
  const maxCons   = Number(cliente.max_cons);
  const expireDate = parseBrazilianDateToLocal(expireRaw);

  if (!expireDate) {
    await atualizar(db, idempotency_key, {
      status:                  'failed_before_call',
      erro_codigo:             'SUPPLIER_INVALID_EXPIRATION',
      erro_detalhe_sanitizado: 'Campo expire do fornecedor não pôde ser parseado'
    });
    throw Object.assign(new Error('SUPPLIER_INVALID_EXPIRATION'), { status: 422 });
  }

  if (!maxCons || maxCons < 1 || isNaN(maxCons)) {
    await atualizar(db, idempotency_key, {
      status:                  'failed_before_call',
      erro_codigo:             'SUPPLIER_CONNECTIONS_UNAVAILABLE',
      erro_detalhe_sanitizado: 'max_cons inválido ou ausente no registro do fornecedor'
    });
    throw Object.assign(new Error('SUPPLIER_CONNECTIONS_UNAVAILABLE'), { status: 422 });
  }

  // 9. Calcular data de extensão parametrizada
  const diasEfetivos = Number.isInteger(Number(dias || duracao_dias)) && Number(dias || duracao_dias) > 0 ? Number(dias || duracao_dias) : 3;
  let customDate = customDateParam || customDateParamAlt;
  if (!customDate || !/^\d{4}-\d{2}-\d{2}$/.test(customDate)) {
    const calc = calcularDataExtensao(expireRaw, diasEfetivos);
    customDate = calc.customDate;
  }
  const vencimentoAnteriorISO = expireDate.toISOString();

  // 10. Transição → supplier_call_started (antes de chamar /extend)
  await atualizar(db, idempotency_key, {
    status:               'supplier_call_started',
    vencimento_anterior:  vencimentoAnteriorISO,
    custom_date:          customDate,
    connections:          maxCons,
    lock_expires_at:      new Date(Date.now() + SUPPLIER_LOCK_MS).toISOString()
  });

  // 11. POST /clients/{user_id}/extend
  let extendResponse;
  let mutationDispatched = false;
  let supplierAccepted = false;

  try {
    const body = new URLSearchParams();
    body.append('_token',     csrfToken);
    body.append('option',     'custom');
    body.append('customDate', customDate);
    body.append('connections', String(maxCons));

    logger.info(`[extender][${idempotency_key}] Enviando POST /clients/${identificador_fornecedor}/extend. custom_date: ${customDate}, max_cons: ${maxCons}`);
    mutationDispatched = true;

    extendResponse = await cmsClient.post(
      `/clients/${identificador_fornecedor}/extend`,
      body.toString(),
      {
        headers: {
          'Content-Type':  'application/x-www-form-urlencoded',
          'X-CSRF-TOKEN':  csrfToken
        }
      }
    );
  } catch (networkErr) {
    logger.warn(`[extender][${idempotency_key}] Erro de rede no POST /extend: ${networkErr.message}. mutationDispatched: ${mutationDispatched}`);
    // Erro de rede/timeout após envio — não sabemos se o fornecedor executou a mutação, classificado como uncertain
    await atualizar(db, idempotency_key, {
      status:                  'uncertain',
      erro_codigo:             'SUPPLIER_EXTENSION_UNCERTAIN',
      erro_detalhe_sanitizado: `Erro de rede ao chamar /extend: ${networkErr.message}`
    });
    throw Object.assign(new Error('SUPPLIER_EXTENSION_UNCERTAIN'), { status: 202 });
  }

  // 12. Verificar resposta do /extend
  logger.info(`[extender][${idempotency_key}] POST /extend retornou status HTTP ${extendResponse?.status}`);
  
  const normalizedData = normalizarRespostaExtend(extendResponse?.data);
  const extendOk = extendResponse.status === 200 && normalizedData?.success === true;

  if (extendOk) {
    supplierAccepted = true;
    logger.info(`[extender][${idempotency_key}] Extensão aceita pelo fornecedor (supplierAccepted = true).`);
  }

  if (!extendOk) {
    // 4xx ou status 200 com success=false = rejeição explícita (terminal: failed)
    // 5xx ou outro (incluindo falha de parse) = não sabemos (uncertain)
    const isExplicitRejection =
      (extendResponse.status >= 400 && extendResponse.status < 500) ||
      (extendResponse.status === 200 && normalizedData?.success === false);

    const novoStatus = isExplicitRejection ? 'failed' : 'uncertain';
    const erroCodigo = isExplicitRejection ? 'SUPPLIER_EXTENSION_FAILED' : 'SUPPLIER_EXTENSION_UNCERTAIN';
    const httpStatus = isExplicitRejection ? 502 : 202;

    logger.warn(`[extender][${idempotency_key}] Falha no POST /extend. status=${extendResponse.status}, isExplicitRejection=${isExplicitRejection}. Mapeando para status=${novoStatus}, erro=${erroCodigo}`);

    await atualizar(db, idempotency_key, {
      status:                  novoStatus,
      erro_codigo:             erroCodigo,
      erro_detalhe_sanitizado: `Fornecedor retornou HTTP ${extendResponse.status} com data: ${typeof extendResponse.data === 'object' ? JSON.stringify(extendResponse.data) : String(extendResponse.data)}`
    });

    throw Object.assign(
      new Error(erroCodigo),
      { status: httpStatus }
    );
  }

  // 13. Consultas de confirmação (retentativas curtas com backoff do getClients)
  let clienteConfirmado = null;
  let confirmado = false;
  let novoExpire = null;
  let detalhesConfirmacao = null;

  const delays = [0, 1000, 2000, 4000];
  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) {
      await new Promise(resolve => setTimeout(resolve, delays[i]));
    }
    logger.info(`[extender][${idempotency_key}] Tentativa de confirmação ${i + 1}/${delays.length}...`);
    try {
      const csrfConf = await obterCsrf(cmsClient);
      clienteConfirmado = await buscarCliente(
        cmsClient, usuario_acesso, identificador_fornecedor, csrfConf
      );
      const conf = confirmarCriterios(
        clienteConfirmado, identificador_fornecedor, maxCons, customDate
      );

      logger.info(`[extender][${idempotency_key}] Critérios de confirmação da tentativa ${i + 1}: ${JSON.stringify(conf.detalhes)}`);
      logger.info(`[extender][${idempotency_key}] Valores reais consultados: custom_date=${customDate}, expire=${clienteConfirmado.expire}, status=${clienteConfirmado.status}, max_cons=${clienteConfirmado.max_cons}, user_id=${clienteConfirmado.user_id}, raw_username=${clienteConfirmado.raw_username}`);

      if (conf.confirmado) {
        confirmado = true;
        novoExpire = conf.expireDate;
        detalhesConfirmacao = conf.detalhes;
        break; // Confirmado, sai do loop
      } else {
        detalhesConfirmacao = conf.detalhes;
      }
    } catch (err) {
      logger.warn(`[extender][${idempotency_key}] Tentativa ${i + 1} falhou ao obter/buscar cliente: ${err.message}`);
    }
  }

  if (!confirmado) {
    logger.warn(`[extender][${idempotency_key}] Confirmação falhou em todas as tentativas. Detalhes: ${JSON.stringify(detalhesConfirmacao)}`);
    // Se o fornecedor aceitou a extensão (supplierAccepted=true), uma falha de confirmação NUNCA retorna 502/failed
    await atualizar(db, idempotency_key, {
      status:                  'uncertain',
      erro_codigo:             'SUPPLIER_EXTENSION_UNCERTAIN',
      erro_detalhe_sanitizado: 'Extensão aceita pelo fornecedor, mas getClients não confirma no tempo limite'
    });
    throw Object.assign(new Error('SUPPLIER_EXTENSION_UNCERTAIN'), { status: 202 });
  }

  // 14. Sucesso confirmado → done
  const resultado = {
    identificador_fornecedor: String(identificador_fornecedor),
    usuario_acesso:           String(usuario_acesso),
    vencimento_anterior:      vencimentoAnteriorISO,
    data_base:                base.toISOString(),
    data_solicitada:          customDate,
    vencimento_atual:         novoExpire.toISOString(),
    connections:              maxCons,
    status_fornecedor:        clienteConfirmado.status,
    evidence: {
      mutationDispatched: true,
      supplierAccepted: true,
      confirmedByGetClients: true,
      confirmedAt: new Date().toISOString(),
      getClientsResponseSanitized: {
        user_id: String(clienteConfirmado.user_id),
        raw_username: String(clienteConfirmado.raw_username),
        expire: clienteConfirmado.expire,
        status: clienteConfirmado.status,
        max_cons: Number(clienteConfirmado.max_cons)
      }
    }
  };

  // Transição condicional: supplier_call_started -> done
  try {
    await transicionar(db, idempotency_key, 'supplier_call_started', 'done', {
      resultado,
      erro_codigo: null,
      erro_detalhe_sanitizado: null,
      lock_expires_at: null
    });
  } catch (err) {
    logger.error(`[extender][${idempotency_key}] Erro ao transicionar de supplier_call_started para done: ${err.message}`);
    const op = await lerOperacao(db, idempotency_key);
    if (op?.status === 'done') {
      return { success: true, cached: true, data: op.resultado };
    }
    throw err;
  }

  logger.info(
    `[extender][${idempotency_key}] Extensão confirmada para '${usuario_acesso}'. Novo vencimento: ${resultado.vencimento_atual}`
  );

  return { success: true, cached: false, data: resultado };
}

// Re-exporta recuperarOperacoesExpiradas para uso no server.js
export { _recuperar as recuperarOperacoesExpiradas };

