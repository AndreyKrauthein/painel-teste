/**
 * test/server.test.js
 * Testes de regressão na borda HTTP para rotas do Fastify (server.js).
 * Valida o recebimento e repasse correto de parâmetros via Fastify inject.
 */

// Configura variáveis para que supabaseAdmin instancie o client que interceptaremos
process.env.SUPABASE_URL = 'https://mock.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock_key';
process.env.API_SECRET = 'cc_integration_secret';
process.env.RATE_LIMIT_MAX = '1000';

import assert from 'node:assert/strict';
import { CookieJar } from 'tough-cookie';
import fs from 'node:fs';
import path from 'node:path';

// Prepara data/session.json dummy para inicialização do Fastify
const jar = new CookieJar();
fs.mkdirSync(path.resolve('data'), { recursive: true });
fs.writeFileSync(
  path.resolve('data/session.json'),
  JSON.stringify({
    cookieString: 'mundogf_session=mocksession; XSRF-TOKEN=mockxsrf',
    jar: jar.toJSON(),
    updatedAt: new Date().toISOString()
  }),
  'utf-8'
);

// Importa supabaseAdmin antes de ativar NODE_ENV=test para que o singleton seja instanciado
const supabaseAdmin = (await import('../src/supabaseAdmin.js')).default;
process.env.NODE_ENV = 'test';

// Importa cmsClient e server
const cmsClient = (await import('../src/cmsClient.js')).default;
const { fastify } = await import('../server.js');

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}: ${err.message}`);
    failures.push({ name, error: err });
    failed++;
  }
}

/**
 * Cria um mock in-memory para o Supabase Admin
 */
function createMockSupabase() {
  const store = new Map();

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

  const mockDb = {
    _store: store,
    from(table) {
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
        const data = b._insertData;
        const key = data.idempotency_key;
        if (store.has(key)) {
          return { data: null, error: { code: '23505', message: 'duplicate key' } };
        }
        const rec = { ...data, created_at: new Date().toISOString() };
        store.set(key, rec);
        return { data: [rec], error: null };
      }

      function exec() {
        if (b._op === 'select') {
          const recs = matchAll([...store.values()], b._eqs, b._lts);
          if (b._withSingle) {
            return { data: recs[0] || null, error: recs[0] ? null : { code: 'PGRST116', message: 'not found' } };
          }
          return { data: recs, error: null };
        }

        if (b._op === 'update') {
          const recs = matchAll([...store.values()], b._eqs, b._lts);
          if (recs.length === 0) {
            return { data: b._withSelect ? [] : null, error: null, count: 0 };
          }
          for (const r of recs) {
            const updated = { ...r, ...b._updateData };
            store.set(r.idempotency_key, updated);
          }
          if (b._withSelect && b._withSingle) {
            return { data: store.get(recs[0].idempotency_key), error: null };
          }
          return { data: b._withSelect ? recs.map(r => store.get(r.idempotency_key)) : null, error: null };
        }

        return { data: null, error: null };
      }

      return b;
    }
  };

  return mockDb;
}

async function runAll() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  Suite: HTTP Boundary Regression Tests (server.js)   ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  // Configura mock do Supabase no supabaseAdmin
  const mockDb = createMockSupabase();
  supabaseAdmin.from = mockDb.from;

  const mockCsrfHtml = '<input name="_token" value="mock-token-simpletest">';
  const mockExtendHtml = '<input name="_token" value="mock-token-extend">';

  // 1. Cenário connections = 2
  await test('HTTP_BOUNDARY_CONNECTIONS_2 — POST /acessos/estender repassa connections: 2', async () => {
    let capturedExtendPost = null;

    cmsClient.get = async (url) => {
      if (url === '/clients/simpletest') {
        return { status: 200, data: mockCsrfHtml };
      }
      if (url.includes('/extend')) {
        return { status: 200, data: mockExtendHtml };
      }
      return { status: 200, data: '' };
    };

    let clientMaxCons = 1;
    cmsClient.post = async (url, data, config) => {
      if (url === '/ajax/getClients') {
        return {
          status: 200,
          data: {
            recordsFiltered: 1,
            data: [{
              user_id: 12345,
              raw_username: 'user_test_conn_2',
              username: 'user_test_conn_2',
              status: 'enabled',
              expire: '13/08/2035 23:22:10',
              max_cons: clientMaxCons
            }]
          }
        };
      }
      if (url === '/clients/12345/extend') {
        const params = new URLSearchParams(data);
        capturedExtendPost = {
          url,
          option: params.get('option'),
          customDate: params.get('customDate'),
          connections: params.get('connections'),
          token: params.get('_token'),
          headers: config?.headers
        };
        // Simula atualização no Rboys para 2 conexões após o POST
        clientMaxCons = 2;
        return {
          status: 200,
          data: { success: true, message: 'Client extended successfully' }
        };
      }
      return { status: 200, data: { success: true } };
    };

    const res = await fastify.inject({
      method: 'POST',
      url: '/acessos/estender',
      headers: {
        'authorization': 'Bearer cc_integration_secret',
        'content-type': 'application/json'
      },
      payload: {
        identificador_fornecedor: '12345',
        usuario_acesso: 'user_test_conn_2',
        idempotency_key: 'http_boundary_test_conn_2',
        tipo: 'connections_only',
        connections: 2
      }
    });

    assert.equal(res.statusCode, 200, 'HTTP status deve ser 200');
    const body = JSON.parse(res.body);
    assert.equal(body.success, true, 'Resposta deve ter success: true');
    assert.equal(body.data.connections, 2, 'extenderAcesso deve retornar connections: 2');

    // Asserção fundamental na borda e no repasse:
    assert.ok(capturedExtendPost !== null, 'POST /clients/12345/extend deve ter sido chamado');
    assert.equal(capturedExtendPost.option, 'add_screens', 'option deve ser add_screens');
    assert.equal(capturedExtendPost.connections, '2', 'POST /extend deve receber connections="2"');
    assert.equal(capturedExtendPost.customDate, '', 'customDate deve ser vazio para add_screens');
  });

  // 2. Cenário connections = 3
  await test('HTTP_BOUNDARY_CONNECTIONS_3 — POST /acessos/estender repassa connections: 3', async () => {
    let capturedExtendPost = null;

    cmsClient.get = async (url) => {
      if (url === '/clients/simpletest') {
        return { status: 200, data: mockCsrfHtml };
      }
      if (url.includes('/extend')) {
        return { status: 200, data: mockExtendHtml };
      }
      return { status: 200, data: '' };
    };

    let clientMaxCons = 1;
    cmsClient.post = async (url, data, config) => {
      if (url === '/ajax/getClients') {
        return {
          status: 200,
          data: {
            recordsFiltered: 1,
            data: [{
              user_id: 12345,
              raw_username: 'user_test_conn_3',
              username: 'user_test_conn_3',
              status: 'enabled',
              expire: '13/08/2035 23:22:10',
              max_cons: clientMaxCons
            }]
          }
        };
      }
      if (url === '/clients/12345/extend') {
        const params = new URLSearchParams(data);
        capturedExtendPost = {
          url,
          option: params.get('option'),
          customDate: params.get('customDate'),
          connections: params.get('connections'),
          token: params.get('_token'),
          headers: config?.headers
        };
        clientMaxCons = 3;
        return {
          status: 200,
          data: { success: true, message: 'Client extended successfully' }
        };
      }
      return { status: 200, data: { success: true } };
    };

    const res = await fastify.inject({
      method: 'POST',
      url: '/acessos/estender',
      headers: {
        'authorization': 'Bearer cc_integration_secret',
        'content-type': 'application/json'
      },
      payload: {
        identificador_fornecedor: '12345',
        usuario_acesso: 'user_test_conn_3',
        idempotency_key: 'http_boundary_test_conn_3',
        tipo: 'connections_only',
        connections: 3
      }
    });

    assert.equal(res.statusCode, 200, 'HTTP status deve ser 200');
    const body = JSON.parse(res.body);
    assert.equal(body.success, true, 'Resposta deve ter success: true');
    assert.equal(body.data.connections, 3, 'extenderAcesso deve retornar connections: 3');

    assert.ok(capturedExtendPost !== null, 'POST /clients/12345/extend deve ter sido chamado');
    assert.equal(capturedExtendPost.option, 'add_screens', 'option deve ser add_screens');
    assert.equal(capturedExtendPost.connections, '3', 'POST /extend deve receber connections="3"');
  });

  // 3. Compatibilidade: Chamada sem connections (ex: renovação mensal)
  await test('HTTP_BOUNDARY_COMPATIBILITY — POST /acessos/estender sem connections preserva fallback', async () => {
    let capturedExtendPost = null;

    cmsClient.get = async (url) => {
      if (url === '/clients/simpletest') {
        return { status: 200, data: mockCsrfHtml };
      }
      if (url.includes('/extend')) {
        return { status: 200, data: mockExtendHtml };
      }
      return { status: 200, data: '' };
    };

    let clientExpire = '13/08/2026 23:22:10';
    cmsClient.post = async (url, data, config) => {
      if (url === '/ajax/getClients') {
        return {
          status: 200,
          data: {
            recordsFiltered: 1,
            data: [{
              user_id: 12345,
              raw_username: 'user_test_monthly',
              username: 'user_test_monthly',
              status: 'enabled',
              expire: clientExpire,
              max_cons: 1
            }]
          }
        };
      }
      if (url === '/clients/12345/extend') {
        const params = new URLSearchParams(data);
        capturedExtendPost = {
          url,
          option: params.get('option'),
          customDate: params.get('customDate'),
          connections: params.get('connections'),
          token: params.get('_token'),
          headers: config?.headers
        };
        // Para 13/08/2026 + 1 mês civil nativo (+31d), o novo expire é 14/09/2026
        clientExpire = '14/09/2026 23:22:10';
        return {
          status: 200,
          data: { success: true, message: 'Client extended successfully' }
        };
      }
      return { status: 200, data: { success: true } };
    };

    const res = await fastify.inject({
      method: 'POST',
      url: '/acessos/estender',
      headers: {
        'authorization': 'Bearer cc_integration_secret',
        'content-type': 'application/json'
      },
      payload: {
        identificador_fornecedor: '12345',
        usuario_acesso: 'user_test_monthly',
        idempotency_key: 'http_boundary_test_monthly_compat',
        tipo: 'mensalidade'
        // connections intencionalmente omitido
      }
    });

    assert.equal(res.statusCode, 200, 'HTTP status deve ser 200');
    const body = JSON.parse(res.body);
    assert.equal(body.success, true, 'Resposta deve ter success: true');
    assert.equal(body.data.connections, 1, 'Deve usar fallback max_cons=1');

    assert.ok(capturedExtendPost !== null, 'POST /clients/12345/extend deve ter sido chamado');
    assert.equal(capturedExtendPost.option, '92', 'option deve ser 92 para mensalidade');
    assert.equal(capturedExtendPost.connections, '1', 'POST /extend deve receber fallback connections="1"');
    assert.equal(capturedExtendPost.customDate, '', 'customDate deve ser vazio para option 92');
  });

  // 4. Validação de campos obrigatórios
  await test('HTTP_BOUNDARY_VALIDATION — Campos obrigatórios ausentes retornam HTTP 400 INVALID_REQUEST', async () => {
    const res = await fastify.inject({
      method: 'POST',
      url: '/acessos/estender',
      headers: {
        'authorization': 'Bearer cc_integration_secret',
        'content-type': 'application/json'
      },
      payload: {
        identificador_fornecedor: '12345'
        // usuario_acesso e idempotency_key ausentes
      }
    });

    assert.equal(res.statusCode, 400, 'HTTP status deve ser 400');
    const body = JSON.parse(res.body);
    assert.equal(body.success, false);
    assert.equal(body.error, 'INVALID_REQUEST');
  });

  // 5. Validação de autenticação
  await test('HTTP_BOUNDARY_AUTH — Requisição sem Bearer token retorna HTTP 401', async () => {
    const res = await fastify.inject({
      method: 'POST',
      url: '/acessos/estender',
      headers: {
        'content-type': 'application/json'
      },
      payload: {
        identificador_fornecedor: '12345',
        usuario_acesso: 'user_test',
        idempotency_key: 'http_test_no_auth'
      }
    });

    assert.equal(res.statusCode, 401, 'HTTP status deve ser 401');
    const body = JSON.parse(res.body);
    assert.equal(body.success, false);
  });

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
  process.exit(0);
}

runAll().catch(err => {
  console.error('Erro fatal na suite server.test.js:', err);
  process.exit(1);
});
