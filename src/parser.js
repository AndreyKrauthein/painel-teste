import * as cheerio from 'cheerio';
import logger from './safeLogger.js';

/**
 * Extracts the CSRF token (_token) from the HTML of /clients/simpletest
 * @param {string} html 
 * @returns {string|null}
 */
export function extractToken(html) {
  if (!html) return null;
  try {
    const $ = cheerio.load(html);
    const token = $('input[name="_token"]').val();
    return token ? token.trim() : null;
  } catch (error) {
    logger.error('Erro ao extrair token do HTML:', error);
    return null;
  }
}

/**
 * Extracts user, password, server url, expiration date and playlist links from generator response HTML
 * @param {string} html 
 * @returns {object}
 */
export function extractTestData(html) {
  if (!html) {
    throw new Error('HTML recebido para parse está vazio.');
  }

  const $ = cheerio.load(html);
  
  const result = {
    usuario: '',
    senha: '',
    url: '',
    codigo: 'RBOYS',
    vencimento: '',
    link_lista: '',
    link_padrao: '',
    link_ssiptv: '',
    epg: ''
  };

  const urls = [];

  // 1. Scan for URLs in hrefs
  $('a').each((_, el) => {
    const href = $(el).attr('href');
    if (href && href.startsWith('http')) {
      urls.push(href.trim());
    }
  });

  // 2. Scan for URLs in inputs/textareas
  $('input, textarea').each((_, el) => {
    const val = $(el).val();
    if (val && val.startsWith('http')) {
      urls.push(val.trim());
    }
  });

  // 3. Scan for URLs using regex in visible text to catch any unlinked URL strings
  const urlRegex = /https?:\/\/[^\s"'`<>]+/g;
  const bodyText = $('body').text() || html;
  let match;
  while ((match = urlRegex.exec(bodyText)) !== null) {
    urls.push(match[0].trim());
  }

  // Deduplicate URLs
  const uniqueUrls = [...new Set(urls)];

  // Identify specific playlists
  // m3u standard playlists usually contain 'get.php', '.m3u', or format parameters
  const m3uUrl = uniqueUrls.find(u => 
    u.includes('get.php') || 
    u.includes('output=ts') || 
    u.includes('output=m3u8') || 
    u.includes('.m3u')
  );

  if (m3uUrl) {
    result.link_lista = m3uUrl;
    result.link_padrao = m3uUrl;
    
    // Parse credentials from the URL if possible
    try {
      const parsed = new URL(m3uUrl);
      result.url = `${parsed.protocol}//${parsed.host}`;
      result.usuario = parsed.searchParams.get('username') || parsed.searchParams.get('user') || '';
      result.senha = parsed.searchParams.get('password') || parsed.searchParams.get('pass') || '';
    } catch (err) {
      logger.warn('Falha ao obter credenciais da URL do teste:', err.message);
    }
  }

  // SSIPTV
  const ssiptvUrl = uniqueUrls.find(u => u.includes('ssiptv') || u.includes('siptv'));
  if (ssiptvUrl) {
    result.link_ssiptv = ssiptvUrl;
  }

  // EPG
  const epgUrl = uniqueUrls.find(u => u.includes('xmltv') || u.includes('epg') || u.includes('.xml'));
  if (epgUrl) {
    result.epg = epgUrl;
  }

  // Fallbacks for credentials (if not found in URL query parameters)
  if (!result.usuario) {
    const userMatch = bodyText.match(/(?:Usuário|Usuario|User|Login):\s*([a-zA-Z0-9_-]+)/i);
    if (userMatch) result.usuario = userMatch[1].trim();
  }

  if (!result.senha) {
    const passMatch = bodyText.match(/(?:Senha|Password|Pass):\s*([a-zA-Z0-9_-]+)/i);
    if (passMatch) result.senha = passMatch[1].trim();
  }

  if (!result.url) {
    // If we have a fallback URL in the list but couldn't parse host, search for a clean host
    const anyHttp = uniqueUrls.find(u => !u.includes('xmltv') && !u.includes('epg'));
    if (anyHttp) {
      try {
        const parsed = new URL(anyHttp);
        result.url = `${parsed.protocol}//${parsed.host}`;
      } catch {
        // ignore
      }
    }
  }

  // Extract expiration date (vencimento)
  // Look for patterns like "DD/MM/AAAA HH:MM" or "DD/MM/AAAA"
  const vencMatch = bodyText.match(/(?:Vencimento|Expira|Vence|Validade|Expires|Vence em):\s*(\d{2}\/\d{2}\/\d{4}(?:\s+\d{2}:\d{2}(?::\d{2})?)?)/i)
    || bodyText.match(/(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}(?::\d{2})?)/)
    || bodyText.match(/(\d{2}\/\d{2}\/\d{4})/);

  if (vencMatch) {
    result.vencimento = vencMatch[1].trim();
  } else {
    // If date is not found, default to duration or status
    result.vencimento = '6 horas (Padrão)';
  }

  // Generate standard EPG / SSIPTV if missing but credentials exist
  if (!result.epg && result.url && result.usuario && result.senha) {
    result.epg = `${result.url}/xmltv.php?username=${result.usuario}&password=${result.senha}`;
  }
  if (!result.link_ssiptv && result.link_lista) {
    result.link_ssiptv = result.link_lista;
  }

  // Normalize url field by removing the port (only from the main url field)
  if (result.url) {
    try {
      const parsedUrl = new URL(result.url);
      result.url = `${parsedUrl.protocol}//${parsedUrl.hostname}`;
    } catch {
      // Fallback regex replacement
      result.url = result.url.replace(/:\d+$/, '');
    }
  }

  return result;
}

/**
 * Realiza o parse explícito de uma data no formato brasileiro (DD/MM/YYYY HH:mm:ss ou DD/MM/YYYY HH:mm)
 * considerando o timezone oficial do painel (América/São Paulo: UTC-3).
 * 
 * @param {string} dateStr A data em formato brasileiro.
 * @returns {string|null} A data convertida no formato ISO (UTC).
 */
export function parseBrazilianDate(dateStr) {
  if (!dateStr) return null;
  const cleaned = dateStr.trim();
  const parts = cleaned.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!parts) return null;
  
  const day = parseInt(parts[1], 10);
  const month = parseInt(parts[2], 10) - 1; // Mês 0-indexed no JS
  const year = parseInt(parts[3], 10);
  const hour = parts[4] ? parseInt(parts[4], 10) : 0;
  const minute = parts[5] ? parseInt(parts[5], 10) : 0;
  const second = parts[6] ? parseInt(parts[6], 10) : 0;
  
  // Construção explícita considerando timezone oficial UTC-3
  const pad = (n) => String(n).padStart(2, '0');
  const isoStr = `${year}-${pad(month + 1)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}-03:00`;
  const date = new Date(isoStr);
  if (isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * Realiza o parse de uma data brasileira e retorna um objeto Date.
 *
 * Diferença de parseBrazilianDate: retorna Date em vez de string ISO.
 * Usado internamente pelo extender para comparações de datas.
 *
 * "05/08/2026 23:55:00" → new Date("2026-08-05T23:55:00-03:00")
 *                       → .toISOString() = "2026-08-06T02:55:00.000Z"
 *
 * @param {string} dateStr Data no formato DD/MM/YYYY HH:mm[:ss]
 * @returns {Date|null}
 */
export function parseBrazilianDateToLocal(dateStr) {
  if (!dateStr) return null;
  const cleaned = dateStr.trim();
  const sanitized = cleaned.replace(/\s+[A-Z]{3,4}$/i, '').trim();
  const parts = sanitized.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!parts) return null;

  const day    = parseInt(parts[1], 10);
  const month  = parseInt(parts[2], 10) - 1;
  const year   = parseInt(parts[3], 10);
  const hour   = parts[4] ? parseInt(parts[4], 10) : 0;
  const minute = parts[5] ? parseInt(parts[5], 10) : 0;
  const second = parts[6] ? parseInt(parts[6], 10) : 0;

  const pad = (n) => String(n).padStart(2, '0');
  const isoStr = `${year}-${pad(month + 1)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}-03:00`;
  const date = new Date(isoStr);
  if (isNaN(date.getTime())) return null;
  return date;
}

/**
 * Verifica se o status do cliente retornado pelo fornecedor é operacional.
 * Aceita enabled, active, ativo, habilitado de forma case-insensitive.
 *
 * @param {string} status
 * @returns {boolean}
 */
export function isSupplierStatusOperational(status) {
  const s = String(status || '').toLowerCase().trim();
  return ['enabled', 'active', 'ativo', 'habilitado'].includes(s);
}

/**
 * Calcula a data-alvo de extensão (+3 dias corridos em America/Sao_Paulo).
 *
 * Regras:
 * - base = max(agora, vencimentoAtual)
 * - customDate = data civil de (base + 3 dias) em America/Sao_Paulo
 *
 * IMPLEMENTAÇÃO CIVIL (não usa ms):
 * 1. Obter "YYYY-MM-DD" de base em BRT via Intl.DateTimeFormat('sv-SE').
 * 2. Parsear como (y, m, d) — data civil pura.
 * 3. Date.UTC(y, m-1, d+3) é aritmética civil (JS normaliza overflow de mês/ano).
 * 4. Ler de volta com getUTC* — sem conversão de timezone.
 *    Isso evita o problema de UTC-midnight formatar como dia anterior em BRT.
 *
 * Exemplos:
 *   "02/08/2026 ..." → BRT civil "2026-08-02" → +3 → "2026-08-05" ✓
 *   "29/08/2026 ..." → BRT civil "2026-08-29" → +3 → "2026-09-01" ✓ (virada de mês)
 *   "30/12/2026 ..." → BRT civil "2026-12-30" → +3 → "2027-01-02" ✓ (virada de ano)
 *   "05/08/2026 23:55:00 BRT" → ISO = 2026-08-06T02:55:00Z (regressão de timezone)
 *
 * @param {string|null} vencimentoAtualStr Data no formato brasileiro ou null
 * @returns {{ base: Date, novaData: Date, customDate: string }}
 */
export function calcularDataExtensao(vencimentoAtualStr, dias = 3) {
  const agora = new Date();
  const diasParam = Number.isInteger(Number(dias)) && Number(dias) > 0 ? Number(dias) : 3;

  let base = agora;
  if (vencimentoAtualStr) {
    const vencimento = parseBrazilianDateToLocal(vencimentoAtualStr);
    if (vencimento && vencimento > agora) {
      base = vencimento;
    }
  }

  // 1. Obter a data civil de 'base' em America/Sao_Paulo como "YYYY-MM-DD"
  const brtDateStr = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Sao_Paulo'
  }).format(base);
  // Ex: "2026-08-05" — a data que o usuário vê no relógio de parede em BRT

  // 2. Parsear como data civil
  const [y, m, d] = brtDateStr.split('-').map(Number);

  // 3. +N dias como aritmética civil usando Date.UTC como contenedor numérico.
  //    JS normaliza overflow: Date.UTC(2026, 7, 32) → 2026-09-01T00:00:00Z
  const civil = new Date(Date.UTC(y, m - 1, d + diasParam));

  // 4. Ler de volta com getUTC* para evitar conversão de timezone.
  //    Se usarmos Intl.format(civil) em BRT, UTC midnight → dia anterior em BRT.
  const yy = civil.getUTCFullYear();
  const mm = String(civil.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(civil.getUTCDate()).padStart(2, '0');
  const customDate = `${yy}-${mm}-${dd}`;

  // novaData = customDate às 23:55:00 BRT (horário normalizado pelo fornecedor)
  const novaData = new Date(`${customDate}T23:55:00-03:00`);

  return { base, novaData, customDate };
}

/**
 * Calcula a data-alvo de extensão de mensalidade nativa Rboys (+1 mês civil em America/Sao_Paulo).
 *
 * Regras:
 * - base = max(agora, vencimentoAtual)
 * - Adiciona 1 mês civil com overflow de calendário nativo do Rboys.
 *
 * Exemplos:
 *   10/08/2026 -> 10/09/2026
 *   10/09/2026 -> 10/10/2026
 *   31/08/2026 -> 01/10/2026 (overflow de setembro com 30 dias -> 01 de outubro)
 *   Expirado 05/08, renovado 10/08 -> base = 10/08 -> 10/09/2026
 *
 * @param {string|null} vencimentoAtualStr Data no formato brasileiro ou null
 * @returns {{ base: Date, novaData: Date, customDate: string }}
 */
export function calcularDataAlvoMensalidade(vencimentoAtualStr) {
  const agora = new Date();

  let base = agora;
  if (vencimentoAtualStr) {
    const vencimento = parseBrazilianDateToLocal(vencimentoAtualStr);
    if (vencimento && vencimento > agora) {
      base = vencimento;
    }
  }

  // 1. Obter a data civil de 'base' em America/Sao_Paulo como "YYYY-MM-DD"
  const brtDateStr = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Sao_Paulo'
  }).format(base);

  // 2. Parsear como data civil
  const [y, m, d] = brtDateStr.split('-').map(Number);

  // 3. +1 mês como aritmética civil usando Date.UTC.
  // JS normaliza overflow de mês automaticamente:
  // Date.UTC(2026, 7+1, 31) -> mês 8 (setembro), dia 31 vira 01 de outubro (2026-10-01)
  const civil = new Date(Date.UTC(y, m, d));

  const yy = civil.getUTCFullYear();
  const mm = String(civil.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(civil.getUTCDate()).padStart(2, '0');
  const customDate = `${yy}-${mm}-${dd}`;

  const novaData = new Date(`${customDate}T23:55:00-03:00`);

  return { base, novaData, customDate };
}

