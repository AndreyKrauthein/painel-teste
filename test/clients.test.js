import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { CookieJar } from 'tough-cookie';

// Configura o ambiente de teste antes de carregar o server.js
process.env.NODE_ENV = 'test';
process.env.API_SECRET = 'cc_integration_secret';
process.env.RATE_LIMIT_MAX = '1000';

// Constrói um CookieJar preenchido para gravação síncrona
const jar = new CookieJar();
jar.setCookieSync('mundogf_session=mocksession', 'https://cms.rboys02.click');
jar.setCookieSync('XSRF-TOKEN=mockxsrf', 'https://cms.rboys02.click');

// Grava uma sessão dummy no disco de forma síncrona para evitar travas de I/O assíncronas do OneDrive
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

// Carregamento dinâmico para respeitar a definição síncrona do process.env.NODE_ENV
const { resolverClienteFornecedor } = await import('../src/clients.js');
const { parseBrazilianDate } = await import('../src/parser.js');
const cmsClient = (await import('../src/cmsClient.js')).default;
const { fastify } = await import('../server.js');

async function runAllTests() {
  console.log('--- INICIANDO TESTES UNITÁRIOS E DE INTEGRAÇÃO DO PAINEL-TESTES ---');

  try {
    // =========================================================================
    // TESTES UNITÁRIOS
    // =========================================================================
    
    // 1. Resolução bem-sucedida
    console.log('[Teste 1] Validando resolução bem-sucedida...');
    const mockClient1 = {
      post: async () => ({
        data: {
          recordsFiltered: 1,
          data: [
            {
              user_id: 3583177,
              raw_username: '14054073',
              username: '14054073',
              expire: '02/08/2026 00:00:19'
            }
          ]
        }
      })
    };
    const r1 = await resolverClienteFornecedor('14054073', mockClient1, 1, 0);
    assert.strictEqual(r1.user_id, 3583177);
    assert.strictEqual(r1.expires, '02/08/2026 00:00:19');
    console.log('✓ Teste 1 passou.');

    // 2. Campo username contendo HTML & 3. Uso correto de raw_username
    console.log('[Teste 2] Validando username contendo HTML e comparação com raw_username...');
    const mockClient2 = {
      post: async () => ({
        data: {
          recordsFiltered: 1,
          data: [
            {
              user_id: 3583177,
              raw_username: '14054073',
              username: '<span class="label label-success">14054073</span>',
              expire: '02/08/2026 00:00:19'
            }
          ]
        }
      })
    };
    const r2 = await resolverClienteFornecedor('14054073', mockClient2, 1, 0);
    assert.strictEqual(r2.user_id, 3583177);
    assert.strictEqual(r2.expires, '02/08/2026 00:00:19');
    console.log('✓ Teste 2 passou.');

    // 4. Resultado vazio (nenhuma correspondência exata)
    console.log('[Teste 3] Validando comportamento de resultado vazio (SUPPLIER_CLIENT_NOT_FOUND)...');
    const mockClient3 = {
      post: async () => ({
        data: {
          recordsFiltered: 0,
          data: []
        }
      })
    };
    await assert.rejects(
      resolverClienteFornecedor('14054073', mockClient3, 1, 0),
      (err) => {
        assert.strictEqual(err.message, 'SUPPLIER_CLIENT_NOT_FOUND');
        return true;
      }
    );
    console.log('✓ Teste 3 passou.');

    // 5. Resultado ambíguo (mais de um resultado exato)
    console.log('[Teste 4] Validando comportamento de resultado ambíguo (SUPPLIER_CLIENT_AMBIGUOUS)...');
    const mockClient4 = {
      post: async () => ({
        data: {
          recordsFiltered: 2,
          data: [
            {
              user_id: 3583177,
              raw_username: '14054073',
              username: '14054073'
            },
            {
              user_id: 9999999,
              raw_username: '14054073',
              username: '14054073'
            }
          ]
        }
      })
    };
    await assert.rejects(
      resolverClienteFornecedor('14054073', mockClient4, 1, 0),
      (err) => {
        assert.strictEqual(err.message, 'SUPPLIER_CLIENT_AMBIGUOUS');
        return true;
      }
    );
    console.log('✓ Teste 4 passou.');

    // 6. Aparecimento do cliente após segunda tentativa (retry)
    console.log('[Teste 5] Validando propagação/retry na segunda tentativa...');
    let callCount = 0;
    const mockClient5 = {
      post: async () => {
        callCount++;
        if (callCount === 1) {
          return { data: { recordsFiltered: 0, data: [] } };
        }
        return {
          data: {
            recordsFiltered: 1,
            data: [
              {
                user_id: 3583177,
                raw_username: '14054073',
                username: '14054073',
                expire: '02/08/2026 00:00:19'
              }
            ]
          }
        };
      }
    };
    const r5 = await resolverClienteFornecedor('14054073', mockClient5, 3, 1);
    assert.strictEqual(callCount, 2);
    assert.strictEqual(r5.user_id, 3583177);
    console.log('✓ Teste 5 passou.');

    // 7. getClients indisponível
    console.log('[Teste 6] Validando getClients indisponível...');
    const mockClient6 = {
      post: async () => {
        throw new Error('500 Internal Server Error');
      }
    };
    await assert.rejects(
      resolverClienteFornecedor('14054073', mockClient6, 2, 1),
      (err) => {
        assert.match(err.message, /^GET_CLIENTS_FAILED:/);
        return true;
      }
    );
    console.log('✓ Teste 6 passou.');

    // 8. Parser de datas brasileiras
    console.log('[Teste 7] Validando parse de datas brasileiras (timezone -03:00)...');
    assert.strictEqual(parseBrazilianDate('02/08/2026 00:00:19'), '2026-08-02T03:00:19.000Z');
    assert.strictEqual(parseBrazilianDate('06/06/2026 09:30'), '2026-06-06T12:30:00.000Z');
    assert.strictEqual(parseBrazilianDate('31/07/2026'), '2026-07-31T03:00:00.000Z');
    assert.strictEqual(parseBrazilianDate('6 horas (Padrão)'), null);
    console.log('✓ Teste 7 passou.');

    // =========================================================================
    // TESTES DE INTEGRAÇÃO DO FLUXO COMPLETO VIA FASTIFY INJECT (MOCK IN-MEMORY)
    // =========================================================================

    // Salva referências originais do cmsClient para restauração posterior
    const originalGet = cmsClient.get;
    const originalPost = cmsClient.post;

    // ─────────────────────────────────────────────────────────────────────────
    // TESTE 8 — Geração concluída e resolução do ID falha
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[Teste 8] Executando: Geração concluída e resolução do ID falha...');
    
    let cmsPostCallCount = 0;
    let getClientsResponseData = []; // getClients retorna vazio para falha de resolucao

    cmsClient.get = async (url) => {
      if (url.includes('/clients/simpletest')) {
        return {
          data: '<form><input name="_token" value="test-token-csrf"/></form>',
          request: { res: { responseUrl: 'http://cms/clients/simpletest' } }
        };
      }
      throw new Error(`Chamada GET não mockada para: ${url}`);
    };

    cmsClient.post = async (url, data, options) => {
      if (url.includes('/clients/generatetest')) {
        cmsPostCallCount++;
        return {
          data: `
            <html>
              <body>
                Usuário: 14054073 <br>
                Senha: 32231861 <br>
                Vencimento: 02/08/2026 00:00:19 <br>
                Link Lista: http://test.server/get.php?username=14054073&password=32231861
              </body>
            </html>
          `,
          request: { res: { responseUrl: 'http://cms/clients/generatetest' } }
        };
      }
      if (url.includes('/ajax/getClients')) {
        return {
          data: {
            recordsFiltered: getClientsResponseData.length,
            data: getClientsResponseData
          }
        };
      }
      throw new Error(`Chamada POST não mockada para: ${url}`);
    };

    const response8 = await fastify.inject({
      method: 'POST',
      url: '/gerar-teste',
      headers: {
        'authorization': 'Bearer cc_integration_secret',
        'content-type': 'application/json'
      },
      payload: {
        telefone: '5511999999999',
        notes: 'CC Teste'
      }
    });

    const body8 = JSON.parse(response8.body);

    // Validações
    assert.strictEqual(response8.statusCode, 200);
    assert.strictEqual(body8.success, true);
    
    const data8 = body8.data;
    assert.strictEqual(data8.usuario, '14054073');
    assert.strictEqual(data8.senha, '32231861');
    assert.strictEqual(data8.vencimento, '02/08/2026 00:00:19');
    assert.strictEqual(data8.identificador_fornecedor, null);
    assert.strictEqual(data8.reconciliacao_requerida, true);
    assert.strictEqual(data8.reconciliacao_erro, 'SUPPLIER_CLIENT_NOT_FOUND');

    // Confirmar que generatetest foi chamado exatamente uma vez (sem nova geração na falha)
    assert.strictEqual(cmsPostCallCount, 1);
    console.log('✓ Teste 8 passou.');

    // ─────────────────────────────────────────────────────────────────────────
    // TESTE 9 — Divergência de vencimento (conferência)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[Teste 9] Executando: Divergência de vencimento...');
    
    cmsPostCallCount = 0;
    // Simular getClients retornando expires diferente além da tolerância (ex: 03/08/2026)
    getClientsResponseData = [
      {
        user_id: 3583177,
        raw_username: '14054073',
        username: '14054073',
        expire: '03/08/2026 12:00:00'
      }
    ];

    // Capturar logs do console para validar o warning sanitizado
    let warningLogged = false;
    const originalConsoleWarn = console.warn;
    console.warn = (...args) => {
      const msg = args.join(' ');
      if (msg.includes('Divergência detectada entre generatetest') && msg.includes('02/08/2026') && msg.includes('03/08/2026')) {
        warningLogged = true;
      }
      originalConsoleWarn(...args);
    };

    const response9 = await fastify.inject({
      method: 'POST',
      url: '/gerar-teste',
      headers: {
        'authorization': 'Bearer cc_integration_secret',
        'content-type': 'application/json'
      },
      payload: {
        telefone: '5511999999999',
        notes: 'CC Teste'
      }
    });

    const body9 = JSON.parse(response9.body);
    
    // Restaurar console.warn
    console.warn = originalConsoleWarn;

    // Validações
    assert.strictEqual(response9.statusCode, 200);
    assert.strictEqual(body9.success, true);
    
    const data9 = body9.data;
    assert.strictEqual(data9.usuario, '14054073');
    // Confirmar que o vencimento devolvido por /gerar-teste continua sendo o A do generatetest
    assert.strictEqual(data9.vencimento, '02/08/2026 00:00:19');
    assert.strictEqual(data9.identificador_fornecedor, 3583177);
    assert.strictEqual(data9.reconciliacao_requerida, undefined);
    // Confirmar que o warning sanitizado foi registrado
    assert.strictEqual(warningLogged, true);
    console.log('✓ Teste 9 passou.');

    // Restaura referências do cmsClient
    cmsClient.get = originalGet;
    cmsClient.post = originalPost;

    console.log('\n--- TODOS OS TESTES (UNITÁRIOS E INTEGRAÇÃO IN-MEMORY) PASSARAM COM SUCESSO ---');
    process.exit(0);

  } catch (error) {
    console.error('Falha nos testes:', error);
    process.exit(1);
  }
}

runAllTests();
