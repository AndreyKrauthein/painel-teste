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
    codigo: 'RBOYS2',
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

  return result;
}
