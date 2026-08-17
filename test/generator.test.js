import assert from 'node:assert/strict';
import { gerarAcesso } from '../src/generator.js';
import { computeRequestHash } from '../src/idempotency.js';

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

function createMockSupabase(initialStore = {}) {
  const store = new Map(Object.entries(initialStore));

  const mockDb = {
    _store: store,
    from(table) {
      const b = {
        _op: null,
        _insertData: null,
        _updateData: null,
        _eqs: [],
        insert(data) {
          b._op = 'insert';
          b._insertData = Array.isArray(data) ? data : [data];
          return b;
        },
        update(data) {
          b._op = 'update';
          b._updateData = data;
          return b;
        },
        select(cols) {
          return b;
        },
        eq(col, val) {
          b._eqs.push([col, val]);
          return b;
        },
        single() {
          return b._execute(true);
        },
        then(resolve, reject) {
          return b._execute(false).then(resolve, reject);
        },
        async _execute(isSingle) {
          if (b._op === 'insert') {
            for (const row of b._insertData) {
              const key = row.idempotency_key;
              if (store.has(key)) {
                return { data: null, error: { code: '23505', message: 'duplicate key' } };
              }
              const rec = { ...row, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
              store.set(key, rec);
            }
            return { data: b._insertData, error: null };
          }
          if (b._op === 'update') {
            let matched = [];
            for (const [k, rec] of store.entries()) {
              let match = true;
              for (const [col, val] of b._eqs) {
                if (String(rec[col]) !== String(val)) {
                  match = false;
                  break;
                }
              }
              if (match) {
                Object.assign(rec, b._updateData, { updated_at: new Date().toISOString() });
                matched.push(rec);
              }
            }
            return { data: isSingle ? (matched[0] || null) : matched, error: null };
          }
          // SELECT
          let matched = [];
          for (const [k, rec] of store.entries()) {
            let match = true;
            for (const [col, val] of b._eqs) {
              if (String(rec[col]) !== String(val)) {
                match = false;
                break;
              }
            }
            if (match) matched.push(rec);
          }
          if (isSingle && matched.length === 0) {
            return { data: null, error: { code: 'PGRST116', message: 'not found' } };
          }
          return { data: isSingle ? matched[0] : matched, error: null };
        }
      };
      return b;
    }
  };

  return mockDb;
}

const mockGenerateHtml = (user, pass) => `
  <div>
    <p>Usuário: ${user}</p>
    <p>Senha: ${pass}</p>
    <p>Vencimento: 15/08/2026 23:59:59</p>
    <a href="http://servidor.com/get.php?username=${user}&password=${pass}&type=m3u_plus&output=ts">Download</a>
  </div>
`;

console.log('\n--- INICIANDO TESTES DO GENERATOR (painel-teste) ---');

// ─── TESTE A: NORMAL CREATE ──────────────────────────────────────────────────
await test('TESTE A: Normal Create gera 1 create no RBoys e persiste DONE antes de responder', async () => {
  const db = createMockSupabase();
  let generatetestCalls = 0;

  const mockCmsClient = {
    get: async (url) => {
      if (url === '/clients/simpletest') {
        return { data: '<input name="_token" value="csrf123">' };
      }
      throw new Error(`Unhandled GET ${url}`);
    },
    post: async (url, data) => {
      if (url === '/clients/generatetest') {
        generatetestCalls++;
        return {
          request: { res: { responseUrl: '/clients/generatetest' } },
          data: mockGenerateHtml('user_test_1', 'pass_123')
        };
      }
      if (url === '/ajax/getClients') {
        return {
          data: {
            data: [{ user_id: '9988', raw_username: 'user_test_1', expire: '15/08/2026 23:59:59', max_cons: 1 }]
          }
        };
      }
      throw new Error(`Unhandled POST ${url}`);
    }
  };

  const key = 'criacao_inicial:user1:disp1';
  const result = await gerarAcesso({
    telefone: '11999998888',
    notes: 'Central Cine | User: user1 | Dispositivo: disp1',
    idempotency_key: key,
    dispositivo_id: 'disp1',
    usuario_id: 'user1'
  }, { cmsClient: mockCmsClient, db });

  assert.equal(result.success, true);
  assert.equal(result.cached, false);
  assert.equal(result.data.usuario, 'user_test_1');
  assert.equal(result.data.senha, 'pass_123');
  assert.equal(result.data.identificador_fornecedor, '9988');
  assert.equal(generatetestCalls, 1, 'Deve executar exatamente 1 POST /clients/generatetest');

  // Verificar persistência no DB
  const op = db._store.get(key);
  assert.ok(op, 'Operação deve estar persistida no DB');
  assert.equal(op.status, 'done', 'Status deve ser persistido como done');
  assert.equal(op.resultado.usuario, 'user_test_1');
  assert.equal(op.resultado.senha, 'pass_123');
});

// ─── TESTE B: DONE REPLAY ────────────────────────────────────────────────────
await test('TESTE B: Done Replay retorna cached: true com 0 chamadas adicionais ao RBoys em 10 retries', async () => {
  const db = createMockSupabase();
  let generatetestCalls = 0;

  const mockCmsClient = {
    get: async () => ({ data: '<input name="_token" value="csrf123">' }),
    post: async (url) => {
      if (url === '/clients/generatetest') {
        generatetestCalls++;
        return {
          request: { res: { responseUrl: '/clients/generatetest' } },
          data: mockGenerateHtml('user_test_1', 'pass_123')
        };
      }
      if (url === '/ajax/getClients') {
        return { data: { data: [{ user_id: '9988', raw_username: 'user_test_1', expire: '15/08/2026 23:59:59', max_cons: 1 }] } };
      }
    }
  };

  const key = 'criacao_inicial:user1:disp1';

  // 1ª chamada (Normal Create)
  await gerarAcesso({
    telefone: '11999998888',
    notes: 'Central Cine | User: user1 | Dispositivo: disp1',
    idempotency_key: key,
    dispositivo_id: 'disp1',
    usuario_id: 'user1'
  }, { cmsClient: mockCmsClient, db });

  assert.equal(generatetestCalls, 1);

  // 10 retries subsequentes
  for (let i = 0; i < 10; i++) {
    const replayRes = await gerarAcesso({
      telefone: '11999998888',
      notes: 'Central Cine | User: user1 | Dispositivo: disp1',
      idempotency_key: key,
      dispositivo_id: 'disp1',
      usuario_id: 'user1'
    }, { cmsClient: mockCmsClient, db });

    assert.equal(replayRes.success, true);
    assert.equal(replayRes.cached, true, 'Deve retornar cached: true');
    assert.equal(replayRes.data.usuario, 'user_test_1');
  }

  assert.equal(generatetestCalls, 1, 'DONE_REPLAY_RBOYS_CREATE_CALLS deve ser rigorosamente 0 após o primeiro create');
});

// ─── TESTE C: IDEMPOTENCY IN PROGRESS ─────────────────────────────────────────
await test('TESTE C: Lock ativo de supplier_call_started retorna HTTP 409 IDEMPOTENCY_IN_PROGRESS', async () => {
  const key = 'criacao_inicial:user1:disp1';
  const db = createMockSupabase({
    [key]: {
      idempotency_key: key,
      tipo: 'criacao_teste_inicial',
      identificador_fornecedor: 'disp1',
      usuario_acesso: '11999998888',
      request_hash: computeRequestHash('criacao_teste_inicial', 'disp1', '11999998888'),
      status: 'supplier_call_started',
      lock_expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString() // Lock válido por mais 5 min
    }
  });

  let calls = 0;
  const mockCmsClient = {
    get: async () => { calls++; return {}; },
    post: async () => { calls++; return {}; }
  };

  await assert.rejects(
    async () => {
      await gerarAcesso({
        telefone: '11999998888',
        notes: 'Central Cine | User: user1 | Dispositivo: disp1',
        idempotency_key: key,
        dispositivo_id: 'disp1'
      }, { cmsClient: mockCmsClient, db });
    },
    (err) => {
      assert.equal(err.message, 'IDEMPOTENCY_IN_PROGRESS');
      assert.equal(err.status, 409);
      return true;
    }
  );

  assert.equal(calls, 0, 'Zero chamadas ao RBoys quando lock está ativo');
});

// ─── TESTE D: SESSION INVALID BEFORE CREATE (failed_before_call) ─────────────
await test('TESTE D: Falha de sessão antes de generatetest marca failed_before_call sem tocar no create', async () => {
  const db = createMockSupabase();
  const key = 'criacao_inicial:user1:disp1';

  let generatetestCalls = 0;
  const mockCmsClient = {
    get: async () => {
      return { request: { res: { responseUrl: 'http://rboys.com/login' } }, status: 401, data: '' };
    },
    post: async () => {
      generatetestCalls++;
      return {};
    }
  };

  await assert.rejects(
    async () => {
      await gerarAcesso({
        telefone: '11999998888',
        notes: 'Central Cine | User: user1 | Dispositivo: disp1',
        idempotency_key: key,
        dispositivo_id: 'disp1'
      }, { cmsClient: mockCmsClient, db });
    },
    (err) => {
      assert.equal(err.message, 'PANEL_SESSION_EXPIRED');
      return true;
    }
  );

  assert.equal(generatetestCalls, 0, 'Zero chamadas a generatetest em falha pré-I/O');
  const op = db._store.get(key);
  assert.equal(op.status, 'failed_before_call', 'Deve ser classificado como failed_before_call');
});

// ─── TESTE E: TIMEOUT POST-DISPATCH (uncertain) ──────────────────────────────
await test('TESTE E: Timeout durante generatetest marca UNCERTAIN', async () => {
  const db = createMockSupabase();
  const key = 'criacao_inicial:user1:disp1';

  const mockCmsClient = {
    get: async () => ({ data: '<input name="_token" value="csrf123">' }),
    post: async (url) => {
      if (url === '/clients/generatetest') {
        throw new Error('connect ETIMEDOUT');
      }
    }
  };

  await assert.rejects(
    async () => {
      await gerarAcesso({
        telefone: '11999998888',
        notes: 'Central Cine | User: user1 | Dispositivo: disp1',
        idempotency_key: key,
        dispositivo_id: 'disp1'
      }, { cmsClient: mockCmsClient, db });
    },
    (err) => {
      assert.equal(err.message, 'GENERATION_TIMEOUT');
      assert.equal(err.status, 504);
      return true;
    }
  );

  const op = db._store.get(key);
  assert.equal(op.status, 'uncertain', 'Deve ser classificado como uncertain após timeout');
  assert.equal(op.erro_codigo, 'GENERATION_TIMEOUT');
});

// ─── TESTE F: UNCERTAIN + CONTA ENCONTRADA (ZERO DUPLICAÇÃO) ─────────────────
await test('TESTE F: Uncertain com conta encontrada no RBoys BLOQUEIA nova criação (AMBIGUOUS_CREATION_PASSWORD_UNAVAILABLE)', async () => {
  const key = 'criacao_inicial:user1:disp1';
  const notesMarker = 'Central Cine | User: user1 | Dispositivo: disp1';

  const db = createMockSupabase({
    [key]: {
      idempotency_key: key,
      tipo: 'criacao_teste_inicial',
      identificador_fornecedor: 'disp1',
      usuario_acesso: '11999998888',
      request_hash: computeRequestHash('criacao_teste_inicial', 'disp1', '11999998888'),
      status: 'uncertain',
      lock_expires_at: null,
      resultado: null
    }
  });

  let generatetestCalls = 0;
  const mockCmsClient = {
    get: async () => ({ data: '<input name="_token" value="csrf123">' }),
    post: async (url) => {
      if (url === '/clients/generatetest') {
        generatetestCalls++;
        return {};
      }
      if (url === '/ajax/getClients') {
        return {
          data: {
            data: [{
              user_id: '554433',
              raw_username: '47797267',
              notes: notesMarker,
              expire: '15/08/2026 23:59:59',
              max_cons: 1
            }]
          }
        };
      }
    }
  };

  await assert.rejects(
    async () => {
      await gerarAcesso({
        telefone: '11999998888',
        notes: notesMarker,
        idempotency_key: key,
        dispositivo_id: 'disp1'
      }, { cmsClient: mockCmsClient, db });
    },
    (err) => {
      assert.equal(err.message, 'AMBIGUOUS_CREATION_PASSWORD_UNAVAILABLE');
      assert.equal(err.status, 409);
      return true;
    }
  );

  assert.equal(generatetestCalls, 0, 'SECOND_ACCOUNT_CREATED = NÃO (Zero chamadas de criação duplicada)');
  const op = db._store.get(key);
  assert.equal(op.erro_codigo, 'AMBIGUOUS_CREATION_PASSWORD_UNAVAILABLE');
});

// ─── TESTE G: UNCERTAIN + CONTA AUSENTE (RETRY SEGURO) ───────────────────────
await test('TESTE G: Uncertain com conta ausente no lookup permite retry seguro de criação', async () => {
  const key = 'criacao_inicial:user1:disp1';
  const notesMarker = 'Central Cine | User: user1 | Dispositivo: disp1';

  const db = createMockSupabase({
    [key]: {
      idempotency_key: key,
      tipo: 'criacao_teste_inicial',
      identificador_fornecedor: 'disp1',
      usuario_acesso: '11999998888',
      request_hash: computeRequestHash('criacao_teste_inicial', 'disp1', '11999998888'),
      status: 'uncertain',
      lock_expires_at: null,
      resultado: null
    }
  });

  let generatetestCalls = 0;
  const mockCmsClient = {
    get: async () => ({ data: '<input name="_token" value="csrf123">' }),
    post: async (url) => {
      if (url === '/clients/generatetest') {
        generatetestCalls++;
        return {
          request: { res: { responseUrl: '/clients/generatetest' } },
          data: mockGenerateHtml('user_retry_ok', 'pass_ok')
        };
      }
      if (url === '/ajax/getClients') {
        if (generatetestCalls === 0) {
          return { data: { data: [] } };
        }
        return {
          data: {
            data: [{ user_id: '7788', raw_username: 'user_retry_ok', expire: '15/08/2026 23:59:59', max_cons: 1 }]
          }
        };
      }
    }
  };

  const result = await gerarAcesso({
    telefone: '11999998888',
    notes: notesMarker,
    idempotency_key: key,
    dispositivo_id: 'disp1'
  }, { cmsClient: mockCmsClient, db });

  assert.equal(result.success, true);
  assert.equal(result.cached, false);
  assert.equal(result.data.usuario, 'user_retry_ok');
  assert.equal(generatetestCalls, 1, 'Deve executar a criação após confirmação de ausência');
  const op = db._store.get(key);
  assert.equal(op.status, 'done');
});

// ─── TESTE H: REQUEST HASH MISMATCH ──────────────────────────────────────────
await test('TESTE H: Reuso de chave com payload diferente retorna 409 IDEMPOTENCY_KEY_REUSED com 0 I/O', async () => {
  const key = 'criacao_inicial:user1:disp1';
  const db = createMockSupabase({
    [key]: {
      idempotency_key: key,
      tipo: 'criacao_teste_inicial',
      identificador_fornecedor: 'disp1',
      usuario_acesso: '11999998888',
      request_hash: 'original_hash_123',
      status: 'reserved'
    }
  });

  let calls = 0;
  const mockCmsClient = {
    get: async () => { calls++; return {}; },
    post: async () => { calls++; return {}; }
  };

  await assert.rejects(
    async () => {
      await gerarAcesso({
        telefone: '11999998888',
        notes: 'Outro payload',
        request_hash: 'different_hash_456',
        idempotency_key: key,
        dispositivo_id: 'disp1'
      }, { cmsClient: mockCmsClient, db });
    },
    (err) => {
      assert.equal(err.message, 'IDEMPOTENCY_KEY_REUSED');
      assert.equal(err.status, 409);
      return true;
    }
  );

  assert.equal(calls, 0);
});

console.log(`\nResultados: ${passed} passados, ${failed} falhados.`);
if (failed > 0) {
  process.exit(1);
}
