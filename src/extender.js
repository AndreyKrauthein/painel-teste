import logger from './safeLogger.js';
import { extractToken } from './parser.js';
import { parseBrazilianDateToLocal, calcularDataExtensao, isSupplierStatusOperational } from './parser.js';
import {
  computeRequestHash,
  reservar,
  atualizar,
  recuperarOperacoesExpiradas as _recuperar
} from './idempotency.js';

const TIPO = 'extensao_cortesia_3d';
const SUPPLIER_LOCK_MS = 10 * 60 * 1000; // 10 min

// ─── Helpers internos ─────────────────────────────────────────────────────────

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

  logger.info(`[Extender] Reconciliando operação uncertain '${idempotency_key}'...`);

  // A customDate pode ser um objeto Date do Postgres; normalizamos para string YYYY-MM-DD
  const customDateStr = custom_date instanceof Date
    ? custom_date.toISOString().split('T')[0]
    : String(custom_date);

  let csrfToken, cliente;
  try {
    csrfToken = await obterCsrf(cmsClient);
    cliente   = await buscarCliente(cmsClient, usuario_acesso, identificador_fornecedor, csrfToken);
  } catch (err) {
    logger.warn(`[Extender] Reconciliação falhou ao consultar fornecedor: ${err.message}`);
    return {
      success: false,
      code:    'SUPPLIER_EXTENSION_NOT_CONFIRMED',
      message: 'Reconciliação: fornecedor inacessível',
      status:  202
    };
  }

  const { confirmado, expireDate, detalhes } = confirmarCriterios(
    cliente, identificador_fornecedor, connections, customDateStr
  );

  if (!confirmado) {
    logger.warn(`[Extender] Reconciliação não confirmada. Detalhes: ${JSON.stringify(detalhes)}`);
    return {
      success: false,
      code:    'SUPPLIER_EXTENSION_NOT_CONFIRMED',
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
    status_fornecedor:        cliente.status
  };

  await atualizar(db, idempotency_key, { status: 'done', resultado });
  logger.info(`[Extender] Reconciliação confirmada → done. Vencimento: ${resultado.vencimento_atual}`);
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
    acesso_provisionado_id = null
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
        logger.info(`[Extender] Chave '${idempotency_key}' já concluída. Retornando cache.`);
        return { success: true, cached: true, data: operacao.resultado };

      case 'reserved':
      case 'supplier_call_started':
        throw Object.assign(new Error('IDEMPOTENCY_IN_PROGRESS'), { status: 409 });

      case 'uncertain':
        return reconciliar(db, operacao, cmsClient);

      case 'failed_before_call':
        logger.info(`[Extender] Re-tentativa permitida para '${idempotency_key}' (failed_before_call).`);
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

  // 9. Calcular data de extensão (+3 dias corridos em BRT)
  const { base, customDate } = calcularDataExtensao(expireRaw);
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
  try {
    const body = new URLSearchParams();
    body.append('_token',     csrfToken);
    body.append('option',     'custom');
    body.append('customDate', customDate);
    body.append('connections', String(maxCons));

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
    // Erro de rede/timeout — não sabemos se o fornecedor executou a mutação
    await atualizar(db, idempotency_key, {
      status:                  'uncertain',
      erro_codigo:             'SUPPLIER_EXTENSION_UNCERTAIN',
      erro_detalhe_sanitizado: 'Erro de rede ao chamar /extend; estado da mutação desconhecido'
    });
    throw Object.assign(new Error('SUPPLIER_EXTENSION_UNCERTAIN'), { status: 202 });
  }

  // 12. Verificar resposta do /extend
  const extendOk = extendResponse.status === 200 && extendResponse.data?.success === true;

  if (!extendOk) {
    // 4xx = rejeição explícita (terminal: failed)
    // 5xx ou outro = não sabemos (uncertain)
    const isExplicitRejection =
      extendResponse.status >= 400 && extendResponse.status < 500;

    const novoStatus = isExplicitRejection ? 'failed' : 'uncertain';
    await atualizar(db, idempotency_key, {
      status:                  novoStatus,
      erro_codigo:             'SUPPLIER_EXTENSION_FAILED',
      erro_detalhe_sanitizado: `Fornecedor retornou HTTP ${extendResponse.status}`
    });
    throw Object.assign(
      new Error('SUPPLIER_EXTENSION_FAILED'),
      { status: isExplicitRejection ? 502 : 502 }
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
    logger.info(`[Extender] Tentativa de confirmação ${i + 1}/${delays.length}...`);
    try {
      const csrfConf = await obterCsrf(cmsClient);
      clienteConfirmado = await buscarCliente(
        cmsClient, usuario_acesso, identificador_fornecedor, csrfConf
      );
      const conf = confirmarCriterios(
        clienteConfirmado, identificador_fornecedor, maxCons, customDate
      );
      if (conf.confirmado) {
        confirmado = true;
        novoExpire = conf.expireDate;
        detalhesConfirmacao = conf.detalhes;
        break; // Confirmado, sai do loop
      } else {
        detalhesConfirmacao = conf.detalhes;
        logger.warn(`[Extender] Tentativa ${i + 1} de confirmação falhou. Detalhes: ${JSON.stringify(conf.detalhes)}`);
      }
    } catch (err) {
      logger.warn(`[Extender] Tentativa ${i + 1} falhou ao obter/buscar cliente: ${err.message}`);
    }
  }

  if (!confirmado) {
    logger.warn(`[Extender] Confirmação falhou em todas as tentativas. Detalhes: ${JSON.stringify(detalhesConfirmacao)}`);
    await atualizar(db, idempotency_key, {
      status:                  'uncertain',
      erro_codigo:             'SUPPLIER_EXTENSION_NOT_CONFIRMED',
      erro_detalhe_sanitizado: 'Extensão aceita pelo fornecedor, mas getClients não confirma no tempo limite'
    });
    throw Object.assign(new Error('SUPPLIER_EXTENSION_NOT_CONFIRMED'), { status: 202 });
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
    status_fornecedor:        clienteConfirmado.status
  };

  await atualizar(db, idempotency_key, { status: 'done', resultado });
  logger.info(
    `[Extender] Extensão confirmada para '${usuario_acesso}'. Novo vencimento: ${resultado.vencimento_atual}`
  );

  return { success: true, cached: false, data: resultado };
}

// Re-exporta recuperarOperacoesExpiradas para uso no server.js
export { _recuperar as recuperarOperacoesExpiradas };
