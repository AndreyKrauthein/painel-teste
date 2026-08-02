import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

/**
 * Cliente Supabase com SUPABASE_SERVICE_ROLE_KEY.
 * Acesso exclusivo ao backend — nunca expor ao frontend.
 * Retorna null em NODE_ENV=test (testes injetam mock via parâmetro).
 */
function createSupabaseAdmin() {
  if (process.env.NODE_ENV === 'test') {
    return null;
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios no painel-teste. ' +
      'Configure no .env ou nas variáveis de ambiente do EasyPanel.'
    );
  }

  return createClient(url, key, {
    auth: { persistSession: false }
  });
}

export const supabaseAdmin = createSupabaseAdmin();
export default supabaseAdmin;
