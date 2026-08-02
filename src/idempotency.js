import crypto from 'node:crypto';
import logger from './safeLogger.js';

const TABLE = 'operacoes_fornecedor';

// Lock durations
const LOCK_RESERVED_MS     = 2  * 60 * 1000; // 2 min: tempo para iniciar processamento
const LOCK_SUPPLIER_MS     = 10 * 60 * 1000; // 10 min: tempo para receber resposta do fornecedor

// ─── Hash ─────────────────────────────────────────────────────────────────────

/**
 * Computa o hash determinístico dos campos imutáveis da operação.
 * tipo + identificador_fornecedor + usuario_acesso
 */
export function computeRequestHash(tipo, identificador_fornecedor, usuario_acesso) {
  const canonical = JSON.stringify({
    tipo,
    identificador_fornecedor: String(identificador_fornecedor),
    usuario_acesso: String(usuario_acesso)
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

// ─── Reserva ──────────────────────────────────────────────────────────────────

/**
 * Tenta reservar atomicamente uma chave de idempotência.
 *
 * - INSERT OR CONFLICT: somente code 23505 é silencioso (chave já existe).
 *   Qualquer outro código de erro lança IDEMPOTENCY_RESERVATION_FAILED.
 * - Após INSERT (com ou sem conflito), lê o estado atual via SELECT.
 * - Retorna { created: boolean, operacao: object }.
 *
 * @param {object} db  Cliente Supabase (ou mock nos testes)
 * @param {string} key idempotency_key
 * @param {object} payload Campos iniciais da operação
 */
export async function reservar(db, key, payload) {
  const agora = new Date();
  const lockExpiresAt = new Date(agora.getTime() + LOCK_RESERVED_MS).toISOString();

  const insertData = {
    idempotency_key:          key,
    tipo:                     payload.tipo,
    identificador_fornecedor: String(payload.identificador_fornecedor),
    usuario_acesso:           String(payload.usuario_acesso),
    usuario_id:               payload.usuario_id ?? null,
    acesso_provisionado_id:   payload.acesso_provisionado_id ?? null,
    request_hash:             payload.request_hash,
    status:                   'reserved',
    processing_started_at:    agora.toISOString(),
    lock_expires_at:          lockExpiresAt
  };

  const { error: insertError } = await db
    .from(TABLE)
    .insert(insertData)
    .select();

  if (insertError) {
    if (insertError.code === '23505') {
      // Chave já existe — comportamento esperado em re-tentativas paralelas
      logger.info(`[Idempotência] Chave '${key}' já existe (23505). Lendo estado atual.`);
    } else {
      // Erro real de banco (sem relação com UNIQUE constraint)
      logger.error(
        `[Idempotência] Erro ao reservar '${key}': ${insertError.message} (code: ${insertError.code})`
      );
      throw Object.assign(
        new Error('IDEMPOTENCY_RESERVATION_FAILED'),
        { cause: insertError }
      );
    }
  }

  // Ler estado atual — independente de quem inseriu
  const { data: operacao, error: readError } = await db
    .from(TABLE)
    .select('*')
    .eq('idempotency_key', key)
    .single();

  if (readError || !operacao) {
    logger.error(`[Idempotência] Falha ao ler '${key}' após reserva: ${readError?.message}`);
    throw Object.assign(
      new Error('IDEMPOTENCY_RESERVATION_FAILED'),
      { cause: readError }
    );
  }

  return {
    created: !insertError,   // true = este processo criou a reserva
    operacao
  };
}

// ─── Transição condicional ────────────────────────────────────────────────────

/**
 * Transição de estado condicional.
 * O UPDATE só avança se a operação ainda está em `deStatus`.
 * Lança IDEMPOTENCY_TRANSITION_CONFLICT se outra instância já transitou.
 *
 * @param {object} db
 * @param {string} key
 * @param {string} deStatus  Estado esperado atual
 * @param {string} paraStatus Estado destino
 * @param {object} extra     Campos adicionais a atualizar
 */
export async function transicionar(db, key, deStatus, paraStatus, extra = {}) {
  const { data, error } = await db
    .from(TABLE)
    .update({ status: paraStatus, ...extra })
    .eq('idempotency_key', key)
    .eq('status', deStatus)
    .select()
    .single();

  if (!data) {
    const { data: atual } = await db
      .from(TABLE)
      .select('status')
      .eq('idempotency_key', key)
      .single();
    const currentStatus = atual?.status;
    logger.warn(
      `[Idempotência] Conflito: '${key}' ${deStatus}→${paraStatus}. Status atual: ${currentStatus}`
    );
    throw Object.assign(
      new Error('IDEMPOTENCY_TRANSITION_CONFLICT'),
      { currentStatus }
    );
  }

  return data;
}

// ─── Atualização incondicional ─────────────────────────────────────────────────

/**
 * Atualiza campos de uma operação sem condição de status.
 * Usado para marcar falhas e resultados (sempre queremos gravar, independente do status atual).
 *
 * @param {object} db
 * @param {string} key
 * @param {object} campos Campos a atualizar (incluindo status se necessário)
 */
export async function atualizar(db, key, campos) {
  const { data, error } = await db
    .from(TABLE)
    .update(campos)
    .eq('idempotency_key', key)
    .select()
    .single();

  if (error || !data) {
    logger.warn(`[Idempotência] Falha ao atualizar '${key}': ${error?.message}`);
  }
  return data ?? null;
}

// ─── Leitura ──────────────────────────────────────────────────────────────────

/**
 * Lê o estado atual de uma operação.
 * Retorna null se não encontrada (PGRST116).
 */
export async function lerOperacao(db, key) {
  const { data, error } = await db
    .from(TABLE)
    .select('*')
    .eq('idempotency_key', key)
    .single();

  if (error?.code === 'PGRST116') return null;
  if (error) throw Object.assign(new Error('IDEMPOTENCY_READ_FAILED'), { cause: error });
  return data;
}

// ─── Recovery no startup ──────────────────────────────────────────────────────

/**
 * Recupera operações com locks expirados.
 * Chamado no startup do servidor — antes de registrar as rotas.
 *
 * Regras:
 * - supplier_call_started + lock expirado → uncertain
 *   (POST pode ter ocorrido; não sabemos o resultado)
 * - reserved + lock expirado → failed_before_call
 *   (reserva abandonada antes de qualquer chamada ao fornecedor)
 *
 * Operações com lock VÁLIDO não são tocadas — outro processo pode estar em andamento.
 *
 * @param {object} db
 * @returns {{ supplierCallStarted: number, reserved: number }}
 */
export async function recuperarOperacoesExpiradas(db) {
  const agora = new Date().toISOString();
  let supplierCallStarted = 0;
  let reserved = 0;

  // 1. supplier_call_started com lock expirado → uncertain
  const { data: d1, error: e1 } = await db
    .from(TABLE)
    .update({
      status:                  'uncertain',
      erro_codigo:             'SUPPLIER_EXTENSION_UNCERTAIN',
      erro_detalhe_sanitizado: 'Processo interrompido; lock supplier_call_started expirado no startup'
    })
    .eq('status', 'supplier_call_started')
    .lt('lock_expires_at', agora);

  if (e1) {
    logger.warn(`[Idempotência] Falha ao recuperar supplier_call_started: ${e1.message}`);
  } else {
    supplierCallStarted = Array.isArray(d1) ? d1.length : (d1?.count ?? 0);
    if (supplierCallStarted > 0) {
      logger.warn(`[Idempotência] ${supplierCallStarted} operação(ões) supplier_call_started → uncertain.`);
    }
  }

  // 2. reserved com lock expirado → failed_before_call
  const { data: d2, error: e2 } = await db
    .from(TABLE)
    .update({
      status:                  'failed_before_call',
      erro_codigo:             'IDEMPOTENCY_RESERVATION_ABANDONED',
      erro_detalhe_sanitizado: 'Reserva abandonada; lock reserved expirado no startup'
    })
    .eq('status', 'reserved')
    .lt('lock_expires_at', agora);

  if (e2) {
    logger.warn(`[Idempotência] Falha ao recuperar reserved: ${e2.message}`);
  } else {
    reserved = Array.isArray(d2) ? d2.length : (d2?.count ?? 0);
    if (reserved > 0) {
      logger.info(`[Idempotência] ${reserved} reserva(s) abandonada(s) → failed_before_call.`);
    }
  }

  return { supplierCallStarted, reserved };
}
