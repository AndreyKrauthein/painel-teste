import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import { loadSession, saveSessionFromJar } from './sessionStore.js';
import logger from './safeLogger.js';
import dotenv from 'dotenv';

dotenv.config();

const baseClient = axios.create({
  baseURL: process.env.CMS_BASE_URL || 'https://cms.rboys02.click',
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'Connection': 'keep-alive',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache'
  },
  withCredentials: true,
  maxRedirects: 5
});

// Apply tough-cookie support
const cmsClient = wrapper(baseClient);

// Interceptor to inject cookies from store before each request
cmsClient.interceptors.request.use(
  async (config) => {
    const session = await loadSession();
    if (session && session.jar) {
      config.jar = session.jar;
      logger.debug('Cookies carregados da sessão e injetados na requisição.');
    } else {
      config.jar = new CookieJar();
      logger.debug('Nenhuma sessão anterior encontrada. Iniciando CookieJar limpo.');
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Interceptor to save cookies automatically after each response
cmsClient.interceptors.response.use(
  async (response) => {
    if (response.config.jar) {
      await saveSessionFromJar(response.config.jar);
    }
    return response;
  },
  async (error) => {
    // Even on error responses, we want to save cookies if updated (e.g. 419 expired tokens, redirects, etc.)
    if (error.config && error.config.jar) {
      await saveSessionFromJar(error.config.jar);
    }
    return Promise.reject(error);
  }
);

export default cmsClient;
