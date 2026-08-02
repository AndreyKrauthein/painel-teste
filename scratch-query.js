import cmsClient from './src/cmsClient.js';

async function testRoute(route) {
  try {
    console.log(`Testando rota: ${route}...`);
    const params = new URLSearchParams();
    params.append('draw', '1');
    params.append('start', '0');
    params.append('length', '10');
    params.append('search[value]', '54160049');
    params.append('search[regex]', 'false');
    params.append('order[0][column]', '0');
    params.append('order[0][dir]', 'desc');
    for (let i = 0; i < 5; i++) {
      params.append(`columns[${i}][data]`, i === 0 ? 'id' : (i === 1 ? 'username' : 'status'));
      params.append(`columns[${i}][name]`, '');
      params.append(`columns[${i}][searchable]`, 'true');
      params.append(`columns[${i}][orderable]`, 'true');
      params.append(`columns[${i}][search][value]`, '');
      params.append(`columns[${i}][search][regex]`, 'false');
    }

    const response = await cmsClient.get(`${route}?${params.toString()}`);
    console.log(`[SUCESSO] Rota ${route} retornou status ${response.status}`);
    console.log('JSON:', JSON.stringify(response.data).substring(0, 500));
  } catch (err) {
    console.error(`[ERRO] Rota ${route}:`, err.response ? `${err.response.status} - ${JSON.stringify(err.response.data)}` : err.message);
  }
}

async function run() {
  await testRoute('/clients/getClients');
  await testRoute('/clients/getclients');
}

run();
