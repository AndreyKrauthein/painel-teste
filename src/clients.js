import logger from './safeLogger.js';

/**
 * Busca e resolve deterministicamente o ID interno do cliente no painel fornecedor.
 * Realiza tentativas com intervalo caso o cliente não apareça imediatamente.
 * 
 * @param {string} username O nome de usuário do acesso técnico gerado.
 * @param {import('axios').AxiosInstance} cmsClient Cliente HTTP autenticado no painel.
 * @param {number} maxAttempts Número máximo de tentativas.
 * @param {number} delayMs Tempo de espera entre as tentativas.
 * @returns {Promise<{ user_id: number; expires: string|null }>}
 */
export async function resolverClienteFornecedor(username, cmsClient, maxAttempts = 4, delayMs = 1000) {
  if (!username) {
    throw new Error('SUPPLIER_CLIENT_NOT_FOUND');
  }

  const params = new URLSearchParams();
  params.append('draw', '1');
  params.append('start', '0');
  params.append('length', '10');
  params.append('search[value]', username);
  params.append('search[regex]', 'false');
  params.append('order[0][column]', '0');
  params.append('order[0][dir]', 'desc');
  
  // Envia colunas mínimas exigidas pelo contrato do DataTables
  for (let i = 0; i < 5; i++) {
    params.append(`columns[${i}][data]`, i === 0 ? 'id' : (i === 1 ? 'username' : 'status'));
    params.append(`columns[${i}][name]`, '');
    params.append(`columns[${i}][searchable]`, 'true');
    params.append(`columns[${i}][orderable]`, 'true');
    params.append(`columns[${i}][search][value]`, '');
    params.append(`columns[${i}][search][regex]`, 'false');
  }

  let attempts = 0;
  let clientResolved = null;
  let lastError = null;

  while (attempts < maxAttempts) {
    try {
      logger.info(`Buscando cliente '${username}' via getClients. Tentativa ${attempts + 1}/${maxAttempts}...`);
      const response = await cmsClient.get(`/clients/getclients?${params.toString()}`);
      
      const json = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
      if (json && Array.isArray(json.data)) {
        // Filtrar correspondência exata por raw_username para evitar falsos positivos
        // Não usar o campo 'username' para comparação, pois ele pode conter tags HTML.
        const matches = json.data.filter(item => item && item.raw_username === username);
        
        if (matches.length === 1) {
          clientResolved = matches[0];
          break; // Sucesso na resolução exata, sair do loop
        } else if (matches.length > 1) {
          throw new Error('SUPPLIER_CLIENT_AMBIGUOUS');
        } else {
          throw new Error('SUPPLIER_CLIENT_NOT_FOUND');
        }
      } else {
        throw new Error('Formato de resposta getClients inválido.');
      }
    } catch (err) {
      lastError = err;
      logger.warn(`Tentativa ${attempts + 1} falhou ao buscar cliente '${username}': ${err.message}`);
    }

    attempts++;
    if (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  if (!clientResolved) {
    if (lastError && (lastError.message === 'SUPPLIER_CLIENT_AMBIGUOUS' || lastError.message === 'SUPPLIER_CLIENT_NOT_FOUND')) {
      throw lastError;
    }
    const errorMsg = lastError ? lastError.message : 'Erro desconhecido ao obter getClients';
    throw new Error(`GET_CLIENTS_FAILED: ${errorMsg}`);
  }

  if (!clientResolved.user_id) {
    throw new Error('SUPPLIER_CLIENT_NOT_FOUND');
  }

  logger.info(`Cliente '${username}' resolvido com sucesso: user_id = ${clientResolved.user_id}`);
  return {
    user_id: Number(clientResolved.user_id),
    expires: clientResolved.expires || null
  };
}
