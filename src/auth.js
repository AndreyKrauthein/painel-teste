import logger from './safeLogger.js';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Fastify preHandler hook to validate Authorization Bearer token matching API_SECRET.
 * @param {import('fastify').FastifyRequest} request 
 * @param {import('fastify').FastifyReply} reply 
 */
export async function checkAuth(request, reply) {
  const secret = process.env.API_SECRET;
  
  if (!secret || secret === 'troque_essa_chave') {
    logger.error('Erro de configuração: API_SECRET não está definida ou não foi alterada.');
    return reply.status(500).send({
      success: false,
      error: 'Erro de configuração no servidor. Configure a API_SECRET de forma segura.',
      action: 'configure_api_secret'
    });
  }

  const authHeader = request.headers.authorization;
  
  if (!authHeader) {
    logger.warn(`Tentativa de acesso não autorizada a ${request.url} - Cabeçalho Authorization ausente.`);
    return reply.status(401).send({
      success: false,
      error: 'Acesso não autorizado. Cabeçalho Authorization ausente.',
      action: 'auth_required'
    });
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    logger.warn(`Tentativa de acesso com cabeçalho mal formatado a ${request.url}.`);
    return reply.status(401).send({
      success: false,
      error: 'Formato do cabeçalho inválido. Utilize "Bearer <token>".',
      action: 'auth_invalid_format'
    });
  }

  const token = parts[1];
  if (token !== secret) {
    logger.warn(`Tentativa de acesso com token inválido a ${request.url}.`);
    return reply.status(401).send({
      success: false,
      error: 'Token de autorização inválido.',
      action: 'auth_invalid_token'
    });
  }
}
export default checkAuth;
