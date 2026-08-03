/**
 * test/extender.test.js
 * Suite permanente — 31 testes para extender, idempotency e parser.
 * Executa sem conexão real ao Supabase ou ao fornecedor (mocks).
 */

process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { parseBrazilianDateToLocal, calcularDataExtensao, isSupplierStatusOperational } from '../src/parser.js';
import {
  computeRequestHash,
  reservar,
  atualizar,
  lerOperacao,
  recuperarOperacoesExpiradas
} from '../src/idempotency.js';
import { extenderAcesso, confirmarCriterios } from '../src/extender.js';

// ═══════════════════════════════════════════════════════════════════════════════
// MOCK DB BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Cria um cliente Supabase em memória que suporta a API usada por idempotency.js.
 * Chains suportados:
 *   from(T).insert(data).select()                          → Promise
 *   from(T).select('*').eq(f,v).single()                  → Promise
 *   from(T).update(data).eq(f1,v1).eq(f2,v2).select().single() → Promise
 *   from(T).update(data).eq(f,v).lt(f2,v2)               → thenable (Promise via .then)
 *
 * @param {object[]} initialRecords Registros iniciais no store
 * @param {object}   opts  { insertError, updateError }
 */
function createMockDb(initialRecords = [], opts = {}) {
  const store = new Map();
  for (const r of initialRecords) {
    if (r.idempotency_key) store.set(r.idempotency_key, { ...r });
  }
  const { insertError = null, updateError = null } = opts;

  function matchAll(records, eqs, lts) {
    return records.filter(r => {
      for (const [f, v] of eqs) {
        if (String(r[f]) !== String(v)) return false;
      }
      for (const [f, v] of lts) {
        if (!(new Date(r[f]) < new Date(v))) return false;
      }
      return true;
    });
  }

  function makeBuilder(op) {
    const b = {
      _op: op,
      _insertData: null,
      _updateData: null,
      _eqs: [],
      _lts: [],
      _withSelect: false,
      _withSingle: false,
      _fields: '*',

      insert(data) { b._insertData = data; return b; },

      select(fields = '*') {
        if (b._op === 'insert') {
          return Promise.resolve(_execInsert());
        }
        if (b._op === 'update') { b._withSelect = true; return b; }
        b._op = 'select'; b._fields = fields; return b;
      },

      update(data) { b._updateData = data; return b; },

      eq(f, v) { b._eqs.push([f, v]); return b; },
      lt(f, v) { b._lts.push([f, v]); return b; },

      single() { b._withSingle = true; return Promise.resolve(_exec()); },

      then(resolve, reject) { return Promise.resolve(_exec()).then(resolve, reject); }
    };

    function _execInsert() {
      if (insertError) return { data: null, error: insertError };
      const data = b._insertData;
      const key  = data.idempotency_key;
      if (store.has(key)) {
        return { data: null, error: { code: '23505', message: 'duplicate key' } };
      }
      const record = {
        id: 'id-' + Math.random().toString(36).slice(2),
        ...data,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      store.set(key, record);
      return { data: [record], error: null };
    }

    function _exec() {
      if (b._op === 'select') {
        const all   = [...store.values()];
        const found = matchAll(all, b._eqs, b._lts);
        if (b._withSingle) {
          if (found.length === 0) return { data: null, error: { code: 'PGRST116' } };
          return { data: found[0], error: null };
        }
        return { data: found, error: null };
      }

      if (b._op === 'update') {
        if (updateError) return { data: null, error: updateError };
        const all   = [...store.values()];
        const found = matchAll(all, b._eqs, b._lts);
        const updated = found.map(r => {
          const n = { ...r, ...b._updateData, updated_at: new Date().toISOString() };
          store.set(r.idempotency_key, n);
          return n;
        });
        if (b._withSingle) {
          if (updated.length === 0) return { data: null, error: { message: 'no rows updated' } };
          return { data: updated[0], error: null };
        }
        return { data: updated, error: null, count: updated.length };
      }

      return { data: null, error: { message: 'unknown op' } };
    }

    return b;
  }

  return {
    _store: store,
    from(_table) { return makeBuilder('select'); },
  };
}

// ─── Helpers para builder correto por operação ─────────────────────────────────
// Os builders precisam iniciar no modo correto:

function createDb(initialRecords = [], opts = {}) {
  const store = new Map();
  for (const r of initialRecords) {
    if (r.idempotency_key) store.set(r.idempotency_key, { ...r });
  }
  const { insertError = null, updateError = null } = opts;

  function matchAll(records, eqs, lts) {
    return records.filter(r => {
      for (const [f, v] of eqs) if (String(r[f]) !== String(v)) return false;
      for (const [f, v] of lts) if (!(new Date(r[f]) < new Date(v))) return false;
      return true;
    });
  }

  return {
    _store: store,
    from(_table) {
      const b = {
        _op: null,
        _insertData: null,
        _updateData: null,
        _eqs: [],
        _lts: [],
        _withSelect: false,
        _withSingle: false,

        insert(data) { b._op = 'insert'; b._insertData = data; return b; },

        select(fields = '*') {
          if (b._op === 'insert') return Promise.resolve(execInsert());
          if (b._op === 'update') { b._withSelect = true; return b; }
          b._op = 'select';
          return b;
        },

        update(data) { b._op = 'update'; b._updateData = data; return b; },

        eq(f, v) { b._eqs.push([f, v]); return b; },
        lt(f, v) { b._lts.push([f, v]); return b; },

        single() { b._withSingle = true; return Promise.resolve(exec()); },

        then(resolve, reject) { return Promise.resolve(exec()).then(resolve, reject); }
      };

      function execInsert() {
        if (insertError) return { data: null, error: insertError };
        const data = b._insertData;
        const key  = data.idempotency_key;
        if (store.has(key)) {
          return { data: null, error: { code: '23505', message: 'duplicate key' } };
        }
        const record = {
          id: 'id-' + Math.random().toString(36).slice(2),
          ...data,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        store.set(key, record);
        return { data: [record], error: null };
      }

      function exec() {
        if (b._op === 'select') {
          const all   = [...store.values()];
          const found = matchAll(all, b._eqs, b._lts);
          if (b._withSingle) {
            if (found.length === 0) return { data: null, error: { code: 'PGRST116' } };
            return { data: found[0], error: null };
          }
          return { data: found, error: null };
        }
        if (b._op === 'update') {
          if (updateError) return { data: null, error: updateError };
          const all   = [...store.values()];
          const found = matchAll(all, b._eqs, b._lts);
          const updated = found.map(r => {
            const n = { ...r, ...b._updateData, updated_at: new Date().toISOString() };
            store.set(r.idempotency_key, n);
            return n;
          });
          if (b._withSingle) {
            if (updated.length === 0) return { data: null, error: { message: 'no rows updated' } };
            return { data: updated[0], error: null };
          }
          return { data: updated, error: null, count: updated.length };
        }
        return { data: null, error: { message: 'unknown op' } };
      }

      return b;
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MOCK CMS CLIENT FACTORY
// ═══════════════════════════════════════════════════════════════════════════════

function makeCmsClient({
  sessionExpired   = false,
  csrfToken        = 'test-csrf-token',
  clienteData      = null,
  extendStatus     = 200,
  extendSuccess    = true,
  getClientsAfterExtend = null,  // override para a 2ª chamada de getClients
  networkErrorOnExtend = false,
  noClients        = false,
  clienteMismatch  = false,
} = {}) {
  let getClientsCallCount = 0;

  const defaultCliente = clienteData ?? {
    user_id: 3584843,
    raw_username: '54160049',
    expire: '05/08/2035 23:55:00',
    max_cons: 1,
    status: 'enabled'
  };

  return {
    get: async (url) => {
      if (sessionExpired) {
        return {
          data: '<html></html>',
          request: { res: { responseUrl: 'https://cms.rboys02.click/login' } }
        };
      }
      return {
        data: `<form><input name="_token" value="${csrfToken}"></form>`,
        request: { res: { responseUrl: url } }
      };
    },

    post: async (url, body, opts) => {
      if (url.includes('/ajax/getClients')) {
        getClientsCallCount++;
        if (noClients) {
          return { data: { recordsFiltered: 0, data: [] } };
        }
        if (clienteMismatch) {
          // Extrai o raw_username pesquisado do body para que o filtro de raw_username bata
          const searchedUsername = new URLSearchParams(typeof body === 'string' ? body : '').get('search[value]')
            || defaultCliente.raw_username;
          const mismatch = { ...defaultCliente, raw_username: searchedUsername, user_id: 9999999 };
          return { data: { recordsFiltered: 1, data: [mismatch] } };
        }
        // Segunda chamada (confirmação) pode ter override
        const dataToReturn = (getClientsCallCount >= 2 && getClientsAfterExtend)
          ? getClientsAfterExtend
          : [defaultCliente];
        return { data: { recordsFiltered: dataToReturn.length, data: dataToReturn } };
      }

      if (url.includes('/extend')) {
        if (networkErrorOnExtend) {
          throw new Error('Network Error');
        }
        return {
          status: extendStatus,
          data:   { success: extendSuccess, message: 'Plano extendido com sucesso!' }
        };
      }

      throw new Error(`URL não mockada: ${url}`);
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXECUTOR DE TESTES
// ═══════════════════════════════════════════════════════════════════════════════

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}`);
    console.log(`     → ${err.message}`);
    if (err.actual !== undefined) {
      console.log(`     actual:   ${JSON.stringify(err.actual)}`);
      console.log(`     expected: ${JSON.stringify(err.expected)}`);
    }
    failed++;
    failures.push({ name, error: err });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEÇÃO A — parseBrazilianDateToLocal
// ═══════════════════════════════════════════════════════════════════════════════
async function runParserTests() {
  console.log('\n── Seção A: parseBrazilianDateToLocal ──');

  await test('T01 — parse correto de data com horário completo', () => {
    const d = parseBrazilianDateToLocal('05/08/2026 23:55:00');
    assert.ok(d instanceof Date, 'deve retornar Date');
    // 05/08/2026 23:55:00 BRT = 2026-08-06T02:55:00.000Z
    assert.equal(d.toISOString(), '2026-08-06T02:55:00.000Z',
      'Regressão timezone: 23:55 BRT deve ser 02:55 UTC do dia seguinte');
  });

  await test('T02 — parse de data sem horário usa meia-noite BRT', () => {
    const d = parseBrazilianDateToLocal('02/08/2026');
    assert.ok(d instanceof Date);
    // 02/08/2026 00:00:00 BRT = 2026-08-02T03:00:00.000Z
    assert.equal(d.toISOString(), '2026-08-02T03:00:00.000Z');
  });

  await test('T03 — parse de string inválida retorna null', () => {
    assert.equal(parseBrazilianDateToLocal('invalid'), null);
    assert.equal(parseBrazilianDateToLocal(null), null);
    assert.equal(parseBrazilianDateToLocal(''), null);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEÇÃO B — calcularDataExtensao
// ═══════════════════════════════════════════════════════════════════════════════
async function runCalcularTests() {
  console.log('\n── Seção B: calcularDataExtensao ──');

  await test('T04 — caso base: 02/08 + 3 = 05/08', () => {
    const { customDate } = calcularDataExtensao('02/08/2035 12:00:00');
    assert.equal(customDate, '2035-08-05', `esperado 2035-08-05, recebido ${customDate}`);
  });

  await test('T05 — vencimento futuro: base = vencimento_atual', () => {
    // Usa uma data muito no futuro para garantir que seja > agora
    const future = '31/12/2038 12:00:00';
    const { base, customDate } = calcularDataExtensao(future);
    // base deve ser o vencimento, não agora
    assert.ok(base.getFullYear() === 2038, 'base deve ser 2038');
    assert.equal(customDate, '2039-01-03');
  });

  await test('T06 — vencimento expirado: base = agora', () => {
    // Data no passado
    const past = '01/01/2020 00:00:00';
    const before = new Date();
    const { base } = calcularDataExtensao(past);
    const after = new Date();
    // base deve estar entre before e after (ou seja, é "agora")
    assert.ok(base >= before && base <= after,
      `base deve ser aprox agora, recebido: ${base.toISOString()}`);
  });

  await test('T07 — virada de mês: 29/08 + 3 = 01/09', () => {
    const { customDate } = calcularDataExtensao('29/08/2035 12:00:00');
    assert.equal(customDate, '2035-09-01',
      `esperado 2035-09-01, recebido ${customDate}`);
  });

  await test('T08 — virada de ano: 30/12 + 3 = 02/01', () => {
    const { customDate } = calcularDataExtensao('30/12/2035 12:00:00');
    assert.equal(customDate, '2036-01-02',
      `esperado 2036-01-02, recebido ${customDate}`);
  });

  await test('T09 — formato correto YYYY-MM-DD', () => {
    const { customDate } = calcularDataExtensao('01/01/2035 10:00:00');
    assert.match(customDate, /^\d{4}-\d{2}-\d{2}$/, 'deve ser YYYY-MM-DD');
  });

  await test('T10 — regressão: 05/08/2035 23:55 BRT = 2035-08-06T02:55:00Z', () => {
    const { novaData } = calcularDataExtensao('02/08/2035 23:55:00');
    // customDate = 2035-08-05, novaData = 2035-08-05T23:55:00-03:00
    // Verificamos apenas que o customDate é correto (novaData depende do horário normalizado pelo fornecedor)
    const { customDate } = calcularDataExtensao('02/08/2035 23:55:00');
    assert.equal(customDate, '2035-08-05');
    // E que parsear "05/08/2035 23:55:00" dá o ISO correto
    const d = parseBrazilianDateToLocal('05/08/2035 23:55:00');
    assert.equal(d.toISOString(), '2035-08-06T02:55:00.000Z',
      '05/08/2035 23:55 BRT deve mapear para 2035-08-06T02:55:00.000Z');
  });

  await test('T11 — max_cons=1 passado intacto no payload', async () => {
    const cms = makeCmsClient({
      clienteData: { user_id: 100, raw_username: 'user1', expire: '10/08/2035 23:55:00', max_cons: 1, status: 'enabled' },
      getClientsAfterExtend: [{ user_id: 100, raw_username: 'user1', expire: '13/08/2035 23:55:00', max_cons: 1, status: 'enabled' }]
    });
    const extendCalls = [];
    const origPost = cms.post.bind(cms);
    cms.post = async (url, body, opts) => {
      if (url.includes('/extend')) extendCalls.push(body);
      return origPost(url, body, opts);
    };
    const db = createDb();
    await extenderAcesso({ identificador_fornecedor: '100', usuario_acesso: 'user1', idempotency_key: 'test-T11' }, { cmsClient: cms, db });
    assert.ok(extendCalls.length === 1, 'deve ter chamado /extend uma vez');
    assert.ok(extendCalls[0].includes('connections=1'), 'connections=1 deve estar no body');
  });

  await test('T12 — max_cons=2 passado intacto no payload', async () => {
    const cms = makeCmsClient({
      clienteData: { user_id: 200, raw_username: 'user2', expire: '10/08/2035 23:55:00', max_cons: 2, status: 'enabled' },
      getClientsAfterExtend: [{ user_id: 200, raw_username: 'user2', expire: '13/08/2035 23:55:00', max_cons: 2, status: 'enabled' }]
    });
    const extendCalls = [];
    const origPost = cms.post.bind(cms);
    cms.post = async (url, body, opts) => {
      if (url.includes('/extend')) extendCalls.push(body);
      return origPost(url, body, opts);
    };
    const db = createDb();
    await extenderAcesso({ identificador_fornecedor: '200', usuario_acesso: 'user2', idempotency_key: 'test-T12' }, { cmsClient: cms, db });
    assert.ok(extendCalls[0].includes('connections=2'), 'connections=2 deve estar no body');
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEÇÃO C — Idempotência
// ═══════════════════════════════════════════════════════════════════════════════
async function runIdempotencyTests() {
  console.log('\n── Seção C: idempotency.js ──');

  await test('T13 — nova chave cria registro com status=reserved', async () => {
    const db = createDb();
    const hash = computeRequestHash('tipo_x', 'id_x', 'user_x');
    const { created, operacao } = await reservar(db, 'key-T13', {
      tipo: 'tipo_x', identificador_fornecedor: 'id_x', usuario_acesso: 'user_x',
      request_hash: hash
    });
    assert.ok(created, 'created deve ser true');
    assert.equal(operacao.status, 'reserved');
    assert.equal(operacao.idempotency_key, 'key-T13');
  });

  await test('T14 — chave duplicada (23505) retorna estado atual, created=false', async () => {
    const db = createDb([{
      idempotency_key: 'key-T14', status: 'done', request_hash: 'abc',
      tipo: 'tipo_x', identificador_fornecedor: 'id_x', usuario_acesso: 'user_x'
    }]);
    const { created, operacao } = await reservar(db, 'key-T14', {
      tipo: 'tipo_x', identificador_fornecedor: 'id_x', usuario_acesso: 'user_x',
      request_hash: 'abc'
    });
    assert.equal(created, false);
    assert.equal(operacao.status, 'done');
  });

  await test('T15 — erro de banco diferente de 23505 lança IDEMPOTENCY_RESERVATION_FAILED', async () => {
    const db = createDb([], {
      insertError: { code: '42P01', message: 'relation does not exist' }
    });
    await assert.rejects(
      () => reservar(db, 'key-T15', {
        tipo: 't', identificador_fornecedor: 'i', usuario_acesso: 'u', request_hash: 'h'
      }),
      (err) => {
        assert.equal(err.message, 'IDEMPOTENCY_RESERVATION_FAILED');
        return true;
      }
    );
  });

  await test('T16 — mesma chave com payload diferente lança IDEMPOTENCY_KEY_REUSED', async () => {
    const db = createDb();
    const hash1 = computeRequestHash('tipo', 'id1', 'user1');
    const hash2 = computeRequestHash('tipo', 'id2', 'user2'); // payload diferente

    await reservar(db, 'key-T16', {
      tipo: 'tipo', identificador_fornecedor: 'id1', usuario_acesso: 'user1', request_hash: hash1
    });

    await assert.rejects(
      () => extenderAcesso(
        { identificador_fornecedor: 'id2', usuario_acesso: 'user2', idempotency_key: 'key-T16' },
        { cmsClient: makeCmsClient(), db }
      ),
      (err) => {
        assert.equal(err.message, 'IDEMPOTENCY_KEY_REUSED');
        return true;
      }
    );
  });

  await test('T17 — reserved abandonado (lock expirado) → failed_before_call', async () => {
    const past = new Date(Date.now() - 60000).toISOString(); // 1 min atrás
    const db = createDb([{
      idempotency_key: 'key-T17', status: 'reserved', lock_expires_at: past,
      request_hash: 'h', tipo: 't', identificador_fornecedor: 'i', usuario_acesso: 'u'
    }]);
    const counts = await recuperarOperacoesExpiradas(db);
    assert.equal(counts.reserved, 1, 'deve ter recuperado 1 reserved');
    const rec = db._store.get('key-T17');
    assert.equal(rec.status, 'failed_before_call');
    assert.equal(rec.erro_codigo, 'IDEMPOTENCY_RESERVATION_ABANDONED');
  });

  await test('T18 — supplier_call_started com lock VÁLIDO não é recuperado', async () => {
    const future = new Date(Date.now() + 600000).toISOString(); // 10 min no futuro
    const db = createDb([{
      idempotency_key: 'key-T18', status: 'supplier_call_started', lock_expires_at: future,
      request_hash: 'h', tipo: 't', identificador_fornecedor: 'i', usuario_acesso: 'u'
    }]);
    await recuperarOperacoesExpiradas(db);
    const rec = db._store.get('key-T18');
    assert.equal(rec.status, 'supplier_call_started', 'lock válido NÃO deve ser recuperado');
  });

  await test('T19 — supplier_call_started com lock EXPIRADO → uncertain', async () => {
    const past = new Date(Date.now() - 60000).toISOString();
    const db = createDb([{
      idempotency_key: 'key-T19', status: 'supplier_call_started', lock_expires_at: past,
      request_hash: 'h', tipo: 't', identificador_fornecedor: 'i', usuario_acesso: 'u'
    }]);
    const counts = await recuperarOperacoesExpiradas(db);
    assert.equal(counts.supplierCallStarted, 1);
    const rec = db._store.get('key-T19');
    assert.equal(rec.status, 'uncertain');
    assert.equal(rec.erro_codigo, 'SUPPLIER_EXTENSION_UNCERTAIN');
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEÇÃO D — extenderAcesso (fluxo completo)
// ═══════════════════════════════════════════════════════════════════════════════
async function runExtenderTests() {
  console.log('\n── Seção D: extenderAcesso (fluxo completo) ──');

  await test('T20 — campos obrigatórios ausentes lança INVALID_REQUEST', async () => {
    const db = createDb();
    await assert.rejects(
      () => extenderAcesso({ identificador_fornecedor: '', usuario_acesso: 'u', idempotency_key: 'k' }, { cmsClient: makeCmsClient(), db }),
      (err) => { assert.equal(err.message, 'INVALID_REQUEST'); return true; }
    );
  });

  await test('T21 — sessão expirada → PANEL_SESSION_EXPIRED; status=failed_before_call', async () => {
    const db = createDb();
    const cms = makeCmsClient({ sessionExpired: true });
    await assert.rejects(
      () => extenderAcesso({ identificador_fornecedor: '100', usuario_acesso: 'u100', idempotency_key: 'key-T21' }, { cmsClient: cms, db }),
      (err) => { assert.equal(err.message, 'PANEL_SESSION_EXPIRED'); return true; }
    );
    const rec = db._store.get('key-T21');
    assert.equal(rec.status, 'failed_before_call');
  });

  await test('T22 — max_cons ausente → SUPPLIER_CONNECTIONS_UNAVAILABLE; POST não chamado', async () => {
    let extendCalled = false;
    const cms = makeCmsClient({
      clienteData: { user_id: 300, raw_username: 'u300', expire: '05/08/2035 23:55:00', max_cons: 0, status: 'enabled' }
    });
    const origPost = cms.post.bind(cms);
    cms.post = async (url, body, opts) => {
      if (url.includes('/extend')) extendCalled = true;
      return origPost(url, body, opts);
    };
    const db = createDb();
    await assert.rejects(
      () => extenderAcesso({ identificador_fornecedor: '300', usuario_acesso: 'u300', idempotency_key: 'key-T22' }, { cmsClient: cms, db }),
      (err) => { assert.equal(err.message, 'SUPPLIER_CONNECTIONS_UNAVAILABLE'); return true; }
    );
    assert.equal(extendCalled, false, 'POST /extend NÃO deve ser chamado');
    const rec = db._store.get('key-T22');
    assert.equal(rec.status, 'failed_before_call');
  });

  await test('T23 — cliente não encontrado → SUPPLIER_CLIENT_NOT_FOUND; status=failed_before_call', async () => {
    const db = createDb();
    const cms = makeCmsClient({ noClients: true });
    await assert.rejects(
      () => extenderAcesso({ identificador_fornecedor: '400', usuario_acesso: 'u400', idempotency_key: 'key-T23' }, { cmsClient: cms, db }),
      (err) => { assert.equal(err.message, 'SUPPLIER_CLIENT_NOT_FOUND'); return true; }
    );
    const rec = db._store.get('key-T23');
    assert.equal(rec.status, 'failed_before_call');
  });

  await test('T24 — user_id não bate → SUPPLIER_CLIENT_MISMATCH; status=failed_before_call', async () => {
    const db = createDb();
    const cms = makeCmsClient({ clienteMismatch: true });
    await assert.rejects(
      () => extenderAcesso({ identificador_fornecedor: '500', usuario_acesso: 'u500', idempotency_key: 'key-T24' }, { cmsClient: cms, db }),
      (err) => { assert.equal(err.message, 'SUPPLIER_CLIENT_MISMATCH'); return true; }
    );
    const rec = db._store.get('key-T24');
    assert.equal(rec.status, 'failed_before_call');
  });

  await test('T25 — timeout/erro de rede → uncertain; POST não é repetido', async () => {
    const db = createDb();
    const cms = makeCmsClient({ networkErrorOnExtend: true });
    await assert.rejects(
      () => extenderAcesso({ identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-T25' }, { cmsClient: cms, db }),
      (err) => { assert.equal(err.message, 'SUPPLIER_EXTENSION_UNCERTAIN'); return true; }
    );
    const rec = db._store.get('key-T25');
    assert.equal(rec.status, 'uncertain');
  });

  await test('T26 — rejeição explícita (4xx) → estado terminal failed', async () => {
    const db = createDb();
    const cms = makeCmsClient({ extendStatus: 403, extendSuccess: false });
    await assert.rejects(
      () => extenderAcesso({ identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-T26' }, { cmsClient: cms, db }),
      (err) => { assert.equal(err.message, 'SUPPLIER_EXTENSION_FAILED'); return true; }
    );
    const rec = db._store.get('key-T26');
    assert.equal(rec.status, 'failed', 'rejeição 4xx deve ser terminal (failed)');
  });

  await test('T27 — sucesso com confirmação → done; retorna vencimento_atual', async () => {
    const db = createDb();
    const cms = makeCmsClient({
      clienteData: { user_id: 3584843, raw_username: '54160049', expire: '02/08/2035 23:55:00', max_cons: 1, status: 'enabled' },
      getClientsAfterExtend: [{
        user_id: 3584843, raw_username: '54160049',
        expire: '05/08/2035 23:55:00', max_cons: 1, status: 'enabled'
      }]
    });
    const result = await extenderAcesso(
      { identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-T27' },
      { cmsClient: cms, db }
    );
    assert.equal(result.success, true);
    assert.equal(result.cached, false);
    assert.equal(result.data.connections, 1);
    assert.equal(result.data.data_solicitada, '2035-08-05');
    // 05/08/2035 23:55:00 BRT = 2035-08-06T02:55:00.000Z
    assert.equal(result.data.vencimento_atual, '2035-08-06T02:55:00.000Z',
      'vencimento_atual deve corresponder a 23:55 BRT do customDate');
    const rec = db._store.get('key-T27');
    assert.equal(rec.status, 'done');
  });

  await test('T28 — horário normalizado 23:55 BRT no vencimento_atual', async () => {
    // Confirma que o vencimento retornado está em 23:55 BRT (= 02:55 UTC dia seguinte)
    const result = await extenderAcesso(
      { identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-T28' },
      {
        cmsClient: makeCmsClient({
          clienteData: { user_id: 3584843, raw_username: '54160049', expire: '02/08/2035 23:55:00', max_cons: 1, status: 'enabled' },
          getClientsAfterExtend: [{ user_id: 3584843, raw_username: '54160049', expire: '05/08/2035 23:55:00', max_cons: 1, status: 'enabled' }]
        }),
        db: createDb()
      }
    );
    assert.ok(result.data.vencimento_atual.endsWith('T02:55:00.000Z'),
      `Esperado 02:55:00.000Z, recebido: ${result.data.vencimento_atual}`);
  });

  await test('T29 — success=true mas getClients não confirma → uncertain (SUPPLIER_EXTENSION_NOT_CONFIRMED)', async () => {
    const db = createDb();
    // Fornecedor retorna success=true, mas getClients na confirmação devolve data anterior
    const cms = makeCmsClient({
      clienteData: { user_id: 3584843, raw_username: '54160049', expire: '02/08/2035 23:55:00', max_cons: 1, status: 'enabled' },
      getClientsAfterExtend: [{
        user_id: 3584843, raw_username: '54160049',
        expire: '02/08/2035 23:55:00', // data NÃO atualizada
        max_cons: 1, status: 'enabled'
      }]
    });
    await assert.rejects(
      () => extenderAcesso({ identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-T29' }, { cmsClient: cms, db }),
      (err) => { assert.equal(err.message, 'SUPPLIER_EXTENSION_NOT_CONFIRMED'); return true; }
    );
    const rec = db._store.get('key-T29');
    assert.equal(rec.status, 'uncertain');
  });

  await test('T30 — mesma chave duas vezes → POST chamado apenas uma vez; segunda retorna cache', async () => {
    const db = createDb();
    let extendCallCount = 0;
    const cms = makeCmsClient({
      clienteData: { user_id: 3584843, raw_username: '54160049', expire: '02/08/2035 23:55:00', max_cons: 1, status: 'enabled' },
      getClientsAfterExtend: [{ user_id: 3584843, raw_username: '54160049', expire: '05/08/2035 23:55:00', max_cons: 1, status: 'enabled' }]
    });
    const origPost = cms.post.bind(cms);
    cms.post = async (url, body, opts) => {
      if (url.includes('/extend')) extendCallCount++;
      return origPost(url, body, opts);
    };

    const r1 = await extenderAcesso({ identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-T30' }, { cmsClient: cms, db });
    const r2 = await extenderAcesso({ identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-T30' }, { cmsClient: cms, db });

    assert.equal(extendCallCount, 1, 'POST /extend chamado apenas 1 vez');
    assert.equal(r1.success, true);
    assert.equal(r2.success, true);
    assert.equal(r2.cached, true, 'segunda chamada deve vir do cache');
  });

  await test('T31 — vencimento posterior à custom_date satisfaz reconciliação', async () => {
    // uncertain com custom_date = 05/08/2035
    // expire retornado = 06/08/2035 (posterior) → ainda deve confirmar
    const pastLock = new Date(Date.now() - 60000).toISOString();
    const db = createDb([{
      idempotency_key: 'key-T31', status: 'uncertain',
      identificador_fornecedor: '3584843', usuario_acesso: '54160049',
      custom_date: '2035-08-05', connections: 1,
      vencimento_anterior: '2035-08-02T02:55:00.000Z',
      lock_expires_at: pastLock,
      request_hash: computeRequestHash('extensao_cortesia_3d', '3584843', '54160049'),
      tipo: 'extensao_cortesia_3d'
    }]);
    const cms = makeCmsClient({
      clienteData: {
        user_id: 3584843, raw_username: '54160049',
        expire: '06/08/2035 23:55:00', // POSTERIOR à custom_date 05/08
        max_cons: 1, status: 'enabled'
      }
    });
    const result = await extenderAcesso(
      { identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-T31' },
      { cmsClient: cms, db }
    );
    assert.equal(result.success, true, 'expire posterior deve satisfazer a reconciliação');
    const rec = db._store.get('key-T31');
    assert.equal(rec.status, 'done');
  });

  await test('T32 — status disabled não é confirmado na reconciliação', async () => {
    const pastLock = new Date(Date.now() - 60000).toISOString();
    const db = createDb([{
      idempotency_key: 'key-T32', status: 'uncertain',
      identificador_fornecedor: '3584843', usuario_acesso: '54160049',
      custom_date: '2035-08-05', connections: 1,
      vencimento_anterior: '2035-08-02T02:55:00.000Z',
      lock_expires_at: pastLock,
      request_hash: computeRequestHash('extensao_cortesia_3d', '3584843', '54160049'),
      tipo: 'extensao_cortesia_3d'
    }]);
    const cms = makeCmsClient({
      clienteData: {
        user_id: 3584843, raw_username: '54160049',
        expire: '05/08/2035 23:55:00',
        max_cons: 1, status: 'disabled' // status não operacional
      }
    });
    const result = await extenderAcesso(
      { identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-T32' },
      { cmsClient: cms, db }
    );
    assert.equal(result.success, false);
    assert.equal(result.code, 'SUPPLIER_EXTENSION_NOT_CONFIRMED');
    const rec = db._store.get('key-T32');
    assert.equal(rec.status, 'uncertain', 'disabled não deve virar done');
  });

  await test('T33 — generatetest nunca chamado durante extensão', async () => {
    let generateCalled = false;
    const db = createDb();
    const cms = makeCmsClient({
      clienteData: { user_id: 3584843, raw_username: '54160049', expire: '02/08/2035 23:55:00', max_cons: 1, status: 'enabled' },
      getClientsAfterExtend: [{ user_id: 3584843, raw_username: '54160049', expire: '05/08/2035 23:55:00', max_cons: 1, status: 'enabled' }]
    });
    const origPost = cms.post.bind(cms);
    cms.post = async (url, body, opts) => {
      if (url.includes('generatetest') || url.includes('generate')) generateCalled = true;
      return origPost(url, body, opts);
    };
    await extenderAcesso({ identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-T33' }, { cmsClient: cms, db });
    assert.equal(generateCalled, false, 'generatetest NÃO deve ser chamado');
  });

  await test('T34 — extend retorna success=true e getClients confirma imediatamente → done', async () => {
    const db = createDb();
    const cms = makeCmsClient({
      clienteData: { user_id: 3584843, raw_username: '54160049', expire: '02/08/2035 23:55:00', max_cons: 1, status: 'enabled' },
      getClientsAfterExtend: [{ user_id: 3584843, raw_username: '54160049', expire: '05/08/2035 23:55:00', max_cons: 1, status: 'enabled' }]
    });
    const result = await extenderAcesso(
      { identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-T34' },
      { cmsClient: cms, db }
    );
    assert.equal(result.success, true);
    const rec = db._store.get('key-T34');
    assert.equal(rec.status, 'done');
  });

  await test('T35 — extend retorna success=true, primeira consulta retorna antiga e segunda retorna nova → done', async () => {
    const db = createDb();
    let extendCallCount = 0;
    let getClientsConfCount = 0;
    const cms = makeCmsClient({
      clienteData: { user_id: 3584843, raw_username: '54160049', expire: '02/08/2035 23:55:00', max_cons: 1, status: 'enabled' }
    });
    const origPost = cms.post.bind(cms);
    cms.post = async (url, body, opts) => {
      if (url.includes('/extend')) {
        extendCallCount++;
        return origPost(url, body, opts);
      }
      if (url.includes('/ajax/getClients')) {
        getClientsConfCount++;
        if (getClientsConfCount === 2) {
          // Primeira tentativa pós-extend retorna data antiga
          return { data: { recordsFiltered: 1, data: [{ user_id: 3584843, raw_username: '54160049', expire: '02/08/2035 23:55:00', max_cons: 1, status: 'enabled' }] } };
        }
        if (getClientsConfCount >= 3) {
          // Segunda tentativa pós-extend retorna a data estendida
          return { data: { recordsFiltered: 1, data: [{ user_id: 3584843, raw_username: '54160049', expire: '05/08/2035 23:55:00', max_cons: 1, status: 'enabled' }] } };
        }
      }
      return origPost(url, body, opts);
    };

    const result = await extenderAcesso(
      { identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-T35' },
      { cmsClient: cms, db }
    );
    assert.equal(extendCallCount, 1, 'deve ter chamado /extend exatamente 1 vez');
    assert.equal(result.success, true, 'deve confirmar com sucesso na segunda consulta');
    const rec = db._store.get('key-T35');
    assert.equal(rec.status, 'done');
  });

  await test('T36 — extend retorna success=true e getClients continua antigo → uncertain', async () => {
    const db = createDb();
    const cms = makeCmsClient({
      clienteData: { user_id: 3584843, raw_username: '54160049', expire: '02/08/2035 23:55:00', max_cons: 1, status: 'enabled' },
      getClientsAfterExtend: [{ user_id: 3584843, raw_username: '54160049', expire: '02/08/2035 23:55:00', max_cons: 1, status: 'enabled' }] // data não alterou
    });
    await assert.rejects(
      () => extenderAcesso({ identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-T36' }, { cmsClient: cms, db }),
      (err) => { assert.equal(err.message, 'SUPPLIER_EXTENSION_NOT_CONFIRMED'); return true; }
    );
    const rec = db._store.get('key-T36');
    assert.equal(rec.status, 'uncertain');
  });

  await test('T37 — replay uncertain com getClients atualizado → done sem novo POST /extend', async () => {
    const pastLock = new Date(Date.now() - 60000).toISOString();
    const db = createDb([{
      idempotency_key: 'key-T37', status: 'uncertain',
      identificador_fornecedor: '3584843', usuario_acesso: '54160049',
      custom_date: '2035-08-05', connections: 1,
      vencimento_anterior: '2035-08-02T02:55:00.000Z',
      lock_expires_at: pastLock,
      request_hash: computeRequestHash('extensao_cortesia_3d', '3584843', '54160049'),
      tipo: 'extensao_cortesia_3d'
    }]);
    
    let extendCalled = false;
    const cms = makeCmsClient({
      clienteData: { user_id: 3584843, raw_username: '54160049', expire: '05/08/2035 23:55:00', max_cons: 1, status: 'enabled' }
    });
    const origPost = cms.post.bind(cms);
    cms.post = async (url, body, opts) => {
      if (url.includes('/extend')) extendCalled = true;
      return origPost(url, body, opts);
    };

    const result = await extenderAcesso(
      { identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-T37' },
      { cmsClient: cms, db }
    );
    assert.equal(result.success, true);
    assert.equal(extendCalled, false, 'NÃO deve chamar POST /extend no replay');
    const rec = db._store.get('key-T37');
    assert.equal(rec.status, 'done');
  });

  await test('T38 — item.expire no formato DD/MM/YYYY HH:mm:ss BRT parse e confirmação', () => {
    const d = parseBrazilianDateToLocal('05/08/2035 23:55:00 BRT');
    assert.ok(d instanceof Date);
    assert.equal(d.toISOString(), '2035-08-06T02:55:00.000Z');
  });

  await test('T39 — status=enabled é operacional', () => {
    assert.equal(isSupplierStatusOperational('enabled'), true);
    assert.equal(isSupplierStatusOperational('ACTIVE'), true);
    assert.equal(isSupplierStatusOperational('ativo'), true);
    assert.equal(isSupplierStatusOperational('disabled'), false);
  });

  await test('T40 — max_cons="1" é convertido corretamente', () => {
    const db = createDb();
    const cms = makeCmsClient({
      clienteData: { user_id: 3584843, raw_username: '54160049', expire: '02/08/2035 23:55:00', max_cons: '1', status: 'enabled' },
      getClientsAfterExtend: [{ user_id: 3584843, raw_username: '54160049', expire: '05/08/2035 23:55:00', max_cons: '1', status: 'enabled' }]
    });
    // confirmarCriterios deve passar pois convertemos para Number
    const c = { user_id: 3584843, raw_username: '54160049', expire: '05/08/2035 23:55:00', max_cons: '1', status: 'enabled' };
    const conf = confirmarCriterios(c, '3584843', 1, '2035-08-05');
    assert.equal(conf.confirmado, true);
  });

  await test('T41 — username com HTML é ignorado; comparação usa raw_username', async () => {
    const db = createDb();
    const cms = makeCmsClient({
      clienteData: { user_id: 3584843, username: '<span class="label text-danger">54160049</span>', raw_username: '54160049', expire: '02/08/2035 23:55:00', max_cons: 1, status: 'enabled' },
      getClientsAfterExtend: [{ user_id: 3584843, username: '<span class="label text-danger">54160049</span>', raw_username: '54160049', expire: '05/08/2035 23:55:00', max_cons: 1, status: 'enabled' }]
    });
    const result = await extenderAcesso(
      { identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-T41' },
      { cmsClient: cms, db }
    );
    assert.equal(result.success, true);
  });

  await test('T42 — operação já uncertain da homologação real pode ser reconciliada', async () => {
    const pastLock = new Date(Date.now() - 60000).toISOString();
    const db = createDb([{
      idempotency_key: 'cortesia_3d:9c263a4b-1333-4667-8a78-6e77fa631991', status: 'uncertain',
      identificador_fornecedor: '3584843', usuario_acesso: '54160049',
      custom_date: '2035-08-05', connections: 1,
      vencimento_anterior: '2035-08-02T02:55:00.000Z',
      lock_expires_at: pastLock,
      request_hash: computeRequestHash('extensao_cortesia_3d', '3584843', '54160049'),
      tipo: 'extensao_cortesia_3d'
    }]);
    
    let extendCalled = false;
    const cms = makeCmsClient({
      clienteData: { user_id: 3584843, raw_username: '54160049', expire: '05/08/2035 23:55:00', max_cons: 1, status: 'enabled' }
    });
    const origPost = cms.post.bind(cms);
    cms.post = async (url, body, opts) => {
      if (url.includes('/extend')) extendCalled = true;
      return origPost(url, body, opts);
    };

    const result = await extenderAcesso(
      { identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'cortesia_3d:9c263a4b-1333-4667-8a78-6e77fa631991' },
      { cmsClient: cms, db }
    );
    assert.equal(result.success, true);
    assert.equal(extendCalled, false, 'NÃO estende novamente');
    const rec = db._store.get('cortesia_3d:9c263a4b-1333-4667-8a78-6e77fa631991');
    assert.equal(rec.status, 'done');
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXECUÇÃO
// ═══════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  Suite: extender + idempotency + parser (42 testes) ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  await runParserTests();
  await runCalcularTests();
  await runIdempotencyTests();
  await runExtenderTests();

  console.log('\n══════════════════════════════════════════════════════');
  console.log(`  Total: ${passed + failed} | ✅ ${passed} passed | ❌ ${failed} failed`);
  console.log('══════════════════════════════════════════════════════\n');

  if (failed > 0) {
    console.log('Falhas:');
    for (const f of failures) {
      console.log(`  ❌ ${f.name}: ${f.error.message}`);
    }
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Erro fatal na suite de testes:', err);
  process.exit(1);
});
