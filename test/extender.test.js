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

  function matchAll(records, eqs, lts, iss = []) {
    return records.filter(r => {
      for (const [f, v] of eqs) if (String(r[f]) !== String(v)) return false;
      for (const [f, v] of lts) if (!(new Date(r[f]) < new Date(v))) return false;
      for (const [f, v] of iss) {
        if (v === null && r[f] !== null && r[f] !== undefined) return false;
        if (v !== null && String(r[f]) !== String(v)) return false;
      }
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
        _iss: [],
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
        is(f, v) { b._iss.push([f, v]); return b; },

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
          const found = matchAll(all, b._eqs, b._lts, b._iss);
          if (b._withSingle) {
            if (found.length === 0) return { data: null, error: { code: 'PGRST116' } };
            return { data: found[0], error: null };
          }
          return { data: found, error: null };
        }
        if (b._op === 'update') {
          if (updateError) return { data: null, error: updateError };
          const all   = [...store.values()];
          const found = matchAll(all, b._eqs, b._lts, b._iss);
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

  await test('T29 — success=true mas getClients não confirma → uncertain (SUPPLIER_EXTENSION_UNCERTAIN)', async () => {
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
      (err) => { assert.equal(err.message, 'SUPPLIER_EXTENSION_UNCERTAIN'); return true; }
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
    assert.equal(result.code, 'SUPPLIER_EXTENSION_UNCERTAIN');
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


  await test('T35 — [1 GET] extend retorna success=true, única consulta stale → uncertain (reconciliar confirma no retry)', async () => {
    // Com a nova política de 1 GET síncrono: se GET retorna stale → uncertain imediato.
    // A confirmação final acontece via reconciliar() no retry com a mesma idempotency_key.
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
        // 1ª chamada: GET inicial (pré-extend). 2ª chamada: único GET pós-extend (stale)
        if (getClientsConfCount === 2) {
          return { data: { recordsFiltered: 1, data: [{ user_id: 3584843, raw_username: '54160049', expire: '02/08/2035 23:55:00', max_cons: 1, status: 'enabled' }] } };
        }
      }
      return origPost(url, body, opts);
    };

    await assert.rejects(
      () => extenderAcesso(
        { identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-T35' },
        { cmsClient: cms, db }
      ),
      (err) => { assert.equal(err.message, 'SUPPLIER_EXTENSION_UNCERTAIN'); return true; }
    );
    assert.equal(extendCallCount, 1, 'deve ter chamado /extend exatamente 1 vez');
    assert.equal(getClientsConfCount, 2, '2 GETs: 1 pré-extend + 1 único pós-extend');
    const rec = db._store.get('key-T35');
    assert.equal(rec.status, 'uncertain', 'GET stale único → uncertain, não done');
  });


  await test('T36 — extend retorna success=true e getClients continua antigo → uncertain', async () => {
    const db = createDb();
    const cms = makeCmsClient({
      clienteData: { user_id: 3584843, raw_username: '54160049', expire: '02/08/2035 23:55:00', max_cons: 1, status: 'enabled' },
      getClientsAfterExtend: [{ user_id: 3584843, raw_username: '54160049', expire: '02/08/2035 23:55:00', max_cons: 1, status: 'enabled' }] // data não alterou
    });
    await assert.rejects(
      () => extenderAcesso({ identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-T36' }, { cmsClient: cms, db }),
      (err) => { assert.equal(err.message, 'SUPPLIER_EXTENSION_UNCERTAIN'); return true; }
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

  await test('T43 — extend retorna JSON como string e getClients confirma imediatamente → done', async () => {
    const db = createDb();
    const cms = makeCmsClient({
      clienteData: { user_id: 3584843, raw_username: '54160049', expire: '02/08/2035 23:55:00', max_cons: 1, status: 'enabled' },
      getClientsAfterExtend: [{ user_id: 3584843, raw_username: '54160049', expire: '05/08/2035 23:55:00', max_cons: 1, status: 'enabled' }]
    });
    const origPost = cms.post.bind(cms);
    cms.post = async (url, body, opts) => {
      if (url.includes('/extend')) {
        return { status: 200, data: '{"success":true,"message":"Plano extendido com sucesso!"}' };
      }
      return origPost(url, body, opts);
    };
    const result = await extenderAcesso(
      { identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-T43' },
      { cmsClient: cms, db }
    );
    assert.equal(result.success, true);
    const rec = db._store.get('key-T43');
    assert.equal(rec.status, 'done');
    assert.equal(rec.erro_codigo, null);
    assert.equal(rec.erro_detalhe_sanitizado, null);
    assert.equal(rec.lock_expires_at, null);
    assert.equal(rec.resultado.evidence.supplierAccepted, true);
  });

  await test('T44 — extend retorna JSON como string com BOM e getClients confirma imediatamente → done', async () => {
    const db = createDb();
    const cms = makeCmsClient({
      clienteData: { user_id: 3584843, raw_username: '54160049', expire: '02/08/2035 23:55:00', max_cons: 1, status: 'enabled' },
      getClientsAfterExtend: [{ user_id: 3584843, raw_username: '54160049', expire: '05/08/2035 23:55:00', max_cons: 1, status: 'enabled' }]
    });
    const origPost = cms.post.bind(cms);
    cms.post = async (url, body, opts) => {
      if (url.includes('/extend')) {
        return { status: 200, data: '\uFEFF{"success":true,"message":"Plano com BOM!"}' };
      }
      return origPost(url, body, opts);
    };
    const result = await extenderAcesso(
      { identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-T44' },
      { cmsClient: cms, db }
    );
    assert.equal(result.success, true);
    const rec = db._store.get('key-T44');
    assert.equal(rec.status, 'done');
  });

  await test('T45 — extend retorna success=true mas getClients falha/timeout → uncertain com 202', async () => {
    const db = createDb();
    const cms = makeCmsClient({
      clienteData: { user_id: 3584843, raw_username: '54160049', expire: '02/08/2035 23:55:00', max_cons: 1, status: 'enabled' },
      getClientsAfterExtend: [] // causará falha na busca de confirmação
    });
    await assert.rejects(
      () => extenderAcesso(
        { identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-T45' },
        { cmsClient: cms, db }
      ),
      (err) => {
        assert.equal(err.message, 'SUPPLIER_EXTENSION_UNCERTAIN');
        assert.equal(err.status, 202);
        return true;
      }
    );
    const rec = db._store.get('key-T45');
    assert.equal(rec.status, 'uncertain');
    assert.equal(rec.erro_codigo, 'SUPPLIER_EXTENSION_UNCERTAIN');
  });

  await test('T46 — extend retorna 200 com success=false → failed com 502', async () => {
    const db = createDb();
    const cms = makeCmsClient();
    cms.post = async (url, body, opts) => {
      if (url.includes('/extend')) {
        return { status: 200, data: { success: false, message: 'Usuario não existe ou limite atingido' } };
      }
      if (url.includes('/ajax/getClients')) {
        return { data: { recordsFiltered: 1, data: [{ user_id: 3584843, raw_username: '54160049', expire: '02/08/2035 23:55:00', max_cons: 1, status: 'enabled' }] } };
      }
    };
    await assert.rejects(
      () => extenderAcesso(
        { identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-T46' },
        { cmsClient: cms, db }
      ),
      (err) => {
        assert.equal(err.message, 'SUPPLIER_EXTENSION_FAILED');
        assert.equal(err.status, 502);
        return true;
      }
    );
    const rec = db._store.get('key-T46');
    assert.equal(rec.status, 'failed');
    assert.equal(rec.erro_codigo, 'SUPPLIER_EXTENSION_FAILED');
  });

  await test('T47 — reconciliar uncertain que possuía erro histórico limpa campos de erro', async () => {
    const db = createDb([{
      idempotency_key: 'key-T47', status: 'uncertain',
      identificador_fornecedor: '3584843', usuario_acesso: '54160049',
      custom_date: '2035-08-05', connections: 1,
      vencimento_anterior: '2035-08-02T02:55:00.000Z',
      lock_expires_at: new Date(Date.now() - 60000).toISOString(),
      request_hash: computeRequestHash('extensao_cortesia_3d', '3584843', '54160049'),
      tipo: 'extensao_cortesia_3d',
      erro_codigo: 'SUPPLIER_EXTENSION_FAILED',
      erro_detalhe_sanitizado: 'Fornecedor retornou HTTP 200'
    }]);

    const cms = makeCmsClient({
      clienteData: { user_id: 3584843, raw_username: '54160049', expire: '05/08/2035 23:55:00', max_cons: 1, status: 'enabled' }
    });

    const result = await extenderAcesso(
      { identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-T47' },
      { cmsClient: cms, db }
    );
    assert.equal(result.success, true);
    const rec = db._store.get('key-T47');
    assert.equal(rec.status, 'done');
    assert.equal(rec.erro_codigo, null);
    assert.equal(rec.erro_detalhe_sanitizado, null);
    assert.equal(rec.lock_expires_at, null);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEÇÃO E — Recovery e Anti-Duplicação (TE-A a TE-J)
// ═══════════════════════════════════════════════════════════════════════════════
async function runRecoveryTests() {
  console.log('\n── Seção E: Recovery e Anti-Duplicação ──');

  // TE-A: success=true + GET confirma alvo → DONE, exatamente 1 POST
  await test('TE-A — success=true + GET confirma alvo → DONE, 1 POST total', async () => {
    let extendCalls = 0;
    const cms = makeCmsClient({
      clienteData:          { user_id: 3584843, raw_username: '54160049', expire: '02/08/2035 23:55:00', max_cons: 1, status: 'enabled' },
      getClientsAfterExtend: [{ user_id: 3584843, raw_username: '54160049', expire: '05/08/2035 23:55:00', max_cons: 1, status: 'enabled' }]
    });
    const origPost = cms.post.bind(cms);
    cms.post = async (url, body, opts) => { if (url.includes('/extend')) extendCalls++; return origPost(url, body, opts); };
    const db = createDb();
    const result = await extenderAcesso(
      { identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-TE-A' },
      { cmsClient: cms, db }
    );
    assert.equal(result.success, true, 'deve retornar success=true');
    assert.equal(extendCalls, 1, 'POST /extend deve ser chamado exatamente 1 vez');
    const rec = db._store.get('key-TE-A');
    assert.equal(rec.status, 'done');
  });

  // TE-B: success=true + GET stale → uncertain; 0 segundo POST imediato
  await test('TE-B — success=true + GET stale → uncertain; 0 segundo POST imediato', async () => {
    let extendCalls = 0;
    const cms = makeCmsClient({
      clienteData:          { user_id: 3584843, raw_username: '54160049', expire: '02/08/2035 23:55:00', max_cons: 1, status: 'enabled' },
      getClientsAfterExtend: [{ user_id: 3584843, raw_username: '54160049', expire: '02/08/2035 23:55:00', max_cons: 1, status: 'enabled' }]
    });
    const origPost = cms.post.bind(cms);
    cms.post = async (url, body, opts) => { if (url.includes('/extend')) extendCalls++; return origPost(url, body, opts); };
    const db = createDb();
    await assert.rejects(
      () => extenderAcesso({ identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-TE-B' }, { cmsClient: cms, db }),
      (err) => { assert.equal(err.message, 'SUPPLIER_EXTENSION_UNCERTAIN'); return true; }
    );
    assert.equal(extendCalls, 1, 'POST /extend chamado apenas 1 vez (sem segundo POST imediato)');
    const rec = db._store.get('key-TE-B');
    assert.equal(rec.status, 'uncertain');
  });

  // TE-C: uncertain + background GET confirma → DONE, 0 POST extra
  await test('TE-C — uncertain + background GET confirma (reconciliar) → DONE, 0 POST extra', async () => {
    const pastLock = new Date(Date.now() - 60000).toISOString();
    const db = createDb([{
      idempotency_key: 'key-TE-C', status: 'uncertain',
      identificador_fornecedor: '3584843', usuario_acesso: '54160049',
      custom_date: '2035-08-05', connections: 1,
      vencimento_anterior: '2035-08-02T02:55:00.000Z',
      lock_expires_at: pastLock,
      request_hash: computeRequestHash('extensao_cortesia_3d', '3584843', '54160049'),
      tipo: 'extensao_cortesia_3d'
    }]);
    let extendCalls = 0;
    const cms = makeCmsClient({
      clienteData: { user_id: 3584843, raw_username: '54160049', expire: '05/08/2035 23:55:00', max_cons: 1, status: 'enabled' }
    });
    const origPost = cms.post.bind(cms);
    cms.post = async (url, body, opts) => { if (url.includes('/extend')) extendCalls++; return origPost(url, body, opts); };
    const result = await extenderAcesso(
      { identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-TE-C' },
      { cmsClient: cms, db }
    );
    assert.equal(result.success, true, 'reconciliar deve confirmar → success=true');
    assert.equal(extendCalls, 0, 'reconciliar NUNCA chama /extend (0 POSTs adicionais)');
    const rec = db._store.get('key-TE-C');
    assert.equal(rec.status, 'done');
  });

  // TE-D: POST timeout + fornecedor aplicou → reconciliar GET confirma → DONE, 0 POST extra
  await test('TE-D — POST timeout + fornecedor aplicou → reconciliar GET confirma → DONE, 0 POST extra', async () => {
    // 1ª chamada: timeout no POST → uncertain
    // Mock padrão: expire='05/08/2035' → custom_date='08/08/2035' (expire + 3 dias)
    const db = createDb();
    const cmsTimeout = makeCmsClient({ networkErrorOnExtend: true });
    await assert.rejects(
      () => extenderAcesso({ identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-TE-D' }, { cmsClient: cmsTimeout, db }),
      (err) => { assert.equal(err.message, 'SUPPLIER_EXTENSION_UNCERTAIN'); return true; }
    );
    // Registrar a customDate que foi salva antes do timeout
    const opApos1 = db._store.get('key-TE-D');
    const customDateSalva = opApos1.custom_date;
    assert.ok(customDateSalva, 'customDate deve estar salva no banco após timeout');

    // 2ª chamada (reconciliação): fornecedor JÁ aplicou.
    // expire deve ser >= custom_date para que isDateOk=true.
    // custom_date = expire_original + 3 dias = '05/08/2035' + 3 = '08/08/2035'
    let extendCallsR = 0;
    const cmsReconcilia = makeCmsClient({
      clienteData: { user_id: 3584843, raw_username: '54160049', expire: '08/08/2035 23:55:00', max_cons: 1, status: 'enabled' }
    });
    const origPostR = cmsReconcilia.post.bind(cmsReconcilia);
    cmsReconcilia.post = async (url, body, opts) => { if (url.includes('/extend')) extendCallsR++; return origPostR(url, body, opts); };
    const result = await extenderAcesso(
      { identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-TE-D' },
      { cmsClient: cmsReconcilia, db }
    );
    assert.equal(result.success, true);
    assert.equal(extendCallsR, 0, 'reconciliar NUNCA chama /extend');
    const rec = db._store.get('key-TE-D');
    assert.equal(rec.status, 'done');
  });


  // TE-E: POST timeout + fornecedor não aplicou → retry usa MESMA customDate original
  await test('TE-E — POST timeout + fornecedor não aplicou → retry usa mesma customDate original (imutável)', async () => {
    // 1ª chamada: timeout → uncertain
    const db = createDb();
    await assert.rejects(
      () => extenderAcesso({ identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-TE-E' }, { cmsClient: makeCmsClient({ networkErrorOnExtend: true }), db }),
      (err) => { assert.equal(err.message, 'SUPPLIER_EXTENSION_UNCERTAIN'); return true; }
    );
    const customDateOriginal = db._store.get('key-TE-E').custom_date;
    assert.ok(customDateOriginal, 'customDate deve estar salva no banco');

    // 2ª chamada: reconciliar() com GET stale → retorna {success:false} (não lança exceção).
    // reconciliar() nunca faz novo POST; customDate não é recalculada.
    const cmsStale = makeCmsClient({
      clienteData: { user_id: 3584843, raw_username: '54160049', expire: '02/08/2035 23:55:00', max_cons: 1, status: 'enabled' }
    });
    const result2 = await extenderAcesso(
      { identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-TE-E' },
      { cmsClient: cmsStale, db }
    );
    assert.equal(result2.success, false, 'reconciliar com GET stale deve retornar success=false');
    assert.equal(result2.code, 'SUPPLIER_EXTENSION_UNCERTAIN');

    // A customDate no banco NUNCA muda entre tentativas
    const customDateApos2 = db._store.get('key-TE-E').custom_date;
    assert.equal(String(customDateApos2), String(customDateOriginal),
      'customDate deve ser idêntica à original após retry — nunca recalculada');
  });


  // TE-F: +3 uncertain → nunca vira +6
  await test('TE-F — +3 uncertain: reconciliar confirma exatamente +3, nunca +6', async () => {
    const pastLock = new Date(Date.now() - 60000).toISOString();
    const db = createDb([{
      idempotency_key: 'key-TE-F', status: 'uncertain',
      identificador_fornecedor: '3584843', usuario_acesso: '54160049',
      custom_date: '2035-08-05', connections: 1,  // +3 dias a partir de 02/08
      vencimento_anterior: '2035-08-02T02:55:00.000Z',
      lock_expires_at: pastLock,
      request_hash: computeRequestHash('extensao_cortesia_3d', '3584843', '54160049'),
      tipo: 'extensao_cortesia_3d'
    }]);
    let extendCalls = 0;
    const cms = makeCmsClient({
      clienteData: { user_id: 3584843, raw_username: '54160049', expire: '05/08/2035 23:55:00', max_cons: 1, status: 'enabled' }
    });
    const origPost = cms.post.bind(cms);
    cms.post = async (url, body, opts) => { if (url.includes('/extend')) extendCalls++; return origPost(url, body, opts); };
    const result = await extenderAcesso(
      { identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-TE-F', dias: 3 },
      { cmsClient: cms, db }
    );
    assert.equal(result.success, true);
    assert.equal(extendCalls, 0, '+3 uncertain: reconciliar NUNCA chama /extend (sem +6)');
    // Vencimento deve ser exatamente 05/08/2035, não 08/08/2035
    assert.ok(result.data.vencimento_atual.startsWith('2035-08-06'), // 05/08 23:55 BRT = 06/08 02:55 UTC
      `Vencimento deve ser 05/08 (~06T02:55Z), recebido: ${result.data.vencimento_atual}`);
    assert.equal(result.data.data_solicitada, '2035-08-05', 'data_solicitada deve ser a original +3');
  });

  // TE-G: +30 uncertain → nunca vira +60
  await test('TE-G — +30 uncertain: reconciliar confirma exatamente +30, nunca +60', async () => {
    const pastLock = new Date(Date.now() - 60000).toISOString();
    const db = createDb([{
      idempotency_key: 'key-TE-G', status: 'uncertain',
      identificador_fornecedor: '3584843', usuario_acesso: '54160049',
      custom_date: '2035-09-01', connections: 1,  // +30 dias a partir de 02/08
      vencimento_anterior: '2035-08-02T02:55:00.000Z',
      lock_expires_at: pastLock,
      request_hash: computeRequestHash('extensao_cortesia_3d', '3584843', '54160049'),
      tipo: 'extensao_cortesia_3d'
    }]);
    let extendCalls = 0;
    const cms = makeCmsClient({
      clienteData: { user_id: 3584843, raw_username: '54160049', expire: '01/09/2035 23:55:00', max_cons: 1, status: 'enabled' }
    });
    const origPost = cms.post.bind(cms);
    cms.post = async (url, body, opts) => { if (url.includes('/extend')) extendCalls++; return origPost(url, body, opts); };
    const result = await extenderAcesso(
      { identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-TE-G', dias: 30 },
      { cmsClient: cms, db }
    );
    assert.equal(result.success, true);
    assert.equal(extendCalls, 0, '+30 uncertain: reconciliar NUNCA chama /extend (sem +60)');
    // Vencimento deve ser 01/09/2035, não 01/10/2035
    assert.ok(result.data.vencimento_atual.startsWith('2035-09-02'), // 01/09 23:55 BRT = 02/09 02:55 UTC
      `Vencimento deve ser 01/09 (~02T02:55Z), recebido: ${result.data.vencimento_atual}`);
    assert.equal(result.data.data_solicitada, '2035-09-01', 'data_solicitada deve ser a original +30');
  });


  // TE-H: GET falha durante reconciliar() → 0 POST, mantém uncertain
  await test('TE-H — GET falha durante reconciliar() → 0 POST, mantém uncertain', async () => {
    const pastLock = new Date(Date.now() - 60000).toISOString();
    const db = createDb([{
      idempotency_key: 'key-TE-H', status: 'uncertain',
      identificador_fornecedor: '3584843', usuario_acesso: '54160049',
      custom_date: '2035-08-05', connections: 1,
      vencimento_anterior: '2035-08-02T02:55:00.000Z',
      lock_expires_at: pastLock,
      request_hash: computeRequestHash('extensao_cortesia_3d', '3584843', '54160049'),
      tipo: 'extensao_cortesia_3d'
    }]);
    // Sessão expirada → GET vai falhar (PANEL_SESSION_EXPIRED).
    // reconciliar() captura o erro internamente e retorna {success:false} sem lançar exceção.
    const cms = makeCmsClient({ sessionExpired: true });
    let extendCalls = 0;
    const origPost = cms.post.bind(cms);
    cms.post = async (url, body, opts) => { if (url.includes('/extend')) extendCalls++; return origPost(url, body, opts); };
    const result = await extenderAcesso(
      { identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-TE-H' },
      { cmsClient: cms, db }
    );
    assert.equal(result.success, false, 'GET falhou → success=false (sem lançar exceção)');
    assert.equal(result.code, 'SUPPLIER_EXTENSION_UNCERTAIN');
    assert.equal(extendCalls, 0, 'GET falhou → ZERO POST executado');
    const rec = db._store.get('key-TE-H');
    assert.equal(rec.status, 'uncertain', 'deve manter uncertain quando GET falha');
  });


  // TE-I: vencimento atual > alvo → DONE imediato, 0 POST extra
  await test('TE-I — vencimento atual > alvo → DONE imediato, sem regressão de data', async () => {
    let extendCalls = 0;
    const cms = makeCmsClient({
      clienteData:          { user_id: 3584843, raw_username: '54160049', expire: '02/08/2035 23:55:00', max_cons: 1, status: 'enabled' },
      // getClients na confirmação retorna data MUITO posterior ao customDate calculado
      getClientsAfterExtend: [{ user_id: 3584843, raw_username: '54160049', expire: '15/09/2035 23:55:00', max_cons: 1, status: 'enabled' }]
    });
    const origPost = cms.post.bind(cms);
    cms.post = async (url, body, opts) => { if (url.includes('/extend')) extendCalls++; return origPost(url, body, opts); };
    const db = createDb();
    const result = await extenderAcesso(
      { identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-TE-I', dias: 3 },
      { cmsClient: cms, db }
    );
    assert.equal(result.success, true, 'vencimento > alvo deve satisfazer confirmação');
    assert.equal(extendCalls, 1, 'apenas 1 POST inicial; nenhum extra');
    const rec = db._store.get('key-TE-I');
    assert.equal(rec.status, 'done', 'deve ser done — sem segundo POST nem regressão');
    // Vencimento retornado é o real (15/09), não uma data recalculada
    assert.ok(result.data.vencimento_atual.startsWith('2035-09-16'), // 15/09 23:55 BRT = 16/09 02:55 UTC
      `Vencimento deve refletir o real do painel (15/09), recebido: ${result.data.vencimento_atual}`);
  });

  // TE-J: acesso expirado — expirou ontem, hoje + dias=3 → customDate = hoje+3 (não expirado+3)
  await test('TE-J — acesso expirado: base=hoje (não vencimento expirado), dias=3 → customDate=hoje+3', async () => {
    const ontem = new Date(Date.now() - 24 * 3600 * 1000);
    const ontemStr = `${String(ontem.getDate()).padStart(2,'0')}/${String(ontem.getMonth()+1).padStart(2,'0')}/${ontem.getFullYear()} 23:55:00`;
    const hoje = new Date();
    const hojeStr = `${hoje.getFullYear()}-${String(hoje.getMonth()+1).padStart(2,'0')}-${String(hoje.getDate()).padStart(2,'0')}`;
    // +3 a partir de hoje
    const alvo = new Date(Date.now() + 3 * 24 * 3600 * 1000);
    const alvoStr = `${alvo.getFullYear()}-${String(alvo.getMonth()+1).padStart(2,'0')}-${String(alvo.getDate()).padStart(2,'0')}`;
    const alvoExpire = `${String(alvo.getDate()).padStart(2,'0')}/${String(alvo.getMonth()+1).padStart(2,'0')}/${alvo.getFullYear()} 23:55:00`;

    let capturedBody = null;
    const cms = makeCmsClient({
      clienteData:          { user_id: 3584843, raw_username: '54160049', expire: ontemStr, max_cons: 1, status: 'enabled' },
      getClientsAfterExtend: [{ user_id: 3584843, raw_username: '54160049', expire: alvoExpire, max_cons: 1, status: 'enabled' }]
    });
    const origPost = cms.post.bind(cms);
    cms.post = async (url, body, opts) => { if (url.includes('/extend')) capturedBody = body; return origPost(url, body, opts); };

    const db = createDb();
    const result = await extenderAcesso(
      { identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-TE-J', dias: 3 },
      { cmsClient: cms, db }
    );
    assert.ok(capturedBody, 'POST /extend deve ter sido chamado');
    assert.ok(capturedBody.includes(`customDate=${alvoStr}`),
      `customDate deve ser hoje+3 (${alvoStr}), não ontem+3. Body: ${capturedBody}`);
    assert.equal(result.success, true);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEÇÃO F — Motor Genérico de Recovery +3 / +30 (TF-1 a TF-8)
// ═══════════════════════════════════════════════════════════════════════════════
async function runGenericRecoveryTests() {
  console.log('\n── Seção F: Motor Genérico de Recovery (+3 e +30) ──');

  // TF-1: data_base persistida no banco antes do 1º POST
  await test('TF-1 — data_base persistida no DB antes do 1º POST', async () => {
    const db = createDb();
    const cms = makeCmsClient({
      clienteData:          { user_id: 3584843, raw_username: '54160049', expire: '02/08/2035 23:55:00', max_cons: 1, status: 'enabled' },
      getClientsAfterExtend: [{ user_id: 3584843, raw_username: '54160049', expire: '05/08/2035 23:55:00', max_cons: 1, status: 'enabled' }]
    });
    const result = await extenderAcesso(
      { identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-TF-1', dias: 3 },
      { cmsClient: cms, db }
    );
    assert.equal(result.success, true);
    const rec = db._store.get('key-TF-1');
    assert.ok(rec.data_base, 'data_base deve ser gravada no banco');
    assert.equal(result.data.data_base, rec.data_base, 'data_base retornada deve bater com a persistida no DB');
  });

  // TF-2: Chamadas durante janela temporal realizam apenas GET (0 POSTs extras)
  await test('TF-2 — Janela temporal no futuro: chamadas repetidas fazem apenas GET (0 POSTs extras)', async () => {
    let extendCalls = 0;
    const futuro = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min no futuro
    const db = createDb([{
      idempotency_key: 'key-TF-2', status: 'uncertain',
      identificador_fornecedor: '3584843', usuario_acesso: '54160049',
      custom_date: '2035-08-05', connections: 1,
      vencimento_anterior: '2035-08-02T02:55:00.000Z',
      data_base: '2035-08-02T02:55:00.000Z',
      retry_controlado_disponivel_em: futuro,
      retry_controlado_executado_em: null,
      request_hash: computeRequestHash('extensao_cortesia_3d', '3584843', '54160049'),
      tipo: 'extensao_cortesia_3d'
    }]);
    const cms = makeCmsClient({
      clienteData: { user_id: 3584843, raw_username: '54160049', expire: '02/08/2035 23:55:00', max_cons: 1, status: 'enabled' }
    });
    const origPost = cms.post.bind(cms);
    cms.post = async (url, body, opts) => { if (url.includes('/extend')) extendCalls++; return origPost(url, body, opts); };

    // Fazer 3 chamadas durante a janela
    await extenderAcesso({ identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-TF-2' }, { cmsClient: cms, db });
    await extenderAcesso({ identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-TF-2' }, { cmsClient: cms, db });
    await extenderAcesso({ identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-TF-2' }, { cmsClient: cms, db });

    assert.equal(extendCalls, 0, 'Zero POSTs durante a janela temporal passiva');
    const rec = db._store.get('key-TF-2');
    assert.equal(rec.retry_controlado_executado_em, null, 'retry_controlado_executado_em deve continuar NULL');
  });

  // TF-3: Retry controlado pós-janela envia exatamente a custom_date original
  await test('TF-3 — Retry controlado pós-janela: envia exatamente a custom_date original imutável', async () => {
    let capturedBody = null;
    let extendCalls = 0;
    const passado = new Date(Date.now() - 1000).toISOString();
    const db = createDb([{
      idempotency_key: 'key-TF-3', status: 'uncertain',
      identificador_fornecedor: '3584843', usuario_acesso: '54160049',
      custom_date: '2035-08-05', connections: 1,
      vencimento_anterior: '2035-08-02T02:55:00.000Z',
      data_base: '2035-08-02T02:55:00.000Z',
      retry_controlado_disponivel_em: passado,
      retry_controlado_executado_em: null,
      request_hash: computeRequestHash('extensao_cortesia_3d', '3584843', '54160049'),
      tipo: 'extensao_cortesia_3d'
    }]);
    const cms = makeCmsClient({
      clienteData: { user_id: 3584843, raw_username: '54160049', expire: '02/08/2035 23:55:00', max_cons: 1, status: 'enabled' },
      getClientsAfterExtend: [{ user_id: 3584843, raw_username: '54160049', expire: '05/08/2035 23:55:00', max_cons: 1, status: 'enabled' }]
    });
    const origPost = cms.post.bind(cms);
    cms.post = async (url, body, opts) => {
      if (url.includes('/extend')) { extendCalls++; capturedBody = body; }
      return origPost(url, body, opts);
    };

    const result = await extenderAcesso(
      { identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-TF-3' },
      { cmsClient: cms, db }
    );

    assert.equal(result.success, true);
    assert.equal(extendCalls, 1, 'Exatamente 1 POST de retry disparado');
    assert.ok(capturedBody.includes('customDate=2035-08-05'), 'POST de retry deve re-enviar customDate original');
    const rec = db._store.get('key-TF-3');
    assert.ok(rec.retry_controlado_executado_em, 'retry_controlado_executado_em deve ser preenchido');
  });

  // TF-4: Claim atômico de concorrência: apenas 1 worker dispara o POST
  await test('TF-4 — Concorrência: apenas 1 worker obtém claim; o segundo faz GET-only', async () => {
    let extendCalls = 0;
    const passado = new Date(Date.now() - 1000).toISOString();
    const db = createDb([{
      idempotency_key: 'key-TF-4', status: 'uncertain',
      identificador_fornecedor: '3584843', usuario_acesso: '54160049',
      custom_date: '2035-08-05', connections: 1,
      vencimento_anterior: '2035-08-02T02:55:00.000Z',
      data_base: '2035-08-02T02:55:00.000Z',
      retry_controlado_disponivel_em: passado,
      retry_controlado_executado_em: null,
      request_hash: computeRequestHash('extensao_cortesia_3d', '3584843', '54160049'),
      tipo: 'extensao_cortesia_3d'
    }]);
    const cms = makeCmsClient({
      clienteData: { user_id: 3584843, raw_username: '54160049', expire: '02/08/2035 23:55:00', max_cons: 1, status: 'enabled' },
      getClientsAfterExtend: [{ user_id: 3584843, raw_username: '54160049', expire: '05/08/2035 23:55:00', max_cons: 1, status: 'enabled' }]
    });
    const origPost = cms.post.bind(cms);
    cms.post = async (url, body, opts) => { if (url.includes('/extend')) extendCalls++; return origPost(url, body, opts); };

    // Executa 2 chamadas simultâneas (Workers 1 e 2)
    const [p1, p2] = await Promise.all([
      extenderAcesso({ identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-TF-4' }, { cmsClient: cms, db }),
      extenderAcesso({ identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-TF-4' }, { cmsClient: cms, db })
    ]);

    assert.equal(extendCalls, 1, 'Exatamente 1 worker dispara o POST do retry (claim atômico)');
    assert.equal(p1.success, true);
    assert.equal(p2.success, true);
  });

  // TF-5: Chamadas posteriores ao retry são permanentemente GET-only
  await test('TF-5 — Pós-retry executado: chamadas futuras são permanentemente GET-only', async () => {
    let extendCalls = 0;
    const passado = new Date(Date.now() - 1000).toISOString();
    const db = createDb([{
      idempotency_key: 'key-TF-5', status: 'uncertain',
      identificador_fornecedor: '3584843', usuario_acesso: '54160049',
      custom_date: '2035-08-05', connections: 1,
      vencimento_anterior: '2035-08-02T02:55:00.000Z',
      data_base: '2035-08-02T02:55:00.000Z',
      retry_controlado_disponivel_em: passado,
      retry_controlado_executado_em: passado, // Já foi executado!
      request_hash: computeRequestHash('extensao_cortesia_3d', '3584843', '54160049'),
      tipo: 'extensao_cortesia_3d'
    }]);
    const cms = makeCmsClient({
      clienteData: { user_id: 3584843, raw_username: '54160049', expire: '02/08/2035 23:55:00', max_cons: 1, status: 'enabled' }
    });
    const origPost = cms.post.bind(cms);
    cms.post = async (url, body, opts) => { if (url.includes('/extend')) extendCalls++; return origPost(url, body, opts); };

    const res = await extenderAcesso(
      { identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-TF-5' },
      { cmsClient: cms, db }
    );

    assert.equal(res.success, false, 'GET ainda stale → retorna success=false');
    assert.equal(extendCalls, 0, 'ZERO novos POSTs executados após retry_controlado_executado_em preenchido');
  });

  // TF-6: Motor genérico atende +30 (renovação mensal) com custom_date imutável
  await test('TF-6 — Renovação Mensal (+30): motor genérico confirma +30 com custom_date imutável', async () => {
    const db = createDb();
    let capturedBody = null;
    const cms = makeCmsClient({
      clienteData:          { user_id: 3584843, raw_username: '54160049', expire: '02/08/2035 23:55:00', max_cons: 1, status: 'enabled' },
      getClientsAfterExtend: [{ user_id: 3584843, raw_username: '54160049', expire: '01/09/2035 23:55:00', max_cons: 1, status: 'enabled' }]
    });
    const origPost = cms.post.bind(cms);
    cms.post = async (url, body, opts) => { if (url.includes('/extend')) capturedBody = body; return origPost(url, body, opts); };

    const result = await extenderAcesso(
      { identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'mp_mensal_renovacao:pay-1:54160049', dias: 30 },
      { cmsClient: cms, db }
    );

    assert.equal(result.success, true);
    assert.ok(capturedBody.includes('customDate=2035-09-01'), 'customDate para +30 deve ser +30 dias (2035-09-01)');
    const rec = db._store.get('mp_mensal_renovacao:pay-1:54160049');
    assert.equal(rec.status, 'done');
    assert.ok(rec.data_base, 'data_base deve estar salva');
  });

  // TF-7: Retry no +30 re-envia a custom_date original de 30 dias
  await test('TF-7 — Retry no +30: re-envia custom_date original de 30 dias (sem recalcular)', async () => {
    let capturedBody = null;
    const passado = new Date(Date.now() - 1000).toISOString();
    const db = createDb([{
      idempotency_key: 'mp_mensal_renovacao:pay-2:54160049', status: 'uncertain',
      identificador_fornecedor: '3584843', usuario_acesso: '54160049',
      custom_date: '2035-09-01', connections: 1, // +30 original
      vencimento_anterior: '2035-08-02T02:55:00.000Z',
      data_base: '2035-08-02T02:55:00.000Z',
      retry_controlado_disponivel_em: passado,
      retry_controlado_executado_em: null,
      request_hash: computeRequestHash('extensao_cortesia_3d', '3584843', '54160049'),
      tipo: 'extensao_cortesia_3d'
    }]);
    const cms = makeCmsClient({
      clienteData: { user_id: 3584843, raw_username: '54160049', expire: '02/08/2035 23:55:00', max_cons: 1, status: 'enabled' },
      getClientsAfterExtend: [{ user_id: 3584843, raw_username: '54160049', expire: '01/09/2035 23:55:00', max_cons: 1, status: 'enabled' }]
    });
    const origPost = cms.post.bind(cms);
    cms.post = async (url, body, opts) => { if (url.includes('/extend')) capturedBody = body; return origPost(url, body, opts); };

    const result = await extenderAcesso(
      { identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'mp_mensal_renovacao:pay-2:54160049', dias: 30 },
      { cmsClient: cms, db }
    );

    assert.equal(result.success, true);
    assert.ok(capturedBody.includes('customDate=2035-09-01'), 'POST de retry do +30 deve usar a customDate original 2035-09-01');
  });

  // TF-8: Invariante de anti-duplicação: Jamais ocorre +6 no +3 nem +60 no +30
  await test('TF-8 — Anti-Duplicação: Vencimento final retornado é estritamente o customDate alvo original', async () => {
    const passado = new Date(Date.now() - 1000).toISOString();
    const db = createDb([{
      idempotency_key: 'key-TF-8', status: 'uncertain',
      identificador_fornecedor: '3584843', usuario_acesso: '54160049',
      custom_date: '2035-08-05', connections: 1, // +3
      vencimento_anterior: '2035-08-02T02:55:00.000Z',
      data_base: '2035-08-02T02:55:00.000Z',
      retry_controlado_disponivel_em: passado,
      retry_controlado_executado_em: null,
      request_hash: computeRequestHash('extensao_cortesia_3d', '3584843', '54160049'),
      tipo: 'extensao_cortesia_3d'
    }]);
    const cms = makeCmsClient({
      clienteData: { user_id: 3584843, raw_username: '54160049', expire: '02/08/2035 23:55:00', max_cons: 1, status: 'enabled' },
      getClientsAfterExtend: [{ user_id: 3584843, raw_username: '54160049', expire: '05/08/2035 23:55:00', max_cons: 1, status: 'enabled' }]
    });

    const result = await extenderAcesso(
      { identificador_fornecedor: '3584843', usuario_acesso: '54160049', idempotency_key: 'key-TF-8', dias: 3 },
      { cmsClient: cms, db }
    );

    assert.equal(result.success, true);
    // Vencimento retornado DEVE ser exatamente 05/08/2035 (~06T02:55Z), NUNCA +6 (08/08)
    assert.ok(result.data.vencimento_atual.startsWith('2035-08-06'), `Vencimento retornado: ${result.data.vencimento_atual}`);
    assert.equal(result.data.data_solicitada, '2035-08-05');
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXECUÇÃO
// ═══════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  Suite: extender + idempotency + parser (65 testes) ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  await runParserTests();
  await runCalcularTests();
  await runIdempotencyTests();
  await runExtenderTests();
  await runRecoveryTests();
  await runGenericRecoveryTests();

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

