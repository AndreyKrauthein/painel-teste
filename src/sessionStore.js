import fs from 'fs/promises';
import path from 'path';
import { CookieJar, Cookie } from 'tough-cookie';
import logger from './safeLogger.js';

const SESSION_FILE_PATH = path.resolve('data/session.json');
const STATUS_FILE_PATH = path.resolve('data/session-status.json');

/**
 * Helper to ensure data directory exists
 */
async function ensureDir() {
  await fs.mkdir(path.dirname(SESSION_FILE_PATH), { recursive: true });
}

/**
 * Save cookie string to session.json, also creating/updating a tough-cookie CookieJar
 * @param {string} cookieString
 */
export async function saveSession(cookieString) {
  try {
    await ensureDir();

    // Create a new CookieJar and populate it from the cookieString
    const jar = new CookieJar();
    const domain = 'cms.rboys02.click';
    const secureDomain = `https://${domain}`;

    // Split and parse individual cookies
    const parts = cookieString.split(';');
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      
      // A cookie part is usually Name=Value. Let's make sure it contains '='
      if (trimmed.includes('=')) {
        try {
          const cookie = Cookie.parse(trimmed);
          if (cookie) {
            // Set domain and path if they are not present
            if (!cookie.domain) cookie.domain = domain;
            if (!cookie.path) cookie.path = '/';
            await jar.setCookie(cookie, secureDomain);
          }
        } catch (err) {
          logger.warn(`Falha ao fazer parse do cookie part: "${trimmed}"`, err);
        }
      }
    }

    const serializedJar = jar.toJSON();
    const sessionData = {
      cookieString,
      jar: serializedJar,
      updatedAt: new Date().toISOString()
    };

    await fs.writeFile(SESSION_FILE_PATH, JSON.stringify(sessionData, null, 2), 'utf-8');
    logger.info('Sessão persistida com sucesso em data/session.json.');
  } catch (error) {
    logger.error('Erro ao salvar sessão:', error);
    throw error;
  }
}

/**
 * Update session file using an existing CookieJar instance (after CMS Set-Cookie)
 * @param {CookieJar} jar
 */
export async function saveSessionFromJar(jar) {
  try {
    await ensureDir();
    
    const serializedJar = jar.toJSON();
    
    // Retrieve cookies for our domain to reconstruct the cookieString
    const cookies = await jar.getCookies('https://cms.rboys02.click');
    const cookieString = cookies.map(c => c.toString()).join('; ');

    const sessionData = {
      cookieString,
      jar: serializedJar,
      updatedAt: new Date().toISOString()
    };

    await fs.writeFile(SESSION_FILE_PATH, JSON.stringify(sessionData, null, 2), 'utf-8');
    logger.info('Sessão atualizada a partir do CookieJar e salva em data/session.json.');
  } catch (error) {
    logger.error('Erro ao salvar sessão a partir do CookieJar:', error);
  }
}

/**
 * Load session from session.json and return a populated CookieJar and cookieString
 * @returns {Promise<{ jar: CookieJar, cookieString: string }|null>}
 */
export async function loadSession() {
  try {
    const data = await fs.readFile(SESSION_FILE_PATH, 'utf-8');
    const parsed = JSON.parse(data);
    
    if (!parsed || !parsed.jar) {
      return null;
    }

    const jar = CookieJar.fromJSON(parsed.jar);
    return {
      jar,
      cookieString: parsed.cookieString || ''
    };
  } catch (error) {
    // File not found or corrupt is fine, return null
    if (error.code !== 'ENOENT') {
      logger.error('Erro ao carregar sessão:', error);
    }
    return null;
  }
}

/**
 * Save status.json
 * @param {boolean} active
 * @param {string} message
 * @param {string} [lastNotified]
 */
export async function updateStatus(active, message = '', lastNotified = undefined) {
  try {
    await ensureDir();
    
    // Load existing status to preserve other properties if not passed
    let current = {};
    try {
      const data = await fs.readFile(STATUS_FILE_PATH, 'utf-8');
      current = JSON.parse(data);
    } catch {
      // ignore
    }

    const now = new Date().toISOString();
    const statusObj = {
      success: true,
      ativa: active,
      message: message || (active ? 'Sessão ativa' : 'Sessão expirada'),
      lastChecked: now,
      lastSuccess: active ? now : current.lastSuccess || null,
      lastError: !active ? now : current.lastError || null,
      lastNotified: lastNotified !== undefined ? lastNotified : current.lastNotified || null
    };

    await fs.writeFile(STATUS_FILE_PATH, JSON.stringify(statusObj, null, 2), 'utf-8');
    logger.info(`Status da sessão atualizado: ativa = ${active}`);
  } catch (error) {
    logger.error('Erro ao atualizar status da sessão:', error);
  }
}

/**
 * Get status.json
 * @returns {Promise<{ success: boolean, ativa: boolean, message: string, lastChecked?: string, lastNotified?: string|null }>}
 */
export async function getStatus() {
  try {
    const data = await fs.readFile(STATUS_FILE_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    return {
      success: true,
      ativa: false,
      message: 'Sessão expirada'
    };
  }
}
