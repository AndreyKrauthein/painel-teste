import logger from './safeLogger.js';
import { extractToken } from './parser.js';

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
  params.append('draw', '2');
  params.append('start', '0');
  params.append('length', '25');
  params.append('search[value]', username);
  params.append('search[regex]', 'false');
  params.append('order[0][column]', '0');
  params.append('order[0][dir]', 'desc');
  
  const columnKeys = ['id', 'username', 'status', 'expire', 'max_cons', 'active_cons', 'rest', 'action'];
  for (let i = 0; i < 8; i++) {
    const dataName = columnKeys[i] || '';
    params.append(`columns[${i}][data]`, dataName);
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
      
      const simpleResponse = await cmsClient.get('/clients/simpletest');
      const token = extractToken(simpleResponse.data);
      if (!token) {
        logger.warn('Aviso: Token CSRF não localizado antes de enviar a busca.');
      }

      const response = await cmsClient.post('/ajax/getClients', params.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRF-TOKEN': token || ''
        }
      });
      
      const json = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
      
      if (json && Array.isArray(json.data)) {
        const matches = json.data.filter(item => item && String(item.raw_username).trim() === String(username).trim());
        
        if (matches.length === 1) {
          clientResolved = matches[0];
          break;
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
    expires: clientResolved.expire || null,
    connections: Number(clientResolved.max_cons ?? 1)
  };
}

/**
 * Busca cliente no painel fornecedor através do marcador determinístico salvo no campo notes.
 * Usado pelo reconciliador e no recovery de estado uncertain para evitar criação de contas duplicadas.
 *
 * @param {string} notes O marcador canônico (ex: "Central Cine | User: <id> | Dispositivo: <id>")
 * @param {import('axios').AxiosInstance} cmsClient Cliente HTTP autenticado no painel.
 * @param {number} maxAttempts
 * @param {number} delayMs
 * @returns {Promise<{ user_id: number; username: string; expires: string|null; connections: number }|null>}
 */
export async function buscarClientePorNotes(notes, cmsClient, maxAttempts = 3, delayMs = 500) {
  if (!notes || typeof notes !== 'string' || !notes.trim()) {
    return null;
  }

  const cleanNotes = notes.trim();

  const params = new URLSearchParams();
  params.append('draw', '2');
  params.append('start', '0');
  params.append('length', '50');
  params.append('search[value]', cleanNotes);
  params.append('search[regex]', 'false');
  params.append('order[0][column]', '0');
  params.append('order[0][dir]', 'desc');
  
  const columnKeys = ['id', 'username', 'status', 'expire', 'max_cons', 'active_cons', 'rest', 'action', 'notes', 'reseller_notes'];
  for (let i = 0; i < columnKeys.length; i++) {
    const dataName = columnKeys[i] || '';
    params.append(`columns[${i}][data]`, dataName);
    params.append(`columns[${i}][name]`, '');
    params.append(`columns[${i}][searchable]`, 'true');
    params.append(`columns[${i}][orderable]`, 'true');
    params.append(`columns[${i}][search][value]`, '');
    params.append(`columns[${i}][search][regex]`, 'false');
  }

  let attempts = 0;
  while (attempts < maxAttempts) {
    try {
      logger.info(`[Lookup Notes] Buscando cliente por notes via getClients (Tentativa ${attempts + 1}/${maxAttempts})...`);
      
      const simpleResponse = await cmsClient.get('/clients/simpletest');
      const token = extractToken(simpleResponse.data);

      const response = await cmsClient.post('/ajax/getClients', params.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRF-TOKEN': token || ''
        }
      });
      
      const json = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
      if (json && Array.isArray(json.data)) {
        // Encontra o registro que contenha o marcador notes correspondente
        const match = json.data.find(item => {
          if (!item) return false;
          const itemNotes = String(item.notes || item.reseller_notes || item.action || '');
          return itemNotes.includes(cleanNotes) || (item.notes && item.notes.includes(cleanNotes));
        });

        if (match) {
          logger.info(`[Lookup Notes] Conta encontrada via notes no RBoys: user_id=${match.user_id}, username=${match.raw_username || match.username}`);
          return {
            user_id: Number(match.user_id),
            username: match.raw_username || match.username,
            expires: match.expire || null,
            connections: Number(match.max_cons ?? 1)
          };
        }
      }
    } catch (err) {
      logger.warn(`[Lookup Notes] Tentativa ${attempts + 1} falhou ao buscar por notes: ${err.message}`);
    }

    attempts++;
    if (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return null;
}
