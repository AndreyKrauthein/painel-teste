import cmsClient from './src/cmsClient.js';
import { extractToken } from './src/parser.js';

async function foto() {
  try {
    const resTest = await cmsClient.get('/clients/simpletest');
    const token = extractToken(resTest.data);
    console.log('CSRF Token:', token ? 'OK' : 'MISSING');

    const params = new URLSearchParams();
    params.append('draw', '2');
    params.append('start', '0');
    params.append('length', '25');
    params.append('search[value]', '75613711');
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

    const res = await cmsClient.post('/ajax/getClients', params.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRF-TOKEN': token
      }
    });

    console.log('GETClients response status:', res.status);
    console.log('First 200 chars of response:', String(res.data).slice(0, 200));

    const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    if (data.data && data.data[0]) {
      const c = data.data[0];
      console.log('\n--- FOTOGRAFIA ANTES: HOMOLOGAÇÃO +3 (75613711 / 3613757) ---');
      console.log('user_id:', c.user_id);
      console.log('raw_username:', c.raw_username);
      console.log('expire (vencimento bruto):', c.expire);
      console.log('max_cons (connections):', c.max_cons);
      console.log('status:', c.status);
    }
  } catch (err) {
    console.error('Erro na fotografia:', err.message);
  }
}

foto();
